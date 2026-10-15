import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CODEX_MODEL, codexComplete, NESTED_ENV, pathLimited, readUnder, type Complete } from '../../../host-lib/engine'
import { openCodeComplete, parseRef, pickFlash } from '../../../host-lib/opencode-model'
import type { PromptInput } from '../../../host-lib/prompt'
import { main, type Io } from './cli'
import { setup } from './opencode'

let root: string
let options: string
let store: string
let counter = 0
let reply = '{"verdict":"vague","ask":"Which file?"}'
let calls = 0
const savedKey = process.env.TYPESAFE_API_KEY

beforeAll(() => {
  delete process.env.TYPESAFE_API_KEY
  root = mkdtempSync(join(tmpdir(), 'prompt-gate-host-'))
  options = join(root, 'prompt-gate.json')
})

afterAll(() => {
  if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  store = join(root, `store-${counter++}.json`)
  reply = '{"verdict":"vague","ask":"Which file?"}'
  calls = 0
})

const setOptions = (o: Record<string, string>) => writeFileSync(options, JSON.stringify(o))

const complete: Complete = async () => {
  calls++
  if (reply === 'throw') throw new Error('boom')
  return { isAnswered: true, text: reply, usage: { input_tokens: 10, output_tokens: 5 } }
}

const submit = (prompt: string) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: root })

function io(stdin: string, over: Partial<Io> = {}): Io & { stdout: string; measured: PromptInput[] } {
  const o: Io & { stdout: string; measured: PromptInput[] } = {
    stdout: '',
    measured: [],
    stdin: async () => stdin,
    out: (s) => void (o.stdout += s),
    err: () => {},
    bundle: 'unused',
    options,
    store,
    complete,
    measure: (p) => void o.measured.push(p),
    ...over,
  }
  return o
}

async function hook(prompt: string, over: Partial<Io> = {}) {
  const i = io(submit(prompt), over)
  const code = await main(['hook'], i)
  return { code, out: i.stdout ? JSON.parse(i.stdout) : null, measured: i.measured }
}

const VAGUE = 'make the thing better somehow please'

test('codex: mode on blocks a vague prompt once and lets the same prompt through when it is sent again', async () => {
  setOptions({ mode: 'on' })
  const first = await hook(VAGUE)
  expect(first.code).toBe(0)
  expect(first.out.decision).toBe('block')
  expect(first.out.reason).toContain('Which file?')
  const again = await hook(VAGUE)
  expect(again.out).toBeNull()
})

test('codex: mode flag adds context instead of blocking, a clear prompt passes untouched', async () => {
  setOptions({ mode: 'flag' })
  const flagged = await hook(VAGUE)
  expect(flagged.out.decision).toBeUndefined()
  expect(flagged.out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
  expect(flagged.out.hookSpecificOutput.additionalContext).toContain('Which file?')
  reply = '{"verdict":"clear","ask":""}'
  expect((await hook('rename the function parse to parseConfig in src/a.ts')).out).toBeNull()
})

test('codex: off, short prompts and commands do nothing; a failing model lets the prompt through', async () => {
  setOptions({ mode: 'off' })
  expect((await hook(VAGUE)).out).toBeNull()
  setOptions({ mode: 'on' })
  expect((await hook('fix it')).out).toBeNull()
  expect((await hook('/compact the whole context please now')).out).toBeNull()
  expect(calls).toBe(0)
  reply = 'throw'
  const failed = await hook(VAGUE)
  expect(failed).toEqual({ code: 0, out: null, measured: [] })
  expect((await main(['hook'], io('not json'))) === 0).toBe(true)
})

test('codex: dry mode releases the prompt at once and hands it to the detached measurement', async () => {
  setOptions({ mode: 'dry' })
  const r = await hook(VAGUE)
  expect(r.out.systemMessage).toContain('nested Codex session')
  expect(r.measured).toEqual([{ prompt: VAGUE, cwd: root }])
  expect(calls).toBe(0)
  expect((await hook(VAGUE)).out).toBeNull()
  expect((await hook('fix it')).measured).toEqual([])
})

test('codex: the detached measurement logs a record that summary reads', async () => {
  setOptions({ mode: 'dry' })
  const i = io(JSON.stringify({ prompt: VAGUE, cwd: root }))
  await main(['measure'], i)
  await Bun.sleep(200)
  const s = io('')
  await main(['summary'], s)
  expect(s.stdout).toContain('records: 1 (clear 0, vague 1, error 0)')
  const c = io('')
  await main(['clear'], c)
  const s2 = io('')
  await main(['summary'], s2)
  expect(s2.stdout).toContain('records: 0')
})

test('codex: with a Jev key the first dry-mode prompt carries the privacy notice, once', async () => {
  setOptions({ mode: 'dry' })
  process.env.TYPESAFE_API_KEY = 'test-key'
  try {
    const first = await hook(VAGUE)
    expect(first.out.systemMessage).toContain('api.typesafe.ai')
    expect((await hook(VAGUE)).out).toBeNull()
    setOptions({ mode: 'dry', classifier: 'haiku' })
    store = join(root, `store-${counter++}.json`)
    expect((await hook(VAGUE)).out.systemMessage).not.toContain('typesafe')
  } finally {
    delete process.env.TYPESAFE_API_KEY
  }
})

type Hook = (e: { prompt: { text: string } }) => Promise<void> | void

const models: unknown[] = []

async function plugin(): Promise<{ run: Hook; generated: string[] }> {
  const generated: string[] = []
  let run: Hook = () => {}
  await setup(
    {
      location: { directory: root },
      model: {
        list: async () => ({ data: [{ id: 'gpt-x', providerID: 'other' }, { id: 'deepseek-v4.1-flash', providerID: 'go', variants: [{ id: 'high' }, { id: 'low' }] }] }),
        default: async () => ({ data: { id: 'deepseek-v4.1-flash', providerID: 'go' } }),
      },
      generate: {
        text: async ({ prompt, model }) => {
          generated.push(prompt)
          models.push(model)
          if (reply === 'throw') throw new Error('boom')
          return { text: reply }
        },
      },
      session: { hook: async (_name, cb) => void (run = cb) },
    },
    { options, store },
  )
  return { run: (e) => run(e), generated }
}

test('opencode: mode on runs as flag and appends the question; dry and a clear verdict leave the prompt alone', async () => {
  setOptions({ mode: 'on' })
  const on = await plugin()
  const e = { prompt: { text: VAGUE } }
  await on.run(e)
  expect(e.prompt.text.startsWith(VAGUE)).toBe(true)
  expect(e.prompt.text).toContain('Which file?')
  expect(on.generated[0]).toContain('<prompt>')
  expect(models.at(-1)).toEqual({ id: 'deepseek-v4.1-flash', providerID: 'go', variant: 'low' })

  setOptions({ mode: 'dry' })
  const dry = await plugin()
  const d = { prompt: { text: VAGUE } }
  await dry.run(d)
  expect(d.prompt.text).toBe(VAGUE)

  reply = '{"verdict":"clear","ask":""}'
  setOptions({ mode: 'on' })
  const clear = await plugin()
  const c = { prompt: { text: VAGUE } }
  await clear.run(c)
  expect(c.prompt.text).toBe(VAGUE)

  reply = 'throw'
  const failed = { prompt: { text: VAGUE } }
  await (await plugin()).run(failed)
  expect(failed.prompt.text).toBe(VAGUE)
})

test('codex: a bounced prompt is remembered per working directory', async () => {
  setOptions({ mode: 'on' })
  const other = join(root, 'other')
  mkdirSync(other, { recursive: true })
  const at = (cwd: string) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: VAGUE, cwd })
  const run = async (cwd: string) => {
    const i = io(at(cwd))
    await main(['hook'], i)
    return i.stdout ? JSON.parse(i.stdout) : null
  }
  expect((await run(root)).decision).toBe('block')
  expect((await run(other)).decision).toBe('block')
  expect(await run(root)).toBeNull()
  expect(await run(other)).toBeNull()
})

test('a file read for the vocabulary stays under the working directory, is a regular file, and is capped', async () => {
  const dir = join(root, 'repo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'secret.txt'), 'top secret')
  writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(200_000))
  symlinkSync(join(root, 'secret.txt'), join(dir, 'LEAK.md'))
  symlinkSync(join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md'))
  symlinkSync('/dev/zero', join(dir, 'ZERO.md'))
  mkdirSync(join(dir, 'sub'))
  await expect(readUnder(dir, 'LEAK.md')).rejects.toThrow('outside')
  await expect(readUnder(dir, 'ZERO.md')).rejects.toThrow()
  await expect(readUnder(dir, 'sub')).rejects.toThrow('not a regular file')
  expect((await readUnder(dir, 'CLAUDE.md')).length).toBe(64 * 1024)
})

test('codex: the judging call is a nested read-only codex exec on the small model, prompt on stdin, answer from a file', async () => {
  let seen: { args: string[]; input: string } | undefined
  const complete = codexComplete(async (args, input) => {
    seen = { args, input }
    writeFileSync(args[args.indexOf('-o') + 1] as string, ' {"verdict":"clear"} \n')
    return true
  })
  const r = await complete({ model: 'haiku', prompt: [{ text: 'A', cache: true }, { text: 'B' }], system: 'SYS', maxTokens: 200, timeoutMs: 8000 })
  expect(r).toEqual({ isAnswered: true, text: '{"verdict":"clear"}' })
  const a = seen!.args
  expect(a.slice(0, 3)).toEqual(['exec', '-m', CODEX_MODEL])
  expect(a).toContain('model_reasoning_effort="low"')
  expect(a.join(' ')).toContain('--disable hooks --ephemeral')
  expect(a.join(' ')).toContain('-s read-only')
  expect(a.at(-1)).toBe('-')
  expect(a.join(' ')).not.toContain('SYS')
  expect(seen!.input).toBe('SYS\n\nA\n\nB')
  await complete({ model: 'gpt-6-sol', prompt: 'x', system: 's', maxTokens: 1, timeoutMs: 1 })
  expect(seen!.args[2]).toBe('gpt-6-sol')
  const failed = await codexComplete(async () => false)({ model: 'haiku', prompt: 'x', system: 's', maxTokens: 1, timeoutMs: 1 })
  expect(failed.isAnswered).toBe(false)
})

test('the model call is made only inside jevPaths', async () => {
  let n = 0
  const base: Complete = async () => (n++, { isAnswered: true, text: 'x' })
  const req = { model: 'm', prompt: 'p', system: 's', maxTokens: 1, timeoutMs: 1 }
  expect((await pathLimited(base, '', root)(req)).isAnswered).toBe(true)
  expect((await pathLimited(base, root, join(root, 'sub'))(req)).isAnswered).toBe(true)
  expect((await pathLimited(base, join(root, 'elsewhere'), root)(req)).isAnswered).toBe(false)
  expect(n).toBe(2)
})

test('a nested judging session does nothing when a hook runs inside it', async () => {
  setOptions({ mode: 'on' })
  process.env[NESTED_ENV] = '1'
  try {
    expect(await hook(VAGUE)).toEqual({ code: 0, out: null, measured: [] })
    expect(calls).toBe(0)
  } finally {
    delete process.env[NESTED_ENV]
  }
})

test('opencode: DeepSeek Flash at low effort is chosen, a failing provider is skipped, provider/model is taken as given', async () => {
  const models = [
    { id: 'deepseek-v4.1-flash-free', providerID: 'opencode' },
    { id: '~deepseek/deepseek-flash-latest', providerID: 'openrouter' },
    { id: 'deepseek-v4.1-flash', providerID: 'go', variants: [{ id: 'high' }, { id: 'low' }] },
    { id: 'deepseek-v4.1-flash', providerID: 'zen', variants: [{ id: 'low' }] },
    { id: 'deepseek-v4.1-pro', providerID: 'go' },
  ]
  expect(pickFlash(models, 'zen')).toEqual({ id: 'deepseek-v4.1-flash', providerID: 'zen', variant: 'low' })
  expect(pickFlash(models)).toEqual({ id: 'deepseek-v4.1-flash', providerID: 'go', variant: 'low' })
  expect(pickFlash([{ id: 'gpt-x', providerID: 'a' }])).toBeUndefined()
  expect(parseRef('go/deepseek-v4.1-flash')).toEqual({ providerID: 'go', id: 'deepseek-v4.1-flash' })
  expect(parseRef('haiku')).toBeUndefined()

  const sent: (string | undefined)[] = []
  const broke = new Set(['zen'])
  const ctx = {
    generate: {
      text: async (i: { prompt: string; model?: { providerID: string } }) => {
        sent.push(i.model?.providerID)
        if (i.model && broke.has(i.model.providerID)) throw new Error('Insufficient account funds')
        return { text: 'ok' }
      },
    },
    model: { list: async () => ({ data: models }), default: async () => ({ data: { id: 'x', providerID: 'zen' } }) },
  }
  const req = { model: 'haiku', prompt: 'p', system: 's', maxTokens: 1, timeoutMs: 1 }
  const complete = openCodeComplete(ctx, () => 'haiku')
  expect((await complete(req)).text).toBe('ok')
  await complete(req)
  expect(sent).toEqual(['zen', 'go', 'go'])

  sent.length = 0
  await openCodeComplete(ctx, () => 'x/y')(req)
  expect(sent).toEqual(['x'])
  const none = { ...ctx, model: { list: async (): Promise<{ data: typeof models }> => { throw new Error('no') }, default: async () => ({ data: undefined }) } }
  sent.length = 0
  await openCodeComplete(none, () => '')(req)
  expect(sent).toEqual([undefined])
  broke.add('go')
  broke.add('opencode')
  await expect(openCodeComplete(ctx, () => '')(req)).rejects.toThrow('funds')
})

// The committed Codex bundle under plain node. Marked as a nested session so that it never starts a real judging call;
// it must still start, answer and exit on its own.
test('the built Codex bundle runs under node and exits after answering', () => {
  const bundle = join(import.meta.dir, '..', 'codex', 'bin', 'prompt-gate.mjs')
  const r = spawnSync('node', [bundle, 'hook'], { input: submit(VAGUE), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', IULIANDITA_MODS_NESTED: '1' }, timeout: 20_000 })
  expect(r.status).toBe(0)
  expect(r.signal).toBeNull()
  expect(spawnSync('node', [bundle, 'hook'], { input: 'not json', encoding: 'utf8', env: { PATH: process.env.PATH ?? '', IULIANDITA_MODS_NESTED: '1' }, timeout: 20_000 }).status).toBe(0)
})
