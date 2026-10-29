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

const WITHHELD = '[secret-box: this content was withheld because scrubbing failed]'
const MAX_DEPTH = 24
// Structural fields a host reads to tell a message part from another; the same idea as Claude's list.
const KEEP_ON_FAILURE = new Set(['role', 'type'])

// Every string and object key under a value, copied (a class instance keeps its prototype; a value with no
// own enumerable fields, like a Date, is left as it is). A subtree deeper than MAX_DEPTH or looping back is
// replaced by a notice and counts as a change, so a caller never keeps the original. A key that then collides
// with another gets a `#2`, `#3`... suffix. With `shape` set the keys stay as they are, and so do the string
// values under the KEEP_ON_FAILURE keys, so a host can still read what it was given.
export function scrubValue<T>(value: T, scrub: Scrubber, shape = false): { value: T; names: string[]; changed: boolean } {
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
      const entries = Object.entries(v)
      if (entries.length === 0) return v
      const out = Object.create(Object.getPrototypeOf(v)) as Record<string, unknown>
      for (const [k, x] of entries) {
        const base = shape ? k : text(k)
        let key = base
        for (let n = 2; key in out; n++) key = `${base}#${n}`
        out[key] = shape && typeof x === 'string' && KEEP_ON_FAILURE.has(k) ? x : walk(x, depth + 1, path)
      }
      return out
    } finally {
      path.delete(v)
    }
  }
  const out = walk(value, 0, new Set()) as T
  return { value: out, names: [...names], changed }
}

export async function scrubRemote<T>(helper: string, value: T): Promise<T> {
  try {
    const r = await scrubBatch((scrub) => scrubValue(value, scrub), (texts) => request(helper, texts))
    return r.value
  } catch {
    // Renamed keys would break the host's messages for every turn until the helper works again.
    return scrubValue(value, () => ({ text: WITHHELD, names: ['withheld'] }), true).value
  }
}
