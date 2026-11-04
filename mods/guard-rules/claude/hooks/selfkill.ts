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

function matches(pattern: string, ignoreCase: boolean, texts: string[]): boolean {
  let re: RegExp | null = null
  try {
    re = new RegExp(pattern, ignoreCase ? 'i' : '')
  } catch {
    // An ERE form JavaScript rejects (`[[:alpha:]]`, `\<`): fall back to the pattern as plain text.
  }
  return texts.some((t) => (re ? re.test(t) : t.includes(pattern)))
}

function scan(script: string, whole: string, depth: number, out: Set<string>): void {
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
    if (matches(p.pattern, p.ignoreCase, [`sh -c ${whole}`, `sh -c ${script}`])) out.add(p.pattern)
  }
}

const SAFE_FORMS =
  'Match the process name with `pkill -x <name>`, anchor the pattern (`^bun run dev$`), write one letter as a class (`[v]ite`) so the command text no longer matches, or kill by PID (a pidfile or `pgrep -x`).'

export function selfKillViolations(command: string, mode: Mode): Violation[] {
  if (mode === 'off' || !SELF_KILL_HINT.test(command)) return []
  const hits = new Set<string>()
  scan(command, command, 0, hits)
  return [...hits].map((pattern) => ({
    rule: 'selfkill',
    mode,
    message: `selfkill: \`pkill -f ${JSON.stringify(pattern)}\` also matches the shell running this command, so it would kill that shell (exit 144). ${SAFE_FORMS}`,
  }))
}
