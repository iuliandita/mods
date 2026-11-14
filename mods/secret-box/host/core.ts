import { statSync } from 'node:fs'
import { execFile } from 'node:child_process'

import { parseReply, scrubBatch } from '../claude/hooks/remote'
import { parseMode, placeholderNames, rewriteCommand, WITHHELD, type Mode, type Scrubber } from '../claude/hooks/scrub'

export { parseMode, placeholderNames, rewriteCommand as rewrite, WITHHELD, type Mode }

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
            // Server tools need unchecked provider payloads to round-trip through Anthropic.
            if (provider.providerExecuted === true) return { type: 'text', text: WITHHELD }
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

// Every string and object key under a value. An array or object with a replacement under it is copied (a class
// instance keeps its prototype); one with none comes back as the same object, and so does a value with no own
// enumerable fields, like a Date. Binary views, Map, Set and URL are never walked or copied: a copy built from
// their own fields would not be one. A subtree deeper than MAX_DEPTH or looping back is replaced by a notice
// and counts as a change, so a caller never keeps the original. A key that then collides with another gets a
// `#2`, `#3`... suffix.
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
    if (ArrayBuffer.isView(v) || v instanceof Map || v instanceof Set || v instanceof URL) return v
    if (depth > MAX_DEPTH || path.has(v)) {
      changed = true
      return WITHHELD
    }
    path.add(v)
    try {
      if (Array.isArray(v)) {
        const items = v.map((x) => walk(x, depth + 1, path))
        return items.some((x, i) => x !== v[i]) ? items : v
      }
      // Error.message/stack/cause are non-enumerable but consumed by the host too.
      const entries = v instanceof Error ? Object.getOwnPropertyNames(v).map((key) => [key, Reflect.get(v, key)] as const) : Object.entries(v)
      if (entries.length === 0) return v
      const out = Object.create(Object.getPrototypeOf(v)) as Record<string, unknown>
      let same = true
      for (const [k, x] of entries) {
        const base = text(k)
        let key = base
        for (let n = 2; Object.hasOwn(out, key); n++) key = `${base}#${n}`
        const value = walk(x, depth + 1, path)
        if (key !== k || value !== x) same = false
        Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true })
      }
      return same ? v : out
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
