import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

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
    fs: { read: async (name: string): Promise<string> => readFile(resolve(o.cwd, name), 'utf8') },
    model: { complete: o.complete },
    http: {
      fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> => {
        const r = await doFetch(url, init)
        return { status: r.status, text: await r.text() }
      },
    },
  }
}

export type NodeEngine = ReturnType<typeof createEngine>

const ALIASES: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }

// The model call for a host that has none: the Anthropic Messages API with the user's own key. Without a key the
// answer is "not answered", which the mods treat as an error and let the prompt through.
export function anthropicComplete(key: () => string | undefined, doFetch: typeof fetch = fetch): Complete {
  return async (req) => {
    const apiKey = key()
    if (!apiKey) return { isAnswered: false, text: '' }
    const r = await doFetch(`${(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ALIASES[req.model] ?? req.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content: typeof req.prompt === 'string' ? req.prompt : req.prompt.map((b) => ({ type: 'text', text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}) })) }] }),
      signal: AbortSignal.timeout(req.timeoutMs),
    })
    if (!r.ok) return { isAnswered: false, text: '' }
    const body = (await r.json()) as { content?: { type?: string; text?: string }[]; usage?: Completion['usage'] }
    const text = (body.content ?? []).map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
    return { isAnswered: text !== '', text, usage: body.usage }
  }
}
