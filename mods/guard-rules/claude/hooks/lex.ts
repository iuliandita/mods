import { arithEnd, arithOpaque, isSpace, isWordEnd, readAnsiC, readWord, SEPARATORS, skipBodies, skipDouble, skipSubst, type Heredoc } from './scan'
import { liftAssigns } from './words'

// `op` is the connector text before the command ('&&', '||', ';', '|', newline, ...; '$(' inside a substitution).
// `unset`, `clear` and `chdir` carry an outer `env -u`/`env -i`/`env -C` into a `bash -c` script.
// `again` marks a loop body queued a second time for the back edge.
// `dyn[i]` marks a word of `argv` that is not literal: built from a variable or substitution, or an unquoted glob or brace.
// `input` holds the heredoc and here-string bodies the command reads; `outputs` the files it redirects output to.
export type Simple = {
  argv: string[]
  assigns: Record<string, string>
  op: string
  dyn?: boolean[]
  input?: string[]
  outputs?: string[]
  unset?: string[]
  clear?: boolean
  chdir?: string[]
  again?: boolean
}

export const MAX_DEPTH = 4

// A `$` that starts an expansion: `$NAME`, `${...}`, `$1`, `$@`, `$?` and the like.
const EXPANDS = /[A-Za-z_{0-9@*#?$!-]/

// Unquoted characters of a word that make the shell expand it: a glob or a brace list or sequence.
function isPattern(plain: string): boolean {
  return /[*?]/.test(plain) || /\[[^\]]*\]/.test(plain) || /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(plain)
}

// `opaque` names constructs the guard does not model (function definitions, arithmetic with substitutions).
export function tokenize(src: string, depth = 0): { cmds: Simple[]; ok: boolean; opaque: string[] } {
  const cmds: Simple[] = []
  const opaque: string[] = []
  let input: string[] = []
  let outputs: string[] = []
  let words: string[] = []
  let wdyn: boolean[] = []
  // `dyn`: the word so far has an expansion; `plain`: its unquoted characters.
  let dyn = false
  let plain = ''
  let nested: Simple[] = []
  let ok = true
  let cur = ''
  let inWord = false
  let i = 0
  let pending: Heredoc[] = []
  let sep = ''

  const endWord = () => {
    if (inWord) {
      words.push(cur)
      wdyn.push(dyn || isPattern(plain))
      cur = ''
      inWord = false
    }
    dyn = false
    plain = ''
  }
  // Substitutions run before the command that contains them.
  const endCmd = () => {
    endWord()
    cmds.push(...nested.map((c) => ({ ...c, op: '$(' })))
    nested = []
    if (words.length || outputs.length) {
      cmds.push({
        ...toSimple(words, wdyn, sep),
        ...(input.length || pending.some((hd) => hd.owner === input) ? { input } : {}),
        ...(outputs.length ? { outputs } : {}),
      })
      sep = ''
    }
    words = []
    wdyn = []
    input = []
    outputs = []
  }
  const sub = (inner: string) => {
    if (depth >= MAX_DEPTH) {
      ok = false
      return
    }
    const r = tokenize(inner, depth + 1)
    if (!r.ok) ok = false
    opaque.push(...r.opaque)
    nested.push(...r.cmds)
  }
  // Queues the substitutions of double-quoted or unquoted-heredoc text.
  const subsIn = (body: string) => {
    for (let j = 0; j < body.length; j++) {
      if (body[j] === '\\') {
        j++
      } else if (body[j] === '$' && EXPANDS.test(body[j + 1] ?? '')) {
        dyn = true
      } else if (body[j] === '$' && body[j + 1] === '(') {
        dyn = true
        const e = skipSubst(body, j + 1)
        if (e === -1) break
        if (body[j + 2] === '(' && arithEnd(body, j + 1) === e) {
          if (arithOpaque(body.slice(j + 3, e - 2))) opaque.push('arithmetic with a substitution or subscript')
        } else {
          sub(body.slice(j + 2, e - 1))
        }
        j = e - 1
      } else if (body[j] === '`') {
        dyn = true
        const close = body.indexOf('`', j + 1)
        if (close === -1) break
        sub(body.slice(j + 1, close))
        j = close
      }
    }
  }
  // Consumes one quoted, escaped or substituted piece of a word at `i`; false for a plain character.
  const part = (): boolean => {
    // A locale string `$"..."` is a double-quoted string to the guard: the `$` is not part of the word.
    if (src[i] === '$' && src[i + 1] === '"') i++
    const c = src[i]
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2
      } else if (i + 1 < src.length) {
        cur += src[i + 1]
        inWord = true
        i += 2
      } else {
        i++
      }
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1)
      inWord = true
      if (close === -1) {
        ok = false
        cur += src.slice(i + 1)
        i = src.length
      } else {
        cur += src.slice(i + 1, close)
        i = close + 1
      }
    } else if (c === '$' && src[i + 1] === "'") {
      const r = readAnsiC(src, i)
      inWord = true
      cur += r.text
      if (r.next === -1) {
        ok = false
        i = src.length
      } else {
        i = r.next
      }
    } else if (c === '"') {
      const end = skipDouble(src, i)
      inWord = true
      if (end === -1) {
        ok = false
        cur += src.slice(i + 1)
        i = src.length
      } else {
        const body = src.slice(i + 1, end - 1)
        cur += body
        subsIn(body)
        i = end
      }
    } else if (c === '$' && src[i + 1] === '(') {
      const end = skipSubst(src, i + 1)
      inWord = true
      dyn = true
      if (end === -1) {
        ok = false
        cur += src.slice(i)
        i = src.length
      } else {
        cur += src.slice(i, end)
        if (src[i + 2] === '(' && arithEnd(src, i + 1) === end) {
          if (arithOpaque(src.slice(i + 3, end - 2))) opaque.push('arithmetic with a substitution or subscript')
        } else {
          sub(src.slice(i + 2, end - 1))
        }
        i = end
      }
    } else if (c === '`') {
      const close = src.indexOf('`', i + 1)
      inWord = true
      dyn = true
      if (close === -1) {
        ok = false
        cur += src.slice(i)
        i = src.length
      } else {
        cur += src.slice(i, close + 1)
        sub(src.slice(i + 1, close))
        i = close + 1
      }
    } else {
      return false
    }
    return true
  }
  // Reads a redirection target or here-string; returns its text.
  const discardWord = (): string => {
    while (isSpace(src[i] ?? '')) i++
    const keep = { cur, inWord, dyn, plain }
    cur = ''
    inWord = false
    const from = i
    while (i < src.length && !isWordEnd(src[i]!)) {
      if (!part()) i++
    }
    const text = cur || src.slice(from, i)
    ;({ cur, inWord, dyn, plain } = keep)
    return text
  }

  while (i < src.length) {
    if (part()) continue
    const c = src[i]
    if (c === undefined) break
    if (isSpace(c)) {
      endWord()
      i++
    } else if (c === '\n') {
      endCmd()
      sep += '\n'
      i++
      if (pending.length) {
        i = skipBodies(src, i, pending, (hd, body) => {
          hd.owner?.push(body)
          if (!hd.quoted) {
            // An unquoted heredoc runs the substitutions in its body when the command starts.
            const keep = { dyn, nested }
            nested = []
            subsIn(body)
            cmds.push(...nested.map((c) => ({ ...c, op: '$(' })))
            ;({ dyn, nested } = keep)
          }
        })
        pending = []
      }
    } else if (c === '#' && !inWord) {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl
    } else if (c === '<' && src.startsWith('<<<', i)) {
      i += 3
      input.push(discardWord())
    } else if (c === '<' && src.startsWith('<<', i)) {
      i += 2
      const strip = src[i] === '-'
      if (strip) i++
      while (isSpace(src[i] ?? '')) i++
      const word = readWord(src, i)
      pending.push({ delim: word.text, strip, quoted: /["'\\]/.test(src.slice(i, word.next)), owner: input })
      i = word.next
    } else if ((c === '<' || c === '>') && src[i + 1] === '(') {
      // Process substitution: the inner command runs, and the word is a path the shell makes up.
      const end = skipSubst(src, i + 1)
      inWord = true
      dyn = true
      if (end === -1) {
        ok = false
        cur += src.slice(i)
        i = src.length
      } else {
        cur += src.slice(i, end)
        sub(src.slice(i + 2, end - 1))
        i = end
      }
    } else if (c === '(' && src[i + 1] === ')') {
      opaque.push('a function definition')
      endCmd()
      i += 2
    } else if (c === '(' && src[i + 1] === '(' && !inWord && !words.length && arithEnd(src, i) !== -1) {
      const end = arithEnd(src, i)
      if (arithOpaque(src.slice(i + 2, end - 2))) opaque.push('arithmetic with a substitution or subscript')
      endCmd()
      i = end
    } else if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      if (inWord && /^\d+$/.test(cur)) {
        cur = ''
        inWord = false
        dyn = false
        plain = ''
      } else {
        endWord()
      }
      const from = i
      while (i < src.length && (src[i] === '>' || src[i] === '<' || src[i] === '&' || src[i] === '|')) i++
      const op = src.slice(from, i)
      const target = discardWord()
      // `>&2` and `2>&1` duplicate a descriptor rather than open a file.
      if (op.includes('>') && !(op.endsWith('&') && /^(?:\d+|-)$/.test(target))) outputs.push(target)
    } else if (SEPARATORS.has(c)) {
      endCmd()
      while (i < src.length && SEPARATORS.has(src[i]!)) sep += src[i++]
    } else {
      if (c === '$' && EXPANDS.test(src[i + 1] ?? '')) dyn = true
      cur += c
      plain += c
      inWord = true
      i++
    }
  }
  endCmd()
  return { cmds, ok, opaque }
}

function toSimple(words: string[], dyn: boolean[], op: string): Simple {
  const { assigns, rest } = liftAssigns(words)
  return { argv: rest, assigns, op, dyn: dyn.slice(words.length - rest.length) }
}
