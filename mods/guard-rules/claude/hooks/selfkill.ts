import { tokenize, MAX_DEPTH } from './lex'
import { basename } from './paths'
import type { Mode, Violation } from './rules'
import { SHELLS, shellScript, unwrap } from './wrappers'

// `pkill -f` matches every process's full command line, and the shell that runs the command carries the whole
// command text in its own. A pattern that matches that text kills the shell (the tool reports exit 144).
const VALUE_SHORT = new Set(['g', 'G', 'P', 's', 't', 'u', 'U', 'F'])
const VALUE_LONG = new Set(['--pgroup', '--group', '--parent', '--session', '--terminal', '--euid', '--uid', '--pidfile', '--signal', '--ns', '--nslist'])

export const SELF_KILL_HINT = /\bpkill\b/

// What the pkill command line holds: the option letters seen and the pattern (undefined when it is not a literal word).
function parsePkill(argv: string[], dyn: boolean[]): { full: boolean; exact: boolean; ignoreCase: boolean; pattern?: string } | null {
  let full = false
  let exact = false
  let ignoreCase = false
  let k = 1
  for (; k < argv.length; k++) {
    const w = argv[k]!
    if (w === '--') {
      k++
      break
    }
    if (!w.startsWith('-') || w === '-') break
    if (w.startsWith('--')) {
      const key = w.includes('=') ? w.slice(0, w.indexOf('=')) : w
      if (key === '--full') full = true
      else if (key === '--exact') exact = true
      else if (key === '--ignore-case') ignoreCase = true
      else if (VALUE_LONG.has(key) && !w.includes('=')) k++
      continue
    }
    if (/^-(?:\d+|[A-Z][A-Z0-9]{2,})$/.test(w)) continue
    // A cluster of flags; a value flag takes the rest of the cluster or the next word.
    for (let j = 1; j < w.length; j++) {
      const c = w[j]!
      if (c === 'f') full = true
      else if (c === 'x') exact = true
      else if (c === 'i') ignoreCase = true
      else if (VALUE_SHORT.has(c)) {
        if (j === w.length - 1) k++
        break
      }
    }
  }
  const word = argv[k]
  if (word === undefined) return null
  return { full, exact, ignoreCase, pattern: dyn[k] ? undefined : word }
}

// The pattern comes from the command being judged, so it must not be able to stall the guard in a backtracking
// engine: a long or long-text match, a back-reference, a nested quantifier or more than two unbounded quantifiers is
// not run and counts as a hit instead (fail closed).
const MAX_PATTERN = 200
const MAX_TEXT = 20_000

function complex(pattern: string, text: string): boolean {
  if (pattern.length > MAX_PATTERN || text.length > MAX_TEXT || /\\[1-9]/.test(pattern)) return true
  const flat = pattern.replace(/\\./g, '').replace(/\[\^?\]?[^\]]*\]/g, '')
  return (flat.match(/[*+]|\{\d*,\d*\}/g) ?? []).length > 2 || /[*+?{].*\)[*+{]/s.test(flat)
}

type Hit = 'match' | 'complex'

function check(pattern: string, ignoreCase: boolean, texts: string[]): Hit | null {
  if (texts.some((t) => complex(pattern, t))) return 'complex'
  let re: RegExp | null = null
  try {
    re = new RegExp(pattern, ignoreCase ? 'i' : '')
  } catch {
    // An ERE form JavaScript rejects (`[[:alpha:]]`, `\<`): fall back to the pattern as plain text.
  }
  return texts.some((t) => (re ? re.test(t) : t.includes(pattern))) ? 'match' : null
}

function scan(script: string, whole: string, depth: number, out: Map<string, Hit>): void {
  if (depth > MAX_DEPTH) return
  const parsed = tokenize(script)
  for (const cmd of parsed.cmds) {
    const u = unwrap(cmd)
    if (!u.argv.length) continue
    const head = basename(u.argv[0]!)
    if (SHELLS.has(head)) {
      const s = shellScript(u.argv)
      if (s.ok && s.script !== undefined) scan(s.script, whole, depth + 1, out)
      continue
    }
    if (head !== 'pkill') continue
    const p = parsePkill(u.argv, u.dyn)
    if (!p || !p.full || p.exact || p.pattern === undefined) continue
    // The shell's command line is the shell name, `-c`, then the command text.
    const hit = check(p.pattern, p.ignoreCase, [`sh -c ${whole}`, `sh -c ${script}`])
    if (hit) out.set(p.pattern, hit)
  }
}

const SAFE_FORMS =
  'Match the process name with `pkill -x <name>`, anchor the pattern (`^bun run dev$`), write one letter as a class (`[v]ite`) so the command text no longer matches, or kill by PID (a pidfile or `pgrep -x`).'

export function selfKillViolations(command: string, mode: Mode): Violation[] {
  if (mode === 'off' || !SELF_KILL_HINT.test(command)) return []
  const hits = new Map<string, Hit>()
  scan(command, command, 0, hits)
  return [...hits].map(([pattern, hit]) => ({
    rule: 'selfkill',
    mode,
    message:
      hit === 'match'
        ? `selfkill: \`pkill -f ${JSON.stringify(pattern)}\` also matches the shell running this command, so it would kill that shell (exit 144). ${SAFE_FORMS}`
        : `selfkill: the pattern of \`pkill -f ${JSON.stringify(pattern.length > 60 ? `${pattern.slice(0, 60)}...` : pattern)}\` is too complex to check against the shell running this command, which it may kill (exit 144). ${SAFE_FORMS}`,
  }))
}
