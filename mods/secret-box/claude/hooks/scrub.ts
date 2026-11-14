// Pure helpers: placeholder detection, shell quoting, and value scrubbing. No engine calls here.

export const MIN_LEN = 6

const PLACEHOLDER = /\{\{secret:([A-Za-z0-9._-]+)\}\}/g

export type Block = { type: string; [field: string]: unknown }
export type Scrubber = (text: string) => { text: string; names: string[] }

export function placeholderNames(command: string): string[] {
  return [...new Set([...command.matchAll(PLACEHOLDER)].map((m) => m[1] as string))]
}

// POSIX single quoting; leaves a plain word bare, like shlex.quote.
export function quote(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  return `'${s.replaceAll("'", "'\\''")}'`
}

// The command a host runs instead: the helper fills the placeholders in and scrubs its own output.
export function rewriteCommand(wrapper: string, command: string): string {
  return `${quote(wrapper)} exec --scrub -- ${quote(command)}`
}

export type Mode = 'off' | 'dry' | 'on'

// An unreadable option counts as on, so a typo cannot switch the box off.
export const parseMode = (v: unknown): Mode => (v === 'off' || v === 'dry' ? v : 'on')

// Rewrites text blocks and a tool_result's content; every other block stays as it was.
export function scrubBlocks(blocks: readonly Block[], scrub: Scrubber): { content: Block[]; names: string[] } {
  const names = new Set<string>()
  const text = (s: string) => {
    const r = scrub(s)
    r.names.forEach((n) => names.add(n))
    return r.text
  }
  const walk = (b: Block): Block => {
    if (b.type === 'text' && typeof b.text === 'string') {
      const t = text(b.text)
      return t === b.text ? b : { ...b, text: t }
    }
    if (b.type === 'tool_result') {
      if (typeof b.content === 'string') {
        const t = text(b.content)
        return t === b.content ? b : { ...b, content: t }
      }
      if (Array.isArray(b.content)) {
        const inner = (b.content as Block[]).map(walk)
        return inner.some((x, i) => x !== (b.content as Block[])[i]) ? { ...b, content: inner } : b
      }
    }
    return b
  }
  return { content: blocks.map(walk), names: [...names] }
}

export const WITHHELD = '[secret-box: this content was withheld because scrubbing failed]'

// Last resort when scrubbing itself failed: keep the row's shape, drop what it said.
export function withhold(blocks: readonly Block[]): Block[] {
  return blocks.map((b) => {
    if (b.type === 'text') return { ...b, text: WITHHELD }
    if (b.type === 'tool_result') return { ...b, content: WITHHELD }
    return b
  })
}

const PATH_FIELDS = new Set(['persistedOutputPath', 'rawOutputPath'])
// Kept as they are even when scrubbing failed: a backgrounded command needs its id, a block its type.
const KEEP_ON_FAILURE = new Set([...PATH_FIELDS, 'backgroundTaskId', 'type'])
const MAX_DEPTH = 12

type KeyFn = (k: string, depth: number) => string

// Walks strings, arrays and objects; a subtree deeper than MAX_DEPTH or one that loops back on itself
// is replaced by the notice, never returned as it was. Keys in `keep` are not touched. Other keys go
// through `fk`; one that then collides with a key already there gets a `#2`, `#3`... suffix, so no
// entry is lost. Key order stays.
function scrubDeep(v: unknown, f: (s: string) => string, fk: KeyFn, keep: ReadonlySet<string>, mark: () => void, depth = 0, path = new Set<object>()): unknown {
  if (typeof v === 'string') return f(v)
  if (v === null || typeof v !== 'object') return v
  if (depth > MAX_DEPTH || path.has(v)) {
    mark()
    return WITHHELD
  }
  path.add(v)
  try {
    if (Array.isArray(v)) return v.map((x) => scrubDeep(x, f, fk, keep, mark, depth + 1, path))
    const entries = Object.entries(v)
    const used = new Set(entries.map(([k]) => k).filter((k) => keep.has(k)))
    return Object.fromEntries(
      entries.map(([k, x]) => {
        if (keep.has(k)) return [k, x]
        const base = fk(k, depth)
        let key = base
        for (let n = 2; used.has(key); n++) key = `${base}#${n}`
        used.add(key)
        return [key, scrubDeep(x, f, fk, keep, mark, depth + 1, path)]
      }),
    )
  } finally {
    path.delete(v)
  }
}

// A Bash tool.call answer carries the output in `result` (the structured record the transcript keeps,
// or the error text as a string) and in `text`, with more text in hints, blocks and `context`.
// Every string under the answer is scrubbed, and so are the keys of the data the tool produced (below
// the top two levels); the engine's own keys of the answer and its record (the top two levels) are
// never renamed, or the record would stop validating. The path fields (`persistedOutputPath`,
// `rawOutputPath`) are never altered; the file they name is the caller's to scrub. An answer
// with nothing to replace comes back as the same object. If scrubbing throws, the strings are replaced
// by a notice rather than returned raw; the background task id, `type` keys and paths stay, and so do
// the engine's own keys of the answer and its record (the top two levels); deeper keys are withheld.
export function scrubToolAnswer<T>(answer: T, scrub: Scrubber): T {
  const a = answer as { deny?: unknown } | null
  if (a === null || typeof a !== 'object' || a.deny !== undefined) return answer
  try {
    let changed = false
    const f = (s: string) => {
      const r = scrub(s)
      if (r.names.length > 0) changed = true
      return r.text
    }
    const out = scrubDeep(a, f, (k, depth) => (depth <= 1 ? k : f(k)), PATH_FIELDS, () => (changed = true))
    return (changed ? out : answer) as T
  } catch {
    return scrubDeep(a, () => WITHHELD, (k, depth) => (depth <= 1 ? k : WITHHELD), KEEP_ON_FAILURE, () => {}) as T
  }
}
