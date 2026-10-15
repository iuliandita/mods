import { statSync } from 'node:fs'

import { run } from '../../../host-lib/proc'
import { makeScrubber, placeholderNames, rewriteCommand, type Scrubber } from '../claude/hooks/scrub'

export type Mode = 'off' | 'dry' | 'on'

// An unreadable option counts as on, so a typo cannot switch the box off.
export const parseMode = (v: unknown): Mode => (v === 'off' || v === 'dry' ? v : 'on')

export { placeholderNames }

export const LOAD_FAILED =
  'secret-box: the stored secrets could not be loaded, so the command was blocked before it ran (fail closed). Check that secret-tool works and the keyring is unlocked (run "secret-box names" in a terminal), or set mode to off or dry in ~/.config/iuliandita-mods/secret-box.json.'

export const helperMissing = (helper: string): string => `secret-box: the helper ${helper} was not found, so the command was blocked (fail closed). Reinstall the plugin.`

export function helperExists(helper: string): boolean {
  try {
    return statSync(helper).isFile()
  } catch {
    return false
  }
}

// Every stored value through the helper, or null when it cannot be read. Never throws, never puts a value in a message.
export async function loadValues(helper: string): Promise<Map<string, string> | null> {
  const r = await run('/', [helper, 'values'], undefined, 10_000)
  if (!r.ok) return null
  try {
    const raw: unknown = JSON.parse(r.out)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    return new Map(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    return null
  }
}

// The command a host runs instead: the helper fills the placeholders in and scrubs its own output.
export const rewrite = (helper: string, command: string): string => rewriteCommand(helper, command, true)

const WITHHELD = '[secret-box: this content was withheld because scrubbing failed]'
const MAX_DEPTH = 24

// Every string under a value, copied; a subtree deeper than MAX_DEPTH or looping back is replaced by a notice.
export function scrubValue<T>(value: T, scrub: Scrubber): { value: T; names: string[] } {
  const names = new Set<string>()
  const walk = (v: unknown, depth: number, path: Set<object>): unknown => {
    if (typeof v === 'string') {
      const r = scrub(v)
      r.names.forEach((n) => names.add(n))
      return r.text
    }
    if (v === null || typeof v !== 'object') return v
    if (depth > MAX_DEPTH || path.has(v)) return WITHHELD
    path.add(v)
    try {
      return Array.isArray(v) ? v.map((x) => walk(x, depth + 1, path)) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1, path)]))
    } finally {
      path.delete(v)
    }
  }
  const out = walk(value, 0, new Set()) as T
  return { value: out, names: [...names] }
}

// Values and their scrubber, loaded on first use and again after a placeholder command; after a failed load it
// tries again at most every RETRY_MS.
const RETRY_MS = 30_000

export function createBox(helper: string, now: () => number = Date.now) {
  let scrubber: Scrubber | null = null
  let known: Map<string, string> | null = null
  let failedAt: number | null = null
  let inflight: Promise<boolean> | null = null

  const load = (): Promise<boolean> => {
    inflight ??= (async () => {
      try {
        const values = await loadValues(helper)
        failedAt = values ? null : now()
        if (values) {
          known = values
          scrubber = makeScrubber(values)
        }
        return values !== null
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  return {
    load,
    // The scrubber, or null when no values are stored or they cannot be loaded right now.
    async scrubber(): Promise<Scrubber | null> {
      if (known !== null) return scrubber
      if (inflight) await inflight
      else if (failedAt === null || now() - failedAt >= RETRY_MS) await load()
      return scrubber
    },
  }
}
