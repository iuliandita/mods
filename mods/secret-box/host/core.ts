import { statSync } from 'node:fs'
import { execFile } from 'node:child_process'

import { parseReply, scrubBatch } from '../claude/hooks/remote'
import { placeholderNames, rewriteCommand, type Scrubber } from '../claude/hooks/scrub'

export type Mode = 'off' | 'dry' | 'on'

// An unreadable option counts as on, so a typo cannot switch the box off.
export const parseMode = (v: unknown): Mode => (v === 'off' || v === 'dry' ? v : 'on')

export { placeholderNames }

export const LOAD_FAILED =
  'secret-box: the stored secrets could not be loaded, so the command was blocked before it ran (fail closed). Check that the keyring backend works and is unlocked (run "secret-box names" in a terminal), or set mode to off or dry in ~/.config/iuliandita-mods/secret-box.json.'

export const helperMissing = (helper: string): string => `secret-box: the helper ${helper} was not found, so the command was blocked (fail closed). Reinstall the plugin.`

export function helperExists(helper: string): boolean {
  try {
    return statSync(helper).isFile()
  } catch {
    return false
  }
}

// Only scrubbed text and name metadata cross the process boundary.
export function request(helper: string, texts: string[]) {
  return new Promise<ReturnType<typeof parseReply>>((resolve, reject) => {
    const child = execFile(helper, ['scrub'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(new Error('scrub failed'))
      try { resolve(parseReply(stdout, texts.length)) } catch { reject(new Error('invalid scrub reply')) }
    })
    child.stdin?.on('error', () => {}) // An early helper exit is reported by execFile.
    child.stdin?.end(JSON.stringify(texts))
  })
}

// The command a host runs instead: the helper fills the placeholders in and scrubs its own output.
export const rewrite = (helper: string, command: string): string => rewriteCommand(helper, command, true)

export const WITHHELD = '[secret-box: this content was withheld because scrubbing failed]'
const MAX_DEPTH = 24

// @opencode/ai 2.2.1 schema/messages: only allowlisted fields are structural.
// Rebuild a minimal message rather than walking arbitrary payloads with a key-name exemption.
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const CONTENT_TYPES = new Set(['text', 'reasoning', 'media', 'tool-call', 'tool-result', 'compaction', 'effort'])

function withholdMessages(value: unknown): unknown {
  if (!Array.isArray(value)) return WITHHELD
  const toolIds = new Map<string, string>()
  const toolId = (part: unknown): string => {
    const original = part !== null && typeof part === 'object' && 'id' in part && typeof part.id === 'string' ? part.id : ''
    let id = toolIds.get(original)
    if (id === undefined) {
      id = `withheld-${toolIds.size + 1}`
      toolIds.set(original, id)
    }
    return id
  }
  return value.map((message: unknown) => {
    const role = message !== null && typeof message === 'object' && 'role' in message
      && typeof message.role === 'string' && MESSAGE_ROLES.has(message.role) ? message.role : 'user'
    const content = message !== null && typeof message === 'object' && 'content' in message
      && Array.isArray(message.content) ? message.content : [null]
    return {
      role,
      content: content.map((part: unknown) => {
        const type = part !== null && typeof part === 'object' && 'type' in part
          && typeof part.type === 'string' && CONTENT_TYPES.has(part.type) ? part.type : 'text'
        switch (type) {
          case 'tool-call':
          case 'tool-result': {
            const provider = part !== null && typeof part === 'object' && 'providerExecuted' in part
              && typeof part.providerExecuted === 'boolean' ? { providerExecuted: part.providerExecuted } : {}
            return { type, id: toolId(part), name: 'withheld', ...provider,
              ...(type === 'tool-call' ? { input: {} } : { result: { type: 'text', value: WITHHELD } }) }
          }
          case 'effort': return { type }
          case 'reasoning': return { type, text: WITHHELD }
          // Media and compaction require unchecked assets/provider state; replace the whole part.
          default: return { type: 'text', text: WITHHELD }
        }
      }),
    }
  })
}

// Every string and object key under a value, copied (a class instance keeps its prototype; a value with no
// own enumerable fields, like a Date, is left as it is). A subtree deeper than MAX_DEPTH or looping back is
// replaced by a notice and counts as a change, so a caller never keeps the original. A key that then collides
// with another gets a `#2`, `#3`... suffix.
export function scrubValue<T>(value: T, scrub: Scrubber): { value: T; names: string[]; changed: boolean } {
  const names = new Set<string>()
  let changed = false
  const text = (s: string): string => {
    const r = scrub(s)
    r.names.forEach((n) => names.add(n))
    if (r.names.length) changed = true
    return r.text
  }
  const walk = (v: unknown, depth: number, path: Set<object>): unknown => {
    if (typeof v === 'string') return text(v)
    if (v === null || typeof v !== 'object') return v
    if (depth > MAX_DEPTH || path.has(v)) {
      changed = true
      return WITHHELD
    }
    path.add(v)
    try {
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, path))
      // Error.message/stack/cause are non-enumerable but consumed by the host too.
      const entries = v instanceof Error ? Object.getOwnPropertyNames(v).map((key) => [key, Reflect.get(v, key)] as const) : Object.entries(v)
      if (entries.length === 0) return v
      const out = Object.create(Object.getPrototypeOf(v)) as Record<string, unknown>
      for (const [k, x] of entries) {
        const base = text(k)
        let key = base
        for (let n = 2; Object.hasOwn(out, key); n++) key = `${base}#${n}`
        Object.defineProperty(out, key, { value: walk(x, depth + 1, path), enumerable: true, configurable: true, writable: true })
      }
      return out
    } finally {
      path.delete(v)
    }
  }
  const out = walk(value, 0, new Set()) as T
  return { value: out, names: [...names], changed }
}

type Fallback = 'text' | 'messages' | 'system' | 'result' | 'error' | 'prompt'

export async function scrubRemote(helper: string, value: unknown, fallback: Fallback = 'text'): Promise<unknown> {
  try {
    const r = await scrubBatch((scrub) => scrubValue(value, scrub), (texts) => request(helper, texts))
    return r.value
  } catch {
    switch (fallback) {
      case 'messages': return withholdMessages(value)
      case 'system': return [{ type: 'text', text: WITHHELD }]
      case 'result': return { output: WITHHELD, content: [{ type: 'text', text: WITHHELD }] }
      case 'prompt': return { text: WITHHELD, files: [], agents: [], skills: [] }
      case 'error': {
        const error = new Error(WITHHELD)
        // Tool.Error is yieldable in Effect. Keep its prototype, never its unchecked own fields.
        if (value instanceof Error) Object.setPrototypeOf(error, Object.getPrototypeOf(value))
        return Object.assign(error, { _tag: 'Tool.Error' })
      }
      default: return WITHHELD
    }
  }
}
