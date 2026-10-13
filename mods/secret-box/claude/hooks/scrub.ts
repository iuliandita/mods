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

export function rewriteCommand(wrapper: string, command: string): string {
  return `${quote(wrapper)} exec -- ${quote(command)}`
}

function utf8(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// The module has no Buffer or guaranteed btoa, so encode by hand.
function base64Bytes(b: number[]): string {
  let out = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < b.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < b.length ? B64[n & 63]! : '='
  }
  return out
}

export const base64 = (s: string): string => base64Bytes(utf8(s))

// The value alone, plus the part of its base64 that stays the same when 1 or 2 bytes come before it
// (as in `user:<value>`): the leading chars that mix in those bytes and the trailing partial group
// are cut, in both the standard and the URL-safe alphabet.
function base64Forms(base: string): string[] {
  const bytes = utf8(base)
  const whole = base64Bytes(bytes)
  const out = [whole, whole.replace(/=+$/, '')]
  for (const k of [0, 1, 2]) {
    const raw = base64Bytes([...[0, 0].slice(0, k), ...bytes]).replace(/=+$/, '')
    out.push(raw.slice([0, 2, 3][k] as number, Math.floor(((bytes.length + k) * 8) / 6)))
  }
  return [...out, ...out.map((f) => f.replaceAll('+', '-').replaceAll('/', '_'))]
}

const lowerHex = (s: string) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())
const strictUrl = (s: string) => s.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

function forms(value: string): string[] {
  const out = new Set<string>()
  for (const base of new Set([value, value.trim()])) {
    if (base.length < MIN_LEN) continue
    out.add(base)
    const json = JSON.stringify(base).slice(1, -1)
    out.add(json)
    // ensure_ascii encoders (python json.dumps) write each non-ASCII UTF-16 unit as \uXXXX
    if (/[^\x00-\x7f]/.test(base)) {
      for (const hex of [(n: number) => n.toString(16), (n: number) => n.toString(16).toUpperCase()]) {
        out.add(json.replace(/[^\x00-\x7f]/g, (c) => `\\u${hex(c.charCodeAt(0)).padStart(4, '0')}`))
      }
    }
    try {
      const url = encodeURIComponent(base)
      for (const u of [url, strictUrl(url)]) for (const f of [u, u.replaceAll('%20', '+')]) out.add(f).add(lowerHex(f))
    } catch {
      // a lone surrogate has no URL form
    }
    for (const f of base64Forms(base)) out.add(f)
  }
  return [...out]
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// One pass with the longest form first, so a replacement is never scanned again.
// Takes name/value pairs; a name may appear more than once (an old and a new value).
export function makeScrubber(values: Iterable<readonly [string, string]>): Scrubber | null {
  const byForm = new Map<string, string>()
  for (const [name, value] of [...values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const f of forms(value)) if (!byForm.has(f)) byForm.set(f, name)
  }
  if (byForm.size === 0) return null
  const re = new RegExp([...byForm.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escape).join('|'), 'g')
  return (text) => {
    const names = new Set<string>()
    const out = text.replace(re, (hit) => {
      const name = byForm.get(hit) as string
      names.add(name)
      return `{{secret:${name}}}`
    })
    return { text: out, names: [...names] }
  }
}

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

const WITHHELD = '[secret-box: this content was withheld because scrubbing failed]'

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
