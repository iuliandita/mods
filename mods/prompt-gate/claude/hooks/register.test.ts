import type { CommandRunInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The real plugin, loaded by the kit: the test's `$` raises prompt.submit with the origin it names.
const prompt = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const command = (args: string): CommandRunInput => ({ command: 'prompt-gate', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

test('register bounces a vague prompt, and a hook that throws lets the prompt through', { options: { mode: 'on' } }, async ($, on) => {
  mock.store(on)
  mock.env(on, {})
  let broken = false
  let calls = 0
  // A clock reading the gate's arithmetic cannot use makes the hook throw (at the bounce expiry, before any model call).
  on('clock.now', () => ({ value: broken ? 5n : 1000 }) as never)
  on('model.complete', () => {
    calls++
    return { value: { isAnswered: true, text: '{"verdict":"vague","ask":"Which file?"}', usage: { input_tokens: 1, output_tokens: 1 } } } as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  expect(await $.prompt.submit(prompt('make the whole thing better somehow'))).toEqual({ drop: 'prompt-gate: Which file? Send it again unchanged to run it anyway.' })
  broken = true
  expect(await $.prompt.submit(prompt('make the other thing better somehow'))).toEqual({ text: 'make the other thing better somehow' })
  expect(calls).toBe(1)
})

test('register answers /prompt-gate with the summary, the last records, a clear and the usage', async ($, on) => {
  const rec = { t: 0, hash: 'h1', len: 30, verdict: 'vague', ms: 40, input: 10, output: 5, mode: 'on', bounced: true }
  mock.store(on, { log: [rec] })
  expect((await $.command.run(command(''))).text).toContain('records: 1 (clear 0, vague 1, error 0)')
  expect((await $.command.run(command('last'))).text).toContain('h1 len 30 vague bounced')
  expect((await $.command.run(command('bogus'))).text).toBe('prompt-gate: usage is /prompt-gate, /prompt-gate last or /prompt-gate clear.')
  expect((await $.command.run(command('clear'))).text).toBe('prompt-gate: log cleared.')
  expect((await $.command.run(command('last'))).text).toBe('prompt-gate: no records.')
})

test('prompt-gate shows the Jev notice once per install', { options: { mode: 'on' } }, async ($, on) => {
  const kept: Record<string, unknown> = {}
  on('store.get', (_$, e) => ({ value: kept[e.key] }))
  on('store.set', (_$, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  mock.env(on, { TYPESAFE_API_KEY: 'sk-test' })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', () => {
    throw new Error('offline')
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"verdict":"clear","ask":""}', usage: { input_tokens: 1, output_tokens: 1 } } }) as never)
  expect((await $.prompt.submit(prompt('make the whole thing better somehow'))).text).toBeDefined()
  expect((await $.prompt.submit(prompt('make the other thing better somehow'))).text).toBeDefined()
  expect(toasts).toEqual(['prompt-gate: prompts are sent to api.typesafe.ai (Jev) from every directory. Restrict with the jevPaths option, or set classifier=haiku. See the README Privacy section.'])
  expect(kept.jevNotice).toBe(true)
})

test('prompt-gate shows no Jev notice when the store remembers it', { options: { mode: 'on' } }, async ($, on) => {
  mock.store(on, { jevNotice: true })
  mock.env(on, { TYPESAFE_API_KEY: 'sk-test' })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', () => {
    throw new Error('offline')
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"verdict":"clear","ask":""}', usage: { input_tokens: 1, output_tokens: 1 } } }) as never)
  await $.prompt.submit(prompt('make the whole thing better somehow'))
  expect(toasts).toEqual([])
})
