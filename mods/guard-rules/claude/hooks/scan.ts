// Scanners for the pieces of a shell word: quotes, escapes, substitutions, heredoc bodies and arithmetic.

// `quoted`: the delimiter was quoted, so the body is data; otherwise the shell expands substitutions in it.
// `owner` receives the body.
export type Heredoc = { delim: string; strip: boolean; quoted?: boolean; owner?: string[] }

export const SEPARATORS = new Set([';', '&', '|', '(', ')'])

export function isSpace(c: string): boolean {
  return c === ' ' || c === '\t'
}

export function isWordEnd(c: string): boolean {
  return isSpace(c) || c === '\n' || SEPARATORS.has(c) || c === '<' || c === '>'
}

// Consumes heredoc bodies starting at `i`, the first char after a newline; `onBody` gets each body.
export function skipBodies(src: string, i: number, pending: Heredoc[], onBody?: (hd: Heredoc, body: string) => void): number {
  let pos = i
  for (const hd of pending) {
    const start = pos
    let stop = src.length
    while (pos < src.length) {
      let end = src.indexOf('\n', pos)
      if (end === -1) end = src.length
      const line = src.slice(pos, end)
      const at = pos
      pos = Math.min(end + 1, src.length)
      if ((hd.strip ? line.replace(/^\t+/, '') : line) === hd.delim) {
        stop = at
        break
      }
    }
    onBody?.(hd, src.slice(start, stop))
  }
  return pos
}

// The end of an arithmetic `((...))` whose first `((` is at `i`, or -1 when it is two nested subshells, as bash
// decides: the first `)` that closes the inner level must be followed by another `)`.
export function arithEnd(src: string, i: number): number {
  let depth = 0
  for (let pos = i + 2; pos < src.length; pos++) {
    const c = src[pos]
    if (c === '(') depth++
    else if (c === ')' && depth > 0) depth--
    else if (c === ')') return src[pos + 1] === ')' ? pos + 2 : -1
  }
  return -1
}

// Arithmetic runs the substitutions in it and evaluates subscripts recursively.
export function arithOpaque(inner: string): boolean {
  return /\$\(|`|\[|\bPATH\b/.test(inner)
}

const ANSI_ESCAPES: Record<string, string> = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
}
const ANSI_NUMERIC: [RegExp, number][] = [[/^([0-7]{1,3})/, 8], [/^x([0-9a-fA-F]{1,2})/, 16], [/^u([0-9a-fA-F]{1,4})/, 16], [/^U([0-9a-fA-F]{1,8})/, 16]]

// One escape of a "$'...'" string at `pos` (the backslash), decoded as bash does; an unknown escape keeps its backslash.
function ansiEscape(src: string, pos: number): { text: string; next: number } {
  const n = src[pos + 1]!
  if (Object.hasOwn(ANSI_ESCAPES, n)) return { text: ANSI_ESCAPES[n]!, next: pos + 2 }
  if (n === 'c' && pos + 2 < src.length) return { text: String.fromCharCode(src.charCodeAt(pos + 2) & 0x1f), next: pos + 3 }
  const rest = src.slice(pos + 1, pos + 10)
  for (const [re, base] of ANSI_NUMERIC) {
    const m = re.exec(rest)
    if (!m) continue
    const code = parseInt(m[1]!, base)
    const text = base === 8 ? String.fromCharCode(code & 0xff) : code <= 0x10ffff ? String.fromCodePoint(code) : ''
    return { text, next: pos + 1 + m[0].length }
  }
  return { text: '\\' + n, next: pos + 2 }
}

// `i` is the index of the "$" of a "$'...'" string. `next` is -1 when the string never closes.
export function readAnsiC(src: string, i: number): { text: string; next: number } {
  let text = ''
  let pos = i + 2
  while (pos < src.length) {
    const c = src[pos]
    if (c === '\\' && pos + 1 < src.length) {
      const r = ansiEscape(src, pos)
      text += r.text
      pos = r.next
    } else if (c === "'") {
      return { text: cutAtNul(text), next: pos + 1 }
    } else {
      text += c
      pos++
    }
  }
  return { text: cutAtNul(text), next: -1 }
}

// Bash ends the value of a "$'...'" string at its first NUL (`\0`, `\x00`, `\u0000`, ...).
function cutAtNul(text: string): string {
  const nul = text.indexOf('\0')
  return nul === -1 ? text : text.slice(0, nul)
}

// Reads one shell word (quotes and backslashes honored) from `i`.
export function readWord(src: string, i: number): { text: string; next: number } {
  let text = ''
  let pos = i
  while (pos < src.length && !isWordEnd(src[pos]!)) {
    if (src[pos] === '$' && src[pos + 1] === '"') pos++
    const c = src[pos]
    if (c === '\\' && pos + 1 < src.length) {
      text += src[pos + 1]
      pos += 2
    } else if (c === '$' && src[pos + 1] === "'") {
      const r = readAnsiC(src, pos)
      text += r.text
      pos = r.next === -1 ? src.length : r.next
    } else if (c === '"') {
      const end = skipDouble(src, pos)
      if (end === -1) {
        text += src.slice(pos + 1)
        pos = src.length
      } else {
        text += src.slice(pos + 1, end - 1).replace(/\\(["\\])/g, '$1')
        pos = end
      }
    } else if (c === "'") {
      const close = src.indexOf("'", pos + 1)
      if (close === -1) {
        text += src.slice(pos + 1)
        pos = src.length
      } else {
        text += src.slice(pos + 1, close)
        pos = close + 1
      }
    } else {
      text += c
      pos++
    }
  }
  return { text, next: pos }
}

// `i` is the index of the opening "(" of a "$(...)"; returns the index after
// the matching ")", or -1 when the substitution never closes.
export function skipSubst(src: string, i: number): number {
  let depth = 0
  const pending: Heredoc[] = []
  let pos = i
  while (pos < src.length) {
    const c = src[pos]
    if (c === '\\') {
      pos += 2
    } else if (c === '$' && src[pos + 1] === "'") {
      pos = readAnsiC(src, pos).next
      if (pos === -1) return -1
    } else if (c === "'") {
      const close = src.indexOf("'", pos + 1)
      if (close === -1) return -1
      pos = close + 1
    } else if (c === '#' && /[\s;&|(]/.test(src[pos - 1] ?? '')) {
      const nl = src.indexOf('\n', pos)
      pos = nl === -1 ? src.length : nl
    } else if (c === '"') {
      pos = skipDouble(src, pos)
      if (pos === -1) return -1
    } else if (c === '`') {
      const close = src.indexOf('`', pos + 1)
      if (close === -1) return -1
      pos = close + 1
    } else if (c === '<' && src.startsWith('<<', pos) && !src.startsWith('<<<', pos)) {
      pos += 2
      const strip = src[pos] === '-'
      if (strip) pos++
      while (isSpace(src[pos] ?? '')) pos++
      const word = readWord(src, pos)
      pending.push({ delim: word.text, strip })
      pos = word.next
    } else if (c === '\n' && pending.length) {
      pos = skipBodies(src, pos + 1, pending.splice(0))
    } else if (c === '(') {
      depth++
      pos++
    } else if (c === ')') {
      depth--
      pos++
      if (depth === 0) return pos
    } else {
      pos++
    }
  }
  return -1
}

// `i` is the index of the opening quote; returns the index after the closing one.
export function skipDouble(src: string, i: number): number {
  let pos = i + 1
  while (pos < src.length) {
    const c = src[pos]
    if (c === '\\') {
      pos += 2
    } else if (c === '"') {
      return pos + 1
    } else if (c === '$' && src[pos + 1] === '(') {
      pos = skipSubst(src, pos + 1)
      if (pos === -1) return -1
    } else if (c === '`') {
      const close = src.indexOf('`', pos + 1)
      if (close === -1) return -1
      pos = close + 1
    } else {
      pos++
    }
  }
  return -1
}
