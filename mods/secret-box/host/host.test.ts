import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main, type Io } from './cli'
import { setup } from './opencode'
import { request } from './core'
import { parseReply, scrubBatch } from '../claude/hooks/remote'
import { scopeDenied } from '../claude/hooks/scopes'

const SECRET = 'tok_AbC123xyz-Qq9'

let root: string
let helper: string
let options: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'secret-box-host-'))
  helper = join(root, 'secret-box')
  options = join(root, 'secret-box.json')
  copyFileSync(join(import.meta.dir, '..', 'claude', 'bin', 'secret-box'), helper)
  chmodSync(helper, 0o755)
  const store = join(root, 'store.json')
  writeFileSync(store, JSON.stringify({ API_KEY: SECRET }))
  process.env.SECRET_BOX_BACKEND = `file:${store}`
  process.env.SECRET_BOX_TEST = '1'
})

afterAll(() => {
  delete process.env.SECRET_BOX_BACKEND
  delete process.env.SECRET_BOX_TEST
  rmSync(root, { recursive: true, force: true })
})

const withMode = (mode?: string) => writeFileSync(options, mode === undefined ? '{}' : JSON.stringify({ mode }))

function io(stdin: string, over: Partial<Io> = {}): Io & { stdout: string; stderr: string } {
  const o = { stdout: '', stderr: '', stdin: async () => stdin, out: (s: string) => void (o.stdout += s), err: (s: string) => void (o.stderr += s), helper, options, ...over }
  return o
}

const bash = (command: string) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })

async function hook(stdin: string, over: Partial<Io> = {}) {
  const i = io(stdin, over)
  const code = await main(['hook'], i)
  return { code, out: i.stdout ? JSON.parse(i.stdout) : null }
}

test('codex: a placeholder command is replaced by the helper, which fills the value in and scrubs the output', async () => {
  withMode()
  const { code, out } = await hook(bash('printf "%s|" {{secret:API_KEY}}; echo done'))
  expect(code).toBe(0)
  expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
  const rewritten: string = out.hookSpecificOutput.updatedInput.command
  expect(rewritten).not.toContain(SECRET)
  const r = spawnSync('bash', ['-c', rewritten], { encoding: 'utf8' })
  expect(r.status).toBe(0)
  expect(r.stdout).toBe('{{secret:API_KEY}}|done\n')
  expect(r.stdout + r.stderr).not.toContain(SECRET)
})

test('codex: commands without a placeholder, other tools and bad input are left alone', async () => {
  withMode()
  expect((await hook(bash('echo hi'))).out).toBeNull()
  expect((await hook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { command: '{{secret:API_KEY}}' } }))).out).toBeNull()
  expect(await hook('not json')).toEqual({ code: 0, out: null })
})

test('the helper returns scrubbed batches and names without exposing stored values', async () => {
  const r = await request(helper, [SECRET, `key=${SECRET}`, 'unchanged'])
  expect(r.results.map((x) => x.text)).toEqual(['{{secret:API_KEY}}', 'key={{secret:API_KEY}}', 'unchanged'])
  expect(r.names).toEqual(['API_KEY'])
  expect(JSON.stringify(r)).not.toContain(SECRET)
})

test('scrub batches deduplicate strings and reject malformed or incomplete replies', async () => {
  let calls = 0
  const r = await scrubBatch((scrub) => [SECRET, SECRET].map(scrub), async (texts) => {
    calls++
    expect(texts).toEqual([SECRET])
    return request(helper, texts)
  })
  expect(calls).toBe(1)
  expect(r.map((x) => x.text)).toEqual(['{{secret:API_KEY}}', '{{secret:API_KEY}}'])
  for (const reply of ['null', '{}', '{"results":[],"names":[],"short":[]}', '{"results":[{"text":3,"names":[]}],"names":[],"short":[]}']) {
    expect(() => parseReply(reply, 1)).toThrow()
  }
})

test('opencode withholds unchecked strings when the scrub helper cannot start', async () => {
  withMode()
  const h = await plugin({ helper: join(root, 'missing') })
  const after = { tool: 'read', id: 'failure', status: 'completed', result: { output: SECRET } }
  await h.after!(after)
  expect(JSON.stringify(after.result)).not.toContain(SECRET)
  expect(JSON.stringify(after.result)).toContain('withheld')
})

test('opencode fallback allowlists message structure and withholds nested discriminators and keys', async () => {
  withMode()
  const h = await plugin({ helper: join(root, 'missing') })
  const ctx = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: SECRET, [SECRET]: true, nested: { type: SECRET, role: 'assistant' } }], [SECRET]: 1 },
      { role: 'assistant', content: [{ type: 'tool-call', id: SECRET, name: SECRET, input: { type: SECRET, role: SECRET, [SECRET]: 1 } }] },
      { role: 'tool', content: [{ type: 'tool-result', id: SECRET, name: SECRET, result: { type: 'json', value: { [SECRET]: SECRET } } }] },
      { role: SECRET, content: [{ type: SECRET, text: SECRET }] },
    ],
  }
  await h.context!(ctx)
  const text = JSON.stringify(ctx.messages)
  expect(text).not.toContain(SECRET.slice(0, 8))
  expect(Object.keys(ctx.messages[0]!)).toEqual(['role', 'content'])
  expect(Object.keys(ctx.messages[0]!.content[0]!)).toEqual(['type', 'text'])
  expect(ctx.messages[0]!.role).toBe('user')
  expect(ctx.messages[0]!.content[0]!.type).toBe('text')
  expect(ctx.messages[0]!.content[0]).toEqual({ type: 'text', text: expect.stringContaining('withheld') })
  expect(ctx.messages[1]!.content[0]!.type).toBe('tool-call')
  expect(ctx.messages[2]!.content[0]!.type).toBe('tool-result')
  expect(ctx.messages[3]).toEqual({ role: 'user', content: [{ type: 'text', text: expect.stringContaining('withheld') }] })
  for (const field of ['type', 'role', SECRET]) {
    const after = { tool: 'read', id: 'failed', status: 'error', result: { [field]: SECRET }, error: { [SECRET]: { type: 'text', role: SECRET } } }
    await h.after!(after)
    expect(JSON.stringify([after.result, after.error])).not.toContain(SECRET)
    expect<unknown>(after.result).toEqual({ output: expect.stringContaining('withheld'), content: [{ type: 'text', text: expect.stringContaining('withheld') }] })
    expect(after.error).toBeInstanceOf(Error)
  }
  const prompt = { prompt: { [SECRET]: { type: SECRET, role: SECRET } } }
  await h.prompt!(prompt)
  expect(JSON.stringify(prompt)).not.toContain(SECRET)
  expect<unknown>(prompt.prompt).toEqual({ text: expect.stringContaining('withheld'), files: [], agents: [], skills: [] })
})

test('opencode fallback keeps tool pairing and boolean provider execution without unchecked fields', async () => {
  withMode()
  const h = await plugin({ helper: join(root, 'missing') })
  for (const providerExecuted of [true, false, SECRET, undefined]) {
    const ctx = { messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: SECRET, name: SECRET, input: SECRET, providerExecuted }] },
      { role: 'tool', content: [{ type: 'tool-result', id: SECRET, name: SECRET, result: SECRET, providerExecuted }] },
    ] }
    await h.context!(ctx)
    const call = ctx.messages[0]!.content[0]!
    const result = ctx.messages[1]!.content[0]!
    expect(call).toHaveProperty('input', {})
    expect(call.id).toBe(result.id)
    for (const part of [call, result]) {
      if (typeof providerExecuted === 'boolean') expect(part.providerExecuted).toBe(providerExecuted)
      else expect(part).not.toHaveProperty('providerExecuted')
    }
    expect(JSON.stringify(ctx)).not.toContain(SECRET)
  }
})

test('opencode fallback replaces error fields and prompt attachments with usable notices', async () => {
  withMode()
  const h = await plugin({ helper: join(root, 'missing') })
  class ToolError extends Error {}
  const failed = { tool: 'shell', id: 'failed', status: 'error',
    result: { output: SECRET, content: [{ type: 'text', text: SECRET }], [SECRET]: SECRET },
    error: new ToolError(SECRET, { cause: SECRET }),
  }
  await h.after!(failed)
  expect(failed.error).toBeInstanceOf(ToolError)
  expect(failed.error.message).toContain('withheld')
  expect(failed.error.stack).not.toContain(SECRET)
  expect(failed.error).not.toHaveProperty('cause')
  expect(failed.error).not.toHaveProperty('metadata')
  expect<unknown>(failed.result).toEqual({ output: expect.stringContaining('withheld'), content: [{ type: 'text', text: expect.stringContaining('withheld') }] })
  const prompt = { prompt: { text: SECRET, files: [{ uri: SECRET }], agents: [{ name: SECRET }], skills: [{ id: SECRET }], [SECRET]: SECRET } }
  await h.prompt!(prompt)
  expect<unknown>(prompt.prompt).toEqual({ text: expect.stringContaining('withheld'), files: [], agents: [], skills: [] })
  expect(JSON.stringify([failed, prompt])).not.toContain(SECRET)
})

test('opencode scrubs non-enumerable Error messages, stacks and causes when the helper works', async () => {
  withMode()
  const h = await plugin()
  const failed = { tool: 'shell', id: 'error', status: 'error', error: new Error(SECRET, { cause: SECRET }) }
  await h.after!(failed)
  expect(failed.error).toBeInstanceOf(Error)
  expect(failed.error.message).toBe('{{secret:API_KEY}}')
  expect(failed.error.stack).not.toContain(SECRET)
  expect(failed.error.cause).toBe('{{secret:API_KEY}}')
})

test('the helper reply stays near the text size for non-ASCII text, so a large file still fits the 4 MiB cap', async () => {
  const big = '汉'.repeat(700_000)
  const r = await request(helper, [big, '\ud800 lone'])
  expect(r.results[0]!.text).toBe(big)
  expect(r.results[1]!.text).toBe('\ud800 lone')
})

test('codex: off leaves the command alone, dry only reports, an unreadable options file counts as on', async () => {
  withMode('off')
  expect((await hook(bash('echo {{secret:API_KEY}}'))).out).toBeNull()
  withMode('dry')
  const dry = (await hook(bash('echo {{secret:API_KEY}}'))).out
  expect(dry.systemMessage).toContain('API_KEY')
  expect(dry.hookSpecificOutput).toBeUndefined()
  writeFileSync(options, '{ broken')
  expect((await hook(bash('echo {{secret:API_KEY}}'))).out.hookSpecificOutput.permissionDecision).toBe('deny')
})

test('codex: a missing helper blocks a placeholder command only', async () => {
  withMode()
  const missing = { helper: join(root, 'nope') }
  const denied = (await hook(bash('echo {{secret:API_KEY}}'), missing)).out
  expect(denied.hookSpecificOutput.permissionDecision).toBe('deny')
  expect((await hook(bash('echo hi'), missing)).out).toBeNull()
})

type Hooks = { before?: (e: any) => Promise<void> | void; after?: (e: any) => Promise<void> | void; context?: (e: any) => Promise<void> | void; prompt?: (e: any) => Promise<void> | void }

async function plugin(over: { helper?: string } = {}): Promise<Hooks> {
  const h: Hooks = {}
  await setup(
    {
      location: { directory: '/projects' },
      tool: { hook: async (name: string, cb: any) => void (name === 'execute.before' ? (h.before = cb) : (h.after = cb)) } as any,
      session: { hook: async (name: string, cb: any) => void (name === 'context' ? (h.context = cb) : (h.prompt = cb)) } as any,
    },
    { helper, options, ...over },
  )
  return h
}

test('scope globs match whole normalized directories and invalid options fail closed', () => {
  for (const [paths, cwd, allowed] of [
    [['/projects/api/**'], '/projects/api', true], [['/projects/api/**'], '/projects/api/src', true],
    [['/projects/api/**'], '/projects/api-other', false], [['/projects/*/src'], '/projects/api/src', true],
    [['/projects/*/src'], '/projects/api/deep/src', false], [['/projects/ap?'], '/projects/api/', true],
    [['/projects/api'], '/projects/api/../other', false], [[], '/projects/api', false],
    [['/projects/api/**'], '', false],
  ] as const) {
    expect(scopeDenied({ API_KEY: paths }, ['API_KEY'], cwd) === null).toBe(allowed)
  }
  expect(scopeDenied('{"API_KEY":["/projects/api/**"]}', ['API_KEY', 'UNSCOPED'], '/projects/api')).toBeNull()
  expect(scopeDenied({ API_KEY: [] }, ['UNSCOPED'], '/other')).toBeNull()
  for (const raw of ['{', '[]', null, { API_KEY: 'all' }, { API_KEY: ['relative'] }, { API_KEY: ['/projects/../*'] }]) {
    expect(scopeDenied(raw, ['API_KEY'], '/projects/api')).toContain('secretScopes is invalid')
  }
})

test('both ports enforce scopes using the tool workdir and deny unreadable scope settings', async () => {
  writeFileSync(options, JSON.stringify({ secretScopes: { API_KEY: ['/projects/api/**'] } }))
  const h = await plugin()
  for (const [workdir, allowed] of [['api', true], ['api/src', true], ['other', false], ['api/../other', false]] as const) {
    const command = 'echo {{secret:API_KEY}}'
    const result = await hook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/projects', tool_input: { command, workdir } }))
    expect(result.out.hookSpecificOutput.permissionDecision).toBe(allowed ? 'allow' : 'deny')
    const call = h.before!({ tool: 'shell', id: workdir, input: { command, workdir } })
    if (allowed) await call
    else await expect(call).rejects.toThrow('API_KEY is not allowed in this directory; add the path to secretScopes')
  }
  expect((await hook(bash('echo {{secret:API_KEY}}'))).out.hookSpecificOutput.permissionDecision).toBe('deny')
  writeFileSync(options, '{ broken')
  await expect(h.before!({ tool: 'shell', id: 'broken', input: { command: 'echo {{secret:API_KEY}}' } })).rejects.toThrow('could not be read')
})

test('opencode: a shell command with a placeholder is rewritten, its result and the conversation are scrubbed', async () => {
  withMode()
  const h = await plugin()
  const e = { tool: 'shell', id: 'c1', input: { command: 'echo {{secret:API_KEY}}' } }
  await h.before!(e)
  expect(e.input.command).toContain('exec --scrub')
  expect(e.input.command).not.toContain(SECRET)

  const after = { tool: 'shell', id: 'c1', status: 'completed', result: { output: `key=${SECRET}`, nested: [`${SECRET}`] } }
  await h.after!(after)
  expect(JSON.stringify(after.result)).not.toContain(SECRET)
  expect(after.result.output).toBe('key={{secret:API_KEY}}')

  const ctx = { messages: [{ role: 'user', parts: [{ text: `see ${SECRET}` }] }] }
  await h.context!(ctx)
  expect(JSON.stringify(ctx.messages)).not.toContain(SECRET)
  const prompt = { prompt: `use ${SECRET}` }
  await h.prompt!(prompt)
  expect(prompt.prompt).toBe('use {{secret:API_KEY}}')
})

test('opencode: other tools are not rewritten, off does nothing, a missing helper blocks', async () => {
  withMode()
  const h = await plugin()
  const other = { tool: 'read', id: 'c2', input: { command: '{{secret:API_KEY}}' } }
  await h.before!(other)
  expect(other.input.command).toBe('{{secret:API_KEY}}')

  const gone = await plugin({ helper: join(root, 'nope') })
  await expect(gone.before!({ tool: 'shell', id: 'c3', input: { command: 'echo {{secret:API_KEY}}' } })).rejects.toThrow('not found')

  withMode('off')
  const off = await plugin()
  const e = { tool: 'shell', id: 'c4', input: { command: 'echo {{secret:API_KEY}}' } }
  await off.before!(e)
  expect(e.input.command).toBe('echo {{secret:API_KEY}}')
  const after = { tool: 'shell', id: 'c4', status: 'completed', result: SECRET }
  await off.after!(after)
  expect(after.result).toBe(SECRET)
})

test('opencode: a failed call is scrubbed in result and error, keys are scrubbed, and a too-deep value is withheld', async () => {
  withMode()
  const h = await plugin()
  const failed = { tool: 'shell', id: 'c5', status: 'error', result: { stdout: SECRET }, error: `boom ${SECRET}` }
  await h.after!(failed)
  expect(JSON.stringify(failed)).not.toContain(SECRET)

  const keyed = { tool: 'mcp', id: 'c6', status: 'completed', result: { [SECRET]: 1, [`${SECRET}`.toUpperCase()]: 2 } }
  await h.after!(keyed)
  expect(JSON.stringify(keyed)).not.toContain(SECRET)

  let deep: unknown = SECRET
  for (let i = 0; i < 40; i++) deep = { next: deep }
  const nested = { tool: 'mcp', id: 'c7', status: 'completed', result: deep }
  await h.after!(nested)
  expect(JSON.stringify(nested.result)).not.toContain(SECRET)
  expect(JSON.stringify(nested.result)).toContain('withheld')

  const cyc: Record<string, unknown> = { s: SECRET }
  cyc.self = cyc
  const looped = { tool: 'mcp', id: 'c8', status: 'completed', result: cyc }
  await h.after!(looped)
  expect(JSON.stringify(looped.result)).not.toContain(SECRET)
})
