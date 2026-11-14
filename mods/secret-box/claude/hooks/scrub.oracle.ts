// Test oracle: a TypeScript port of the forms and the scrubber in bin/secret-box. No hook imports it;
// the tests use it as the fake helper and tests/test_secret_box_scrub.py checks forms() against the helper.

import { MIN_LEN, type Scrubber } from './scrub'

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

const HEX = [(n: number) => n.toString(16), (n: number) => n.toString(16).toUpperCase()]
const unicodeEscape = (c: string, hex: (n: number) => string) => `\\u${hex(c.charCodeAt(0)).padStart(4, '0')}`

export function forms(value: string): string[] {
  const out = new Set<string>()
  for (const base of new Set([value, value.trim()])) {
    if (base.length < MIN_LEN) continue
    out.add(base)
    const json = JSON.stringify(base).slice(1, -1)
    const rendered = [json]
    // ensure_ascii encoders (python json.dumps) write each non-ASCII UTF-16 unit as \uXXXX
    if (/[^\x00-\x7f]/.test(base)) for (const hex of HEX) rendered.push(json.replace(/[^\x00-\x7f]/g, (c) => unicodeEscape(c, hex)))
    // HTML-safe encoders (Go's encoding/json) also escape & < > and the two line separators.
    for (const r of [...rendered]) for (const hex of HEX) rendered.push(r.replace(/[&<>\u2028\u2029]/g, (c) => unicodeEscape(c, hex)))
    // PHP's json_encode writes / as \/
    for (const r of rendered) out.add(r).add(r.replaceAll('/', '\\/'))
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

// Merge overlapping matches before replacing; adjacent matches remain separate.
// Takes name/value pairs; a name may appear more than once (an old and a new value).
export function makeScrubber(values: Iterable<readonly [string, string]>): Scrubber | null {
  const byForm = new Map<string, string>()
  for (const [name, value] of [...values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const f of forms(value)) if (!byForm.has(f)) byForm.set(f, name)
  }
  if (byForm.size === 0) return null
  const re = new RegExp(`(?=(${[...byForm.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escape).join('|')}))`, 'g')
  return (text) => {
    const spans: { start: number; end: number; name: string }[] = []
    for (const hit of text.matchAll(re)) {
      const start = hit.index
      const end = start + hit[1]!.length
      const last = spans[spans.length - 1]
      if (last && start < last.end) last.end = Math.max(last.end, end)
      else spans.push({ start, end, name: byForm.get(hit[1]!)! })
    }
    const names = new Set<string>()
    const out: string[] = []
    let pos = 0
    for (const { start, end, name } of spans) {
      out.push(text.slice(pos, start), `{{secret:${name}}}`)
      names.add(name)
      pos = end
    }
    out.push(text.slice(pos))
    return { text: out.join(''), names: [...names] }
  }
}
