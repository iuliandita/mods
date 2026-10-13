import type { GitCall } from './calls'
import { createTracker, REAL, UNKNOWN, type Flow, type Possible, type Tracker } from './flow'
import { hasVariable, joinPath, resolvePath } from './paths'

// Process state as possibility sets: `dir` (UNKNOWN after a `cd` or `env -C` to a path built from a variable or
// substitution), `prev` for `cd -`, the pushd `stack` (JSON), and per variable: `env:NAME` what child processes see
// (REAL: not set by the command; a call's own prefix wins), `var:NAME` the shell value, and `x:NAME` the export
// attribute (EXPORTED or NOT_EXPORTED; REAL: as inherited, which the guard cannot tell). `allexport` is `set -a`.
// `env:NAME` holds UNSET after a shell `unset` or `export -n`: the variable is removed, not restored to the inherited value.
export const UNSET = '\0unset'
const EXPORTED = '1'
const NOT_EXPORTED = '0'
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type ProcState = { proc: Tracker<string>; names: Set<string>; startDir: string; home: string }

export function newProcState(startDir: string, home: string): ProcState {
  const proc = createTracker<string>((v) => v, (k) => (k === 'dir' || k === 'prev' ? [startDir] : k === 'stack' ? ['[]'] : [REAL]))
  return { proc, names: new Set<string>(), startDir, home }
}

export function parseStack(v: Possible<string>): (string | null)[] | null {
  return v === UNKNOWN ? null : v === REAL ? [] : (JSON.parse(v) as (string | null)[])
}

export function dirOf(st: ProcState, v: Possible<string>): string | null {
  return v === REAL ? st.startDir : v === UNKNOWN ? null : v
}

// `physical`: the OS resolves the path (`env -C`, `sudo -D`, `cd -P`), so `..` stays as written.
export function move(st: ProcState, from: string | null, target: string, physical = false): string | null {
  if (hasVariable(target)) return null
  const join = physical ? joinPath : resolvePath
  if (target.startsWith('/') || target === '~' || target.startsWith('~/')) return join('/', target, st.home)
  return from === null ? null : join(from, target, st.home)
}

export function setEnv(st: ProcState, k: string, v: Possible<string>, effect: Flow): void {
  st.names.add(k)
  st.proc.set(`env:${k}`, [v], effect)
}

type How = 'export' | 'unexport' | 'plain'

// One `NAME=V` or `NAME` word of an assignment, `export` or `declare`. `export` (and `declare -x`) exports the value;
// `export -n` (and `declare +x`) keeps it in the shell only, so children no longer see the name. A plain assignment
// reaches children only when the name is exported (an earlier export, `set -a`); whether an inherited name is
// exported cannot be told, so then both the new value and the environment before it stay possible.
function declareWord(st: ProcState, word: string, how: How, effect: Flow): void {
  const eq = word.indexOf('=')
  const k = eq === -1 ? word : word.slice(0, eq)
  if (!NAME.test(k)) return
  st.names.add(k)
  if (eq !== -1) st.proc.set(`var:${k}`, [word.slice(eq + 1)], effect)
  if (how === 'unexport') {
    st.proc.set(`x:${k}`, [NOT_EXPORTED], effect)
    st.proc.set(`env:${k}`, [UNSET], effect)
    return
  }
  if (how === 'export') {
    st.proc.set(`x:${k}`, [EXPORTED], effect)
    // `export NAME` exports the shell value the command set (REAL: whatever it inherited).
    st.proc.set(`env:${k}`, eq === -1 ? st.proc.get(`var:${k}`) : [word.slice(eq + 1)], effect)
    return
  }
  if (eq === -1) return
  const v = word.slice(eq + 1)
  const all = st.proc.get('allexport')
  const mayAll = all.some((s) => s === EXPORTED || s === UNKNOWN)
  const states = all.every((s) => s === EXPORTED) ? [EXPORTED] : [...st.proc.get(`x:${k}`), ...(mayAll ? [EXPORTED] : [])]
  const env = st.proc.get(`env:${k}`)
  st.proc.set(`env:${k}`, states.flatMap((s) => (s === EXPORTED ? [v] : s === NOT_EXPORTED ? env : [v, ...env])), effect)
  if (mayAll) st.proc.set(`x:${k}`, states, effect)
}

// A statement of only assignments (`A=v`, `A=v B=w`) sets shell variables.
export function applyAssign(st: ProcState, assigns: Record<string, string>, effect: Flow): void {
  for (const [k, v] of Object.entries(assigns)) declareWord(st, `${k}=${v}`, 'plain', effect)
}

// `export [-n] [-f] [-p] [--] WORDS`; `-f` names functions, which hold no state the guard follows.
export function applyExport(st: ProcState, argv: string[], effect: Flow): void {
  let how: How = 'export'
  let k = 1
  for (; k < argv.length && /^-[nfp]+$/.test(argv[k]!); k++) {
    if (argv[k]!.includes('f')) return
    if (argv[k]!.includes('n')) how = 'unexport'
  }
  if (argv[k] === '--') k++
  for (const a of argv.slice(k)) declareWord(st, a, how, effect)
}

// `set -a` (`-o allexport`) exports every later assignment; `set +a` stops it.
export function applySet(st: ProcState, argv: string[], effect: Flow): void {
  for (let k = 1; k < argv.length && /^[-+][A-Za-z]+$/.test(argv[k]!); k++) {
    const a = argv[k]!
    const on = a[0] === '-' ? EXPORTED : NOT_EXPORTED
    if (a.includes('a')) st.proc.set('allexport', [on], effect)
    if (a.includes('o') && argv[++k] === 'allexport') st.proc.set('allexport', [on], effect)
  }
}

// `unset -f` removes functions, which hold no state the guard follows; `-v`, `-n` and no option remove variables.
export function applyUnset(st: ProcState, argv: string[], effect: Flow): void {
  let functions = false
  let k = 1
  for (; k < argv.length && /^-[vfn]+$/.test(argv[k]!); k++) functions ||= argv[k]!.includes('f')
  if (argv[k] === '--') k++
  if (functions) return
  for (const a of argv.slice(k)) {
    setEnv(st, a, UNSET, effect)
    st.proc.set(`var:${a}`, [UNSET], effect)
    st.proc.set(`x:${a}`, [NOT_EXPORTED], effect)
  }
}

// `declare`, `typeset`, `local` and `readonly` with only -x -r -g -l -u set variables: exported with `-x`, unexported
// with `+x`, otherwise shell variables only. Returns why the call cannot be followed (another flag, or a word built
// from a variable).
export function applyDeclare(st: ProcState, argv: string[], dyn: boolean[], effect: Flow): string | undefined {
  let how: How = 'plain'
  let k = 1
  for (; k < argv.length && /^[-+]/.test(argv[k]!); k++) {
    if (argv[k] === '--') {
      k++
      break
    }
    if (!/^[-+][xrglu]+$/.test(argv[k]!)) return `${argv[0]} ${argv[k]}`
    if (argv[k]!.includes('x')) how = argv[k]![0] === '-' ? 'export' : 'unexport'
  }
  if (dyn.slice(1).some(Boolean)) return `${argv[0]} with a word built from a variable or substitution`
  for (const a of argv.slice(k)) declareWord(st, a, how, effect)
  return undefined
}

// `here` maps a possible directory to the one the command runs in (`env -C` moves it).
export function applyCd(st: ProcState, argv: string[], here: (d: Possible<string>) => string | null, loop: boolean, effect: Flow): void {
  const dirs = st.proc.get('dir')
  const target = argv.slice(1).find((a) => a === '-' || (a !== '--' && !a.startsWith('-')))
  const physical = argv.slice(1).some((a) => /^-[LPe@]*P[e@]*$/.test(a))
  const relative = target !== undefined && target !== '-' && !/^(?:\/|~$|~\/)/.test(target)
  const to: Possible<string>[] =
    target === undefined
      ? [st.home]
      : target === '-'
        ? st.proc.get('prev')
        : dirs.map((d) => (loop && relative ? UNKNOWN : (move(st, here(d), target, physical) ?? UNKNOWN)))
  st.proc.set('prev', dirs, effect)
  st.proc.set('dir', to, effect)
}

// `pushd DIR` stacks the current directory and moves; bare `pushd` swaps the top two; `-n DIR` only stacks DIR;
// `+N`/`-N` rotate the stack, which is not followed (the directory becomes unknown).
export function applyPushd(st: ProcState, argv: string[], here: (d: Possible<string>) => string | null, loop: boolean, effect: Flow): void {
  const words = argv.slice(1).filter((a) => a !== '--')
  const noCd = words.includes('-n')
  const target = words.find((a) => a !== '-n')
  const dirs = st.proc.get('dir')
  if (target !== undefined && /^[+-]\d+$/.test(target)) {
    st.proc.set('prev', dirs, effect)
    st.proc.set('dir', [UNKNOWN], effect)
    st.proc.set('stack', [UNKNOWN], effect)
    return
  }
  if (target === undefined) {
    if (noCd) return
    const to: Possible<string>[] = []
    const after: Possible<string>[] = []
    for (const v of st.proc.get('stack')) {
      const s = parseStack(v)
      for (const d of dirs) {
        if (s === null) {
          to.push(UNKNOWN)
          after.push(UNKNOWN)
        } else if (!s.length) {
          // Bare pushd fails on an empty stack and nothing moves.
          to.push(d)
          after.push(v)
        } else {
          to.push(s[s.length - 1] ?? UNKNOWN)
          after.push(JSON.stringify([...s.slice(0, -1), dirOf(st, d)]))
        }
      }
    }
    st.proc.set('prev', dirs, effect)
    st.proc.set('dir', to, effect)
    st.proc.set('stack', after, effect)
    return
  }
  if (noCd) {
    const added = st.proc.get('stack').flatMap((v): Possible<string>[] => {
      const s = parseStack(v)
      return s === null ? [UNKNOWN] : dirs.map((d) => JSON.stringify([...s, move(st, here(d), target)]))
    })
    st.proc.set('stack', added, effect)
    return
  }
  const stacks = st.proc.get('stack').flatMap((v): Possible<string>[] => {
    const s = parseStack(v)
    return s === null ? [UNKNOWN] : dirs.map((d) => JSON.stringify([...s, dirOf(st, d)]))
  })
  st.proc.set('stack', stacks, effect)
  applyCd(st, ['pushd', target], here, loop, effect)
}

// Git config an earlier call of the command may have written, which the guard's lookups (taken before the command
// runs) do not see. `config`: any key, so the identity and push configuration; `upstream`: a branch's upstream.
// Set whether or not the writing call surely runs, and kept to the end of the command, since config is on disk.
export type ConfigTaint = { config: boolean; upstream: boolean }

const CONFIG_READ_OPTS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--get-color', '--get-colorbool'])
const CONFIG_BOOL_OPTS = new Set([
  '--global', '--system', '--local', '--worktree', '--show-origin', '--show-scope', '--null', '-z', '--name-only', '--includes', '--no-includes',
  '--bool', '--int', '--bool-or-int', '--path', '--expiry-date', '--all', '--regexp', '--fixed-value',
])
const CONFIG_VALUE_OPTS = new Set(['-f', '--file', '--blob', '--type', '--default', '--url'])

// Only a recognised read (`git config k`, `--get`, `--list`, `get`, `list`) leaves config alone; any other form may write.
function configWrites(args: string[]): boolean {
  const positional: string[] = []
  let read = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const key = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a
    if (CONFIG_READ_OPTS.has(key)) read = true
    else if (CONFIG_VALUE_OPTS.has(key)) i += key === a ? 1 : 0
    else if (CONFIG_BOOL_OPTS.has(key)) continue
    else if (a.startsWith('-')) return true
    else positional.push(a)
  }
  if (positional[0] === 'get' || positional[0] === 'list') return false
  // A key has a dot; a single word without one is a subcommand (`git config edit`).
  return !(read || (positional.length === 1 && positional[0]!.includes('.')))
}

// `remote add` and `set-url` change where a remote points, not which branch a push updates, so they do not taint.
export function taintConfig(t: ConfigTaint, call: GitCall): ConfigTaint {
  const { sub, args } = call
  const opts = args.slice(0, args.includes('--') ? args.indexOf('--') : undefined)
  if (sub === 'config' && configWrites(args)) return { config: true, upstream: true }
  // A checkout or switch with a start point (`-c x origin/main`) may set the upstream through branch.autoSetupMerge.
  const upstream =
    (sub === 'branch' && opts.some((a) => /^(?:--set-upstream-to(?:=|$)|--unset-upstream$|--track(?:=|$)|-[vqfrali]*[ut])/.test(a))) ||
    (sub === 'push' && opts.some((a) => a === '--set-upstream' || /^-[fnqvd4-6]*u/.test(a))) ||
    ((sub === 'checkout' || sub === 'switch') && (opts.some((a) => /^(?:--track(?:=|$)|-[qfmld]*t)/.test(a)) || opts.filter((a) => !a.startsWith('-')).length > 1))
  return upstream ? { ...t, upstream: true } : t
}

// `popd [-n] [+N|-N]` removes entry N of `dirs` (0 is the current directory, `-N` counts from the right) and moves
// only when that entry is 0; `-n` never moves and removes entry 1 for 0. Out of range, it fails and nothing changes.
export function applyPopd(st: ProcState, argv: string[], dyn: boolean[], effect: Flow): void {
  const dirs = st.proc.get('dir')
  const prev = st.proc.get('prev')
  let noCd = false
  let index: string | undefined
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k]!
    if (dyn[k]) index = '?'
    else if (a === '-n') noCd = true
    else if (/^[+-]\d+$/.test(a)) index = a
    else if (a !== '--') return
  }
  // A known `+N` above 0 or `-n` keeps the directory; any other index the guard cannot tell may move it.
  const stays = noCd || (index !== undefined && index !== '?' && index[0] === '+' && Number(index.slice(1)) > 0)
  const to: Possible<string>[] = []
  const after: Possible<string>[] = []
  const prevs: Possible<string>[] = []
  for (const v of st.proc.get('stack')) {
    const s = parseStack(v)
    if (s === null || index === '?') {
      if (stays) to.push(...dirs)
      else to.push(UNKNOWN)
      after.push(UNKNOWN)
      prevs.push(...prev, ...(stays ? [] : dirs))
      continue
    }
    const size = s.length + 1
    let at = index === undefined ? 0 : index[0] === '+' ? Number(index.slice(1)) : size - 1 - Number(index.slice(1))
    if (noCd && at === 0) at = 1
    if (at < 0 || at >= size || size === 1) {
      to.push(...dirs)
      after.push(v)
      prevs.push(...prev)
    } else if (at === 0) {
      to.push(s[s.length - 1] ?? UNKNOWN)
      after.push(JSON.stringify(s.slice(0, -1)))
      prevs.push(...dirs)
    } else {
      to.push(...dirs)
      after.push(JSON.stringify(s.filter((_, i) => i !== size - 1 - at)))
      prevs.push(...prev)
    }
  }
  st.proc.set('prev', prevs, effect)
  st.proc.set('dir', to, effect)
  st.proc.set('stack', after, effect)
}
