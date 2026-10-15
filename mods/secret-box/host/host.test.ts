import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main, type Io } from './cli'
import { setup } from './opencode'

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

test('codex: off leaves the command alone, dry only reports, an unreadable options file counts as on', async () => {
  withMode('off')
  expect((await hook(bash('echo {{secret:API_KEY}}'))).out).toBeNull()
  withMode('dry')
  const dry = (await hook(bash('echo {{secret:API_KEY}}'))).out
  expect(dry.systemMessage).toContain('API_KEY')
  expect(dry.hookSpecificOutput).toBeUndefined()
  writeFileSync(options, '{ broken')
  expect((await hook(bash('echo {{secret:API_KEY}}'))).out.hookSpecificOutput.permissionDecision).toBe('allow')
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
      tool: { hook: async (name: string, cb: any) => void (name === 'execute.before' ? (h.before = cb) : (h.after = cb)) } as any,
      session: { hook: async (name: string, cb: any) => void (name === 'context' ? (h.context = cb) : (h.prompt = cb)) } as any,
    },
    { helper, options, ...over },
  )
  return h
}

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
