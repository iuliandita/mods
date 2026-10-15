import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { baseUrl, readUnder, type Complete } from '../../../host-lib/engine'
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
  expect(r.out).toBeNull()
  expect(r.measured).toEqual([{ prompt: VAGUE, cwd: root }])
  expect(calls).toBe(0)
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
    expect((await hook(VAGUE)).out).toBeNull()
  } finally {
    delete process.env.TYPESAFE_API_KEY
  }
})

type Hook = (e: { prompt: { text: string } }) => Promise<void> | void

async function plugin(): Promise<{ run: Hook; generated: string[] }> {
  const generated: string[] = []
  let run: Hook = () => {}
  await setup(
    {
      location: { directory: root },
      generate: {
        text: async ({ prompt }) => {
          generated.push(prompt)
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

test('the Anthropic base URL must be https, or a loopback address', () => {
  expect(baseUrl(undefined)).toBe('https://api.anthropic.com')
  expect(baseUrl('https://proxy.example.com/')).toBe('https://proxy.example.com')
  expect(baseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  expect(baseUrl('http://attacker.example.com')).toBe('https://api.anthropic.com')
  expect(baseUrl('not a url')).toBe('https://api.anthropic.com')
})

// The committed Codex bundle under plain node, with no keys: it must answer and exit on its own.
test('the built Codex bundle runs under node and exits after answering', () => {
  const bundle = join(import.meta.dir, '..', 'codex', 'bin', 'prompt-gate.mjs')
  const r = spawnSync('node', [bundle, 'hook'], { input: submit(VAGUE), encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 20_000 })
  expect(r.status).toBe(0)
  expect(r.signal).toBeNull()
  expect(spawnSync('node', [bundle, 'hook'], { input: 'not json', encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 20_000 }).status).toBe(0)
})
