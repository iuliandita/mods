import type { CommandRunInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The real plugin, loaded by the kit: the test's `$` raises prompt.submit with the origin it names.
const LISTING = '- commit: Write a commit message\n- review: Review a diff\n- deploy: Ship it'
const prompt = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const command = (args: string): CommandRunInput => ({ command: 'skill-pick', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

test('register adds the picks as context, and a hook that throws lets the prompt through unchanged', { options: { mode: 'on' } }, async ($, on) => {
  mock.store(on)
  mock.env(on, {})
  let broken = false
  // A clock reading the picker's arithmetic cannot use makes the hook throw.
  on('clock.now', () => ({ value: broken ? 5n : 1000 }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"skills":["commit"]}', usage: { input_tokens: 1, output_tokens: 1 } } }) as never)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => ({ text: e.text, ...(e.context ? { context: e.context } : {}) }))
  await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
  const ok = await $.prompt.submit(prompt('write a commit message for this change'))
  expect(ok.context?.[0]).toContain('may fit this prompt: commit.')
  broken = true
  expect(await $.prompt.submit(prompt('write a commit message for that change'))).toEqual({ text: 'write a commit message for that change' })
})

test('register records a Skill call from a timer and answers /skill-pick', { options: { mode: 'on' } }, async ($, on) => {
  mock.store(on)
  mock.env(on, {})
  const clock = mock.clock(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"skills":["commit"]}', usage: { input_tokens: 1, output_tokens: 1 } } }) as never)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', { tool: 'Skill' }, () => ({ result: { success: true, commandName: 'commit' } as never }))
  await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
  await $.prompt.submit(prompt('write a commit message for this change'))
  await $.tool.call({ tool: 'Skill', skill: 'git:commit' } as never)
  await clock.settle()
  expect((await $.command.run(command(''))).text).toContain('agreement: main model loaded 1 skills, 1 of 1 (100%) were picked')
  expect((await $.command.run(command('bogus'))).text).toBe('skill-pick: usage is /skill-pick, /skill-pick last or /skill-pick clear.')
  expect((await $.command.run(command('clear'))).text).toBe('skill-pick: log cleared.')
  expect((await $.command.run(command('last'))).text).toBe('skill-pick: no records.')
})

test('skill-pick shows the Jev notice once per install', { options: { mode: 'on' } }, async ($, on) => {
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
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"skills":["commit"]}', usage: { input_tokens: 1, output_tokens: 1 } } }) as never)
  await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
  expect((await $.prompt.submit(prompt('write a commit message for this change'))).text).toBeDefined()
  expect((await $.prompt.submit(prompt('write a commit message for that change'))).text).toBeDefined()
  expect(toasts).toEqual(['skill-pick: prompts and skill descriptions are sent to api.typesafe.ai (Jev) from every directory. Restrict with the jevPaths option, or set picker=haiku. See the README Privacy section.'])
  expect(kept.jevNotice).toBe(true)
})

test('skill-pick shows no Jev notice when the store remembers it', { options: { mode: 'on' } }, async ($, on) => {
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
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"skills":["commit"]}', usage: { input_tokens: 1, output_tokens: 1 } } }) as never)
  await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
  await $.prompt.submit(prompt('write a commit message for this change'))
  expect(toasts).toEqual([])
})
