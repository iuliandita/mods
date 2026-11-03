import { type Simple } from './lex'
import { basename } from './paths'
import { ASSIGN, liftAssigns } from './words'

const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'do', 'else', 'elif', 'while', 'until', 'builtin', 'nohup'])
export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const SHELL_LONG = new Set(['--norc', '--noprofile', '--posix', '--login', '--restricted', '--verbose', '--noediting', '--debugger', '--dump-strings', '--dump-po-strings', '--pretty-print', '--help', '--version'])
const SHELL_LONG_VALUE = new Set(['--rcfile', '--init-file'])
// Wrapper -> short option letters and long options that take a separate value; `skip` counts positionals before
// the command; `chdir` names the option that sets the directory the command runs in; `shell` the flags that run
// the command words through a shell (`sudo -s 'git push'`).
const WRAPPERS: Record<string, { short: string; long?: string[]; skip?: number; chdir?: { short: string; long: string }; shell?: { short: string; long: string[] } }> = {
  sudo: {
    short: 'acCDgprRtTUu',
    long: ['--user', '--group', '--close-from', '--chdir', '--host', '--prompt', '--role', '--type', '--command-timeout', '--other-user', '--chroot'],
    chdir: { short: 'D', long: '--chdir' },
    shell: { short: 'is', long: ['--shell', '--login'] },
  },
  doas: { short: 'Cu' },
  nice: { short: 'n', long: ['--adjustment'] },
  time: { short: 'fo', long: ['--format', '--output'] },
  timeout: { short: 'sk', long: ['--signal', '--kill-after'], skip: 1 },
  stdbuf: { short: 'ioe', long: ['--input', '--output', '--error'] },
  ionice: { short: 'cnpPu', long: ['--class', '--classdata', '--pid', '--pgid', '--uid'] },
  chronic: { short: '' },
  setsid: { short: '' },
  command: { short: '' },
  exec: { short: 'a' },
}

const ENV_VALUE_SHORT = 'uCSaPL'
const ENV_VALUE_LONG = new Set(['--unset', '--chdir', '--split-string', '--argv0', '--path'])
const ENV_ESCAPES: Record<string, string> = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '#': '#', $: '$', '"': '"', "'": "'", '\\': '\\' }

// Splits an `env -S` string as GNU env does: `\_` separates words outside quotes, `\c` ends the string, and
// `${NAME}` expands (a `dyn` word). `ok` is false for a string env rejects or the guard cannot follow.
function splitEnvString(s: string): { words: string[]; dyn: boolean[]; ok: boolean } {
  const words: string[] = []
  const dyn: boolean[] = []
  let cur = ''
  let inWord = false
  let d = false
  let quote = ''
  const end = () => {
    if (inWord) {
      words.push(cur)
      dyn.push(d)
    }
    cur = ''
    inWord = false
    d = false
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote === "'") {
      if (c === "'") quote = ''
      else if (c === '\\' && (s[i + 1] === "'" || s[i + 1] === '\\')) cur += s[++i]
      else cur += c
    } else if (c === '\\') {
      const n = s[++i]
      if (n === '_' && !quote) {
        end()
        continue
      }
      if (n === '_') cur += ' '
      else if (n === 'c' && !quote) break
      else if (n !== undefined && Object.hasOwn(ENV_ESCAPES, n)) cur += ENV_ESCAPES[n]!
      else return { words, dyn, ok: false }
      inWord = true
    } else if (c === '$') {
      if (s[i + 1] !== '{') return { words, dyn, ok: false }
      cur += c
      d = inWord = true
    } else if (c === '"' || (c === "'" && !quote)) {
      quote = quote ? '' : c
      inWord = true
    } else if (!quote && /\s/.test(c)) {
      end()
    } else if (!quote && c === '#' && !inWord) {
      break
    } else {
      cur += c
      inWord = true
    }
  }
  if (quote) return { words, dyn, ok: false }
  end()
  return { words, dyn, ok: true }
}

// `opaque` names why the wrapped command cannot be followed.
type Dropped = { unset: Set<string>; clear: boolean; chdir: string[]; opaque: string[] }

// `env` options and assignments; `-u` and `-i` drop assignments, and an `-S STRING` is split into words that
// are parsed again as env arguments.
function unwrapEnv(argv0: string[], dyn0: boolean[], assigns: Record<string, string>, dropped: Dropped): { argv: string[]; dyn: boolean[] } {
  let argv = argv0
  let dyn = dyn0
  let splits = 0
  const clear = () => {
    for (const key of Object.keys(assigns)) delete assigns[key]
    dropped.clear = true
  }
  let k = 1
  while (k < argv.length) {
    const w = argv[k]!
    let opt = ''
    let value = ''
    if (w === '--') {
      k++
      break
    } else if (w === '-') {
      clear()
      k++
    } else if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      opt = eq === -1 ? w : w.slice(0, eq)
      if (eq !== -1) value = w.slice(eq + 1)
      else if (ENV_VALUE_LONG.has(opt)) value = argv[++k] ?? ''
      if (opt === '--ignore-environment') clear()
      k++
    } else if (w.startsWith('-') && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        if (w[j] === 'i') clear()
        if (!ENV_VALUE_SHORT.includes(w[j]!)) continue
        opt = w[j]!
        value = j + 1 < w.length ? w.slice(j + 1) : (argv[++k] ?? '')
        break
      }
      k++
    } else if (ASSIGN.test(w)) {
      const eq = w.indexOf('=')
      assigns[w.slice(0, eq)] = w.slice(eq + 1)
      k++
    } else break
    if (opt === 'P' || opt === '--path') dropped.opaque.push('an env command search path')
    else if (opt === 'u' || opt === '--unset') {
      delete assigns[value]
      dropped.unset.add(value)
    } else if (opt === 'C' || opt === '--chdir') {
      dropped.chdir.push(value)
    } else if ((opt === 'S' || opt === '--split-string') && splits++ < 16) {
      const split = splitEnvString(value)
      // The string is the word just consumed; one built from a variable or substitution cannot be split.
      if (!split.ok || dyn[k - 1]) dropped.opaque.push('an env -S string the guard cannot follow')
      argv = ['env', ...split.words, ...argv.slice(k)]
      dyn = [false, ...split.dyn, ...dyn.slice(k)]
      k = 1
    }
  }
  return { argv: argv.slice(k), dyn: dyn.slice(k) }
}

// Index of the wrapped command after a wrapper's options, getopt style (`-iu root`, `-ubob`, `--user root`);
// the values of the spec's `chdir` options are appended to `chdir`. `shell` is set by one of the spec's `shell` flags.
function skipOptions(argv: string[], spec: (typeof WRAPPERS)[string], chdir: string[]): { at: number; shell: boolean } {
  let k = 1
  let shell = false
  while (k < argv.length) {
    const w = argv[k]!
    if (w === '--') {
      k++
      break
    }
    if (!w.startsWith('-') || w === '-') break
    k++
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      const key = eq === -1 ? w : w.slice(0, eq)
      if (spec.shell?.long.includes(key)) shell = true
      if (key === spec.chdir?.long) chdir.push(eq === -1 ? (argv[k] ?? '') : w.slice(eq + 1))
      if (eq === -1 && spec.long?.includes(w)) k++
      continue
    }
    for (let j = 1; j < w.length; j++) {
      if (spec.shell?.short.includes(w[j]!)) shell = true
      if (!spec.short.includes(w[j]!)) continue
      if (w[j] === spec.chdir?.short) chdir.push(j === w.length - 1 ? (argv[k] ?? '') : w.slice(j + 1))
      if (j === w.length - 1) k++
      break
    }
  }
  return { at: k + (spec.skip ?? 0), shell }
}

// Strips wrappers (env, the WRAPPERS table, rtk, keywords) from the front of a command, with the assignments
// after a keyword (`then X=1 cmd`). `negated` means a `!` was stripped; `bare` that only keywords were. `dyn` follows `argv`.
export function unwrap(s: Simple): { argv: string[]; dyn: boolean[]; assigns: Record<string, string>; negated: boolean; bare: boolean } & Dropped {
  let argv = s.argv
  let dyn = s.dyn ?? argv.map(() => false)
  const assigns = { ...s.assigns }
  const dropped: Dropped = { unset: new Set(s.unset), clear: s.clear ?? false, chdir: [...(s.chdir ?? [])], opaque: [] }
  const keep = (rest: string[]) => {
    dyn = dyn.slice(argv.length - rest.length)
    argv = rest
  }
  let negated = false
  let bare = true
  for (let guard = 0; guard < 16 && argv.length; guard++) {
    const head = basename(argv[0]!)
    if (KEYWORDS.has(argv[0]!)) {
      if (argv[0] === '!') negated = true
      const lifted = liftAssigns(argv.slice(1))
      Object.assign(assigns, lifted.assigns)
      keep(lifted.rest)
      continue
    }
    bare = false
    if (head === 'env') {
      ;({ argv, dyn } = unwrapEnv(argv, dyn, assigns, dropped))
    } else if (head === 'rtk') {
      keep(argv.slice(argv[1] === 'proxy' ? 2 : 1))
    } else if (Object.hasOwn(WRAPPERS, head)) {
      const r = skipOptions(argv, WRAPPERS[head]!, dropped.chdir)
      keep(argv.slice(r.at))
      // The shell runs the command words joined into one script; one built from a variable stays dynamic.
      if (r.shell && argv.length) {
        dyn = [false, false, dyn.some(Boolean)]
        argv = ['sh', '-c', argv.join(' ')]
      }
    } else {
      break
    }
  }
  return { argv, dyn, assigns, negated, bare, ...dropped }
}

// Where `bash -c` finds its script: the first word after the options, at `at`. `stdin` means no -c and no script file.
export function shellScript(argv: string[]): { ok: boolean; script?: string; at?: number; stdin?: boolean } {
  let c = false
  let s = false
  let k = 1
  for (; k < argv.length; k++) {
    const w = argv[k]!
    if (w === '--' || w === '-') {
      k++
      break
    }
    if (w.startsWith('--')) {
      if (SHELL_LONG_VALUE.has(w)) k++
      else if (!SHELL_LONG.has(w)) return { ok: false }
    } else if (/^[-+][A-Za-z]+$/.test(w)) {
      if (w[0] === '-' && w.includes('c')) c = true
      if (w[0] === '-' && w.includes('s')) s = true
      k += (w.match(/[oO]/g) ?? []).length
    } else if (w.startsWith('-') || w.startsWith('+')) {
      return { ok: false }
    } else break
  }
  const first = argv[k]
  if (c) return first === undefined ? { ok: false } : { ok: true, script: first, at: k }
  return { ok: true, at: k, stdin: s || first === undefined }
}
