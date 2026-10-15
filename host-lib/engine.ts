import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { open, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { pathAllowed } from '../shared/paths'
import { dataDir, home } from './options'

// The part of the Claude Code engine's `$` that prompt-gate and skill-pick call, built from Node, so their
// exported logic (`gate`, `choose`) runs unchanged on a host that has no such engine.
export type Completion = { isAnswered: boolean; text: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
export type PromptBlock = { text: string; cache?: boolean }
export type CompleteRequest = { model: string; prompt: string | readonly PromptBlock[]; system: string; maxTokens: number; effort?: string; timeoutMs: number }
export type Complete = (req: CompleteRequest) => Promise<Completion>

// The text of a prompt given as one string or as blocks.
export const promptText = (p: CompleteRequest['prompt']): string => (typeof p === 'string' ? p : p.map((b) => b.text).join('\n\n'))

export type EngineOptions = {
  mod: string
  cwd: string
  complete: Complete
  // Notices for the user ("toasts"); the host shows them however it can.
  notify: (text: string) => void
  // Where the mod's log and state live; the account's data directory unless a test says otherwise.
  store?: string
  fetch?: typeof fetch
}

const READ_MAX = 64 * 1024
const FETCH_MS = 10_000

// A regular file under `cwd` (after symlinks are resolved), at most READ_MAX bytes of it: a repository must not be able
// to point AGENTS.md at a secret file or at a device and have it read into a prompt.
export async function readUnder(cwd: string, name: string): Promise<string> {
  const root = await realpath(cwd)
  const file = await realpath(resolve(root, name))
  if (file !== root && !file.startsWith(root + sep)) throw new Error('outside the working directory')
  const handle = await open(file, 'r')
  try {
    if (!(await handle.stat()).isFile()) throw new Error('not a regular file')
    const buf = Buffer.alloc(READ_MAX)
    const { bytesRead } = await handle.read(buf, 0, READ_MAX, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export const storeFile = (mod: string): string => join(dataDir(), mod, 'store.json')

function readStore(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeStore(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, path)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing was written
    }
    throw e
  }
}

// A key/value file; last writer wins, as the Claude engine's store does across sessions.
export function fileStore(path: string) {
  return {
    get: async (key: string): Promise<unknown> => readStore(path)[key],
    set: async (key: string, value: unknown): Promise<void> => writeStore(path, { ...readStore(path), [key]: value }),
  }
}

export function createEngine(o: EngineOptions) {
  const store = fileStore(o.store ?? storeFile(o.mod))
  const doFetch = o.fetch ?? fetch
  return {
    clock: {
      now: async (): Promise<number> => Date.now(),
      sleep: (ms: number, opts?: { signal?: AbortSignal }): Promise<void> =>
        new Promise((done, fail) => {
          const stop = () => {
            clearTimeout(timer)
            fail(new Error('aborted'))
          }
          const timer = setTimeout(() => {
            opts?.signal?.removeEventListener('abort', stop)
            done()
          }, ms)
          if (opts?.signal?.aborted) return stop()
          opts?.signal?.addEventListener('abort', stop, { once: true })
        }),
      after: (ms: number, fn: () => unknown): void => void setTimeout(() => void Promise.resolve().then(fn).catch(() => {}), ms),
    },
    // HOME comes from the password database, not the environment: a repository can set HOME through a .env file.
    env: { get: async (name: string): Promise<string | undefined> => (name === 'HOME' ? home() : process.env[name]) },
    store,
    ui: { toast: (text: string): void => o.notify(text) },
    session: { cwd: async (): Promise<string> => o.cwd },
    fs: { read: (name: string): Promise<string> => readUnder(o.cwd, name) },
    model: { complete: o.complete },
    http: {
      fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> => {
        const r = await doFetch(url, { ...init, signal: AbortSignal.timeout(FETCH_MS) })
        return { status: r.status, text: await r.text() }
      },
    },
  }
}

export type NodeEngine = ReturnType<typeof createEngine>

// The model a Codex session judges prompts with: a small one at low effort, through the user's own Codex login.
export const CODEX_MODEL = 'gpt-6-luna'
// Set for the nested session, so a hook that runs inside it does nothing.
export const NESTED_ENV = 'IULIANDITA_MODS_NESTED'
const CODEX_MS = 20_000

export type RunCodex = (args: string[], input: string, timeoutMs: number) => Promise<boolean>

function spawnCodex(args: string[], input: string, timeoutMs: number): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn('codex', args, { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, [NESTED_ENV]: '1' }, windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', () => (clearTimeout(timer), done(false)))
    child.on('close', (code) => (clearTimeout(timer), done(code === 0)))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

// The model call for Codex, which hands hooks none: a nested read-only `codex exec` in an empty folder, with hooks off,
// no saved session and the prompt on stdin (not in argv). It runs on the user's Codex login, so no key is read here.
// A model option that is not a gpt- model (the Claude plugin's default is "haiku") means the small default.
export function codexComplete(run: RunCodex = spawnCodex): Complete {
  return async (req) => {
    const dir = mkdtempSync(join(tmpdir(), 'mods-judge-'))
    try {
      const out = join(dir, 'answer.txt')
      const model = req.model.startsWith('gpt-') ? req.model : CODEX_MODEL
      const args = ['exec', '-m', model, '-c', 'model_reasoning_effort="low"', '--disable', 'hooks', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', dir, '-o', out, '-']
      const ok = await run(args, `${req.system}\n\n${promptText(req.prompt)}`, Math.max(req.timeoutMs, CODEX_MS))
      if (!ok) return { isAnswered: false, text: '' }
      const text = readFileSync(out, 'utf8').trim()
      return { isAnswered: text !== '', text }
    } catch {
      return { isAnswered: false, text: '' }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// `jevPaths` also limits where a prompt may go to a model on these hosts: outside the listed folders the call is not made.
export function pathLimited(complete: Complete, paths: string, cwd: string): Complete {
  return async (req) => (pathAllowed(cwd, paths, home()) ? complete(req) : { isAnswered: false, text: '' })
}
