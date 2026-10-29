import { REAL, UNKNOWN, type Flow, type Possible } from './flow'
import { INFRA_TOOLS, parseGh, parseGit, parseInfra, SECRET_PLACEHOLDER, type Call, type InfraTool } from './calls'
import { tokenize, type Simple } from './lex'
import { basename, hasVariable } from './paths'
import { applyAssign, applyCd, applyDeclare, applyExport, applyPopd, applyPushd, applySet, applyUnset, dirOf, move, newProcState, UNSET, type ProcState } from './state'
import { IDENTITY_ENV, isDataWord, mayName, READ_ENV, toolWords } from './words'
import { SHELLS, shellScript, unwrap } from './wrappers'

// `opaque` lists constructs the guard does not model anywhere in the command (unparsed when the text names a
// tool); `local` lists commands it does not model that name a tool among their own words (unparsed by themselves).
export type Local = { why: string; tools: string[] }
export type Parsed = { calls: Call[]; ok: boolean; opaque: string[]; local: Local[] }

// A command the guard does not look through that names one of these later runs it in a way the guard cannot follow
// (xargs, flock, `find -exec`, `direnv exec`, `su -c '...'`), unless the head only prints or searches text.
const OPAQUE_TOOLS = new Set(['git', 'gh', 'glab', 'tea', 'fj', 'kubectl', 'helm', 'terraform', 'tofu', ...SHELLS])
// `cat` only copies its input, so a commit message heredoc (`"$(cat <<'EOF' ...)"`) that names a tool stays data.
const TEXT_HEADS = new Set(['echo', 'printf', 'man', 'which', 'type', 'grep', 'rg', 'cat'])
const DATA_HEADS = new Set(['ls', 'mkdir', 'rmdir', 'touch', 'cp', 'mv', 'rm', 'head', 'tail', 'wc', 'tee', 'curl', 'basename', 'dirname', 'realpath', 'readlink', 'file', 'stat', 'du', 'df', 'cut', 'uniq', 'diff', 'cmp'])
const INPUT_EXECUTORS = new Set(['xargs', ...SHELLS, 'awk', 'gawk', 'mawk', 'perl', 'ruby', 'node', 'env', 'parallel', 'watch', 'script', 'ssh', 'php', 'lua', 'tclsh', 'at', 'crontab', 'batch'])
const SED_FLAGS = new Set(['-n', '--quiet', '--silent', '-E', '-r', '--regexp-extended'])
// Shell constructs the guard does not follow: code defined here and run later, or a branch it does not model.
const STRUCTURES: Record<string, string> = {
  case: 'a case statement',
  select: 'a select loop',
  coproc: 'a coprocess',
  trap: 'a trap',
  alias: 'an alias',
  function: 'a function definition',
  hash: 'a changed command hash table',
  enable: 'a changed shell builtin',
}
// Commands the guard models that only test or iterate: their words name tools as data.
const FLOW_HEADS = new Set(['[', '[[', 'test', 'for', 'true', 'false', ':'])
const SINGLE_PIPE = /(?:^|[^|])\|(?:[^|]|$)/
const SINGLE_AMP = /(?:^|[^&])&(?:[^&]|$)/
const MAX_FANOUT = 16
const MAX_QUEUE = 4000
const DECLARES = new Set(['declare', 'typeset', 'local', 'readonly'])
const SUBST_TEXT = /[$<>]\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|`[^`]*`/g
// Variables that change how the shell or git reads every later word.
const SHELL_ENV = new Set(['IFS', 'BASH_ENV', 'ENV', 'GIT_CONFIG_PARAMETERS'])
// Values these programs can interpret as commands or command options, including exported settings.
const EXEC_ENV = /^(?:PAGER|MANPAGER|LESS(?:OPEN|CLOSE)?|EDITOR|VISUAL|BROWSER|MANOPT|SHELL|GIT_.*|.*_(?:PAGER|EDITOR|BROWSER))$/
const DYNAMIC = 'built from a variable, substitution or glob'
const PLAIN_WORD = /^[\w./+@%:,=~-]+$/
// Commands that switch the kube context, or rewrite what a context points at, in a kubeconfig the guard read before
// the command ran: each row is the words that must all appear after the command name (empty: any arguments).
// A pipe separates documented aliases for one word. These are conservative matches, not full CLI parsers.
const KUBE_SWITCHERS: Record<string, string[][]> = {
  kubectx: [[]],
  'kubectl-ctx': [[]],
  kubens: [[]],
  aws: [['eks', 'update-kubeconfig']],
  gcloud: [['get-credentials'], ['container', 'clusters', 'create|create-auto']],
  az: [['aks|fleet|aksarc', 'get-credentials'], ['connectedk8s', 'proxy']],
  doctl: [['kubernetes|kube|k8s|k', 'cluster|clusters|c', 'kubeconfig|kubecfg|k8scfg|config|cfg', 'save|s'], ['kubernetes|kube|k8s|k', 'cluster|clusters|c', 'create']],
  oc: [['login'], ['project'], ['new-project'], ['config']],
  kind: [['export', 'kubeconfig'], ['create', 'cluster']],
  minikube: [['update-context'], ['start'], ['profile']],
  k3d: [['kubeconfig', 'merge|write'], ['cluster', 'create']],
  eksctl: [['create', 'cluster'], ['utils', 'write-kubeconfig']],
  tsh: [['kube', 'login']],
  vcluster: [['connect|create']],
  talosctl: [['kubeconfig']],
  scw: [['k8s', 'kubeconfig', 'install']],
  ibmcloud: [['ks', 'cluster', 'config']],
  civo: [['kubernetes', 'config']],
}
const KUBECTX_READ = new Set(['-c', '--current', '-h', '--help'])
const OC_CONFIG_READ = new Set(['view', 'get-contexts', 'current-context', 'get-clusters', 'get-users'])
// Operand paths are conservative: even a source can name a file whose lookup may become stale.
const FILE_WRITERS = new Set(['cp', 'mv', 'ln', 'install', 'rsync', 'tee', 'truncate', 'dd', 'scp', 'sponge'])
const INPLACE_WRITERS = new Set(['sed', 'perl', 'yq', 'sops'])
const FILE_OUTPUT_OPTIONS: Record<string, string[]> = {
  cp: ['-t', '--target-directory', '--target'],
  mv: ['-t', '--target-directory', '--target'],
  ln: ['-t', '--target-directory', '--target'],
  install: ['-t', '--target-directory', '--target'],
  curl: ['-o', '--output'],
  wget: ['-O', '--output-document'],
  sops: ['--output'],
  gpg: ['-o', '--output'],
  age: ['-o', '--output'],
}
const KUBE_FILE = /(?:^|\/)\.kube(?:\/|$)|kubeconfig/i
const WORKSPACE_FILE = /(?:^|\/)\.terraform(?:\/environment)?\/?$/

// The walk over the queued commands: `chain` and `depth` follow the connectors, `loops` the open `do` bodies.
// `kube` and `workspace` are set once an earlier command may have switched the kube context or terraform workspace
// out of the guard's sight; `written` holds the base names of files earlier commands wrote.
type Walk = {
  queue: Simple[]
  calls: Call[]
  st: ProcState
  opaque: string[]
  local: Local[]
  chain: number
  joinNext: boolean
  depth: number
  loops: number[]
  kube: boolean
  workspace: boolean
  written: Set<string>
}

// One command after unwrapping, with how surely it runs.
type Step = {
  cmd: Simple
  idx: number
  u: ReturnType<typeof unwrap>
  argv: string[]
  dyn: boolean[]
  name: string
  sure: boolean
  loop: boolean
  effect: Flow
  here: (d: Possible<string>) => string | null
}

function mark(w: Walk, why: string): void {
  if (!w.opaque.includes(why)) w.opaque.push(why)
}

// Follows the connector before `cmd`: a new chain at anything but `&&` (and `then`), and the subshell depth.
function advance(w: Walk, cmd: Simple): void {
  const raw = cmd.argv[0]
  // `then` runs only when the condition succeeded, so it continues the condition's chain like `&&`.
  if (cmd.op !== '&&' && cmd.op !== '$(' && raw !== 'then' && !w.joinNext) w.chain++
  w.joinNext = raw === 'then' && cmd.argv.length === 1
  if (cmd.op !== '$(') for (const ch of cmd.op) w.depth = Math.max(0, w.depth + (ch === '(' ? 1 : ch === ')' ? -1 : 0))
}

// At `done`, queues the loop body once more for the back edge: it runs again after any state it changed.
function expandLoop(w: Walk, cmd: Simple, idx: number): void {
  const raw = cmd.argv[0]
  if (raw === 'do') w.loops.push(idx)
  if (raw !== 'done' || !w.loops.length) return
  const start = w.loops.pop()!
  if (!cmd.again && w.queue.length < MAX_QUEUE) w.queue.splice(idx + 1, 0, ...w.queue.slice(start, idx + 1).map((c, i) => ({ ...c, op: i === 0 ? ';' : c.op, again: true })))
  else if (!cmd.again) mark(w, 'a loop too large to follow')
}

function flowOf(w: Walk, cmd: Simple, idx: number): Step {
  const u = unwrap(cmd)
  let nextOp = ''
  for (let j = idx + 1; j < w.queue.length; j++) {
    if (w.queue[j]!.op === '$(') continue
    nextOp = w.queue[j]!.op
    break
  }
  const loop = w.loops.length > 0
  // A call after `||`, inside a substitution, negated, in a pipeline, in the background or in a loop may not
  // run, or may run while its failure lets the chain go on.
  const sure = !cmd.op.includes('||') && cmd.op !== '$(' && !u.negated && !SINGLE_PIPE.test(cmd.op) && !SINGLE_PIPE.test(nextOp) && !SINGLE_AMP.test(nextOp) && !loop
  // Process state does not leak out of a `( ... )` subshell.
  const effect: Flow = { chain: w.chain, certain: sure && w.depth === 0, loop }
  // The directory this command runs in (`env -C` moves it); a call in an unknown one is judged at the start directory and fails closed.
  const here = (d: Possible<string>) => u.chdir.reduce<string | null>((from, t) => move(w.st, from, t, true), dirOf(w.st, d))
  return { cmd, idx, u, argv: u.argv, dyn: u.dyn, name: u.argv.length ? basename(u.argv[0]!) : '', sure, loop, effect, here }
}

// Shell builtins that change the process state; false when `s` is not one.
function applyBuiltin(w: Walk, s: Step): boolean {
  const { argv, name, effect } = s
  if (name === 'export') applyExport(w.st, argv, effect)
  else if (name === 'unset') applyUnset(w.st, argv, effect)
  else if (DECLARES.has(name)) {
    const why = applyDeclare(w.st, argv, s.dyn, effect)
    if (why) mark(w, why)
  }
  else if (name === 'cd') applyCd(w.st, argv, s.here, s.loop, effect)
  else if (name === 'pushd') applyPushd(w.st, argv, s.here, s.loop, effect)
  else if (name === 'popd') applyPopd(w.st, argv, s.dyn, effect)
  else if (name === 'set') applySet(w.st, argv, effect)
  // A sourced script is not read; one the shell makes up or reads from stdin is not even a file.
  else if (name === 'source' || name === '.') mark(w, 'a sourced script the guard cannot read')
  else return false
  return true
}

// One call per possible directory and value of each multi-valued variable; fanned-out calls are never certain.
function emitToolCalls(w: Walk, s: Step): void {
  const { argv, name, u } = s
  const dirs = w.st.proc.get('dir')
  let combos = dirs.map((d) => ({ here: s.here(d), env: {} as Record<string, string>, unknown: false, gone: [] as string[] }))
  for (const n of w.st.names) {
    // Only the variables the guard reads can change a verdict, so the others do not multiply the calls.
    if (!READ_ENV.test(n) && !IDENTITY_ENV.test(n)) continue
    if (u.clear || u.unset.has(n) || Object.hasOwn(u.assigns, n)) continue
    const values = w.st.proc.get(`env:${n}`)
    combos = combos.flatMap((c) =>
      values.map((v) => (v === REAL ? c : v === UNKNOWN ? { ...c, unknown: true } : v === UNSET ? { ...c, gone: [...c.gone, n] } : { ...c, env: { ...c.env, [n]: v } })),
    )
    if (combos.length > MAX_FANOUT) {
      mark(w, 'more than 16 combinations of directory and variables')
      combos = combos.slice(0, MAX_FANOUT)
    }
  }
  const flow: Flow = { chain: w.chain, certain: s.sure && combos.length === 1, loop: s.loop }
  const slot = (why: string) => mark(w, why)
  for (const { here, env, unknown, gone } of combos) {
    const simple: Simple = { argv, assigns: { ...env, ...u.assigns }, op: s.cmd.op, unset: [...u.unset, ...gone], clear: u.clear }
    const at = here ?? w.st.startDir
    if (name === 'git') {
      const r = parseGit(simple, argv, s.dyn, at, w.st.home, flow, slot)
      const why = !r.ok ? 'a git option or repository the guard cannot follow' : unknown ? 'a variable the guard cannot tell' : undefined
      if (r.call && why) r.call.opaque = why
      if (r.call && here === null) r.call.unresolvedDir = true
      if (r.call) w.calls.push(r.call)
    } else if (name === 'gh' || name === 'glab' || name === 'tea' || name === 'fj') {
      const call = parseGh(argv, s.dyn, name, at, flow, slot)
      if (call) w.calls.push(call)
    } else {
      const call = parseInfra(simple, argv, s.dyn, name as InfraTool, at, w.st.home, flow, slot)
      // Terraform is classified by its directory, and a relative kubeconfig path depends on it.
      const located = name === 'terraform' || name === 'tofu' || Boolean(call?.kubeconfig || simple.assigns.KUBECONFIG)
      // A `..` left for the OS to resolve hides the directory names terraform is classified by.
      const opaque = call !== null && call.dir.split('/').includes('..')
      // An earlier command may have switched the context or workspace, or written the kubeconfig the guard reads.
      const files = call?.kubeconfig ? [call.kubeconfig] : (simple.assigns.KUBECONFIG || '').split(':').filter(Boolean)
      const switched = name === 'kubectl' || name === 'helm' ? w.kube || files.some((f) => w.written.has(basename(f))) : w.workspace
      if (call && ((here === null && located) || unknown || (opaque && located) || switched)) call.custom = true
      if (call) w.calls.push(call)
    }
  }
}

// `bash -c`, `eval` and `secret-box exec --` scripts are queued in the wrapper's place in the chain.
function inlineScript(w: Walk, s: Step): void {
  const { argv, name, u } = s
  let script: string | undefined
  let from = argv.length
  if (name === 'secret-box') {
    // `secret-box exec [--scrub] -- SCRIPT` runs SCRIPT through a shell.
    if (argv[1] === 'exec') {
      const separator = argv[2] === '--scrub' ? 3 : 2
      if (argv[separator] === '--' && argv[separator + 1] !== undefined) script = argv.slice((from = separator + 1)).join(' ')
      else mark(w, 'a secret-box exec without a script')
    }
  } else if (name === 'eval') {
    script = argv.slice((from = 1)).join(' ')
  } else {
    // A script read from stdin (pipe, here-string, heredoc) is not followed: the call is unparsed.
    const r = shellScript(argv)
    if (!r.ok) mark(w, 'a shell option the guard does not know')
    else if (r.stdin) mark(w, 'a shell reading its script from stdin')
    script = r.script
    if (r.at !== undefined && script !== undefined) from = r.at
    // A shell running a script it builds or reads from a process substitution is a local marker under its own name.
    if (r.at !== undefined && s.dyn[r.at]) {
      w.local.push({ why: `a ${name} script ${DYNAMIC}`, tools: [name] })
      return
    }
  }
  if (script === undefined) return
  if (s.dyn.slice(from).some(Boolean)) {
    mark(w, `a ${name} script ${DYNAMIC}`)
    return
  }
  if (w.queue.length >= MAX_QUEUE) {
    mark(w, 'too many commands to follow')
    return
  }
  const inner = tokenize(script, 1)
  if (!inner.ok) mark(w, 'a quote or substitution that does not close, or nesting deeper than 4')
  for (const why of inner.opaque) mark(w, why)
  // The wrapper's own assignments and `env -u`/`-i` apply to the inner script, which runs in the wrapper's place in the chain.
  const outer = u.assigns
  const drop = { unset: [...u.unset], clear: u.clear, chdir: u.chdir }
  w.queue.splice(s.idx + 1, 0, ...inner.cmds.map((c) => ({ ...c, op: c.op === '' ? s.cmd.op : c.op, ...(c.argv.length ? { assigns: { ...outer, ...c.assigns }, ...drop } : {}) })))
}

// A command the guard does not model that names a tool among its arguments runs it out of sight.
// `rg --pre` runs a program on every file, so it is not a text head.
// Follows the commands that change the kube context or terraform workspace on disk, and the files a command writes;
// once either may have happened, the lookups (taken before the command runs) are stale for every later call,
// whether or not the command surely ran.
function markSwitch(w: Walk, s: Step): void {
  const words = s.argv.slice(1)
  const inPlace = INPLACE_WRITERS.has(s.name) && words.some((a) => /^-[a-zA-Z]*i|^--in-?place(?:=|$)/.test(a))
  const awkInPlace = s.name === 'gawk' && words.some((a, i) =>
    ((a === '-i' || a === '--include') && words[i + 1] === 'inplace') || a === '-iinplace' || a === '--include=inplace')
  const options = Object.hasOwn(FILE_OUTPUT_OPTIONS, s.name) ? FILE_OUTPUT_OPTIONS[s.name]! : []
  const outputOption = (a: string) => options.find((opt) => a === opt || a.startsWith(opt + (opt.startsWith('--') ? '=' : '')))
  const writes = FILE_WRITERS.has(s.name) || inPlace || awkInPlace || words.some((a) => outputOption(a) !== undefined)
  const targets = (s.cmd.outputs ?? []).map((path) => ({ path, dynamic: hasVariable(path) || SECRET_PLACEHOLDER.test(path) }))
  if (writes) for (let i = 1; i < s.argv.length; i++) {
    const a = s.argv[i]!
    const opt = outputOption(a)
    let path = a
    if (a.startsWith('-')) {
      if (a.startsWith('--') && a.includes('=')) path = a.slice(a.indexOf('=') + 1)
      else {
        if (opt === undefined || a === opt) continue
        path = a.slice(opt.length)
      }
    } else if (s.name === 'dd') {
      if (!a.startsWith('of=')) continue
      path = a.slice(3)
    }
    targets.push({ path, dynamic: Boolean(s.dyn[i]) || hasVariable(path) || SECRET_PLACEHOLDER.test(path) })
  }
  for (const { path: f, dynamic } of targets) {
    if (dynamic) {
      w.kube = w.workspace = true
      continue
    }
    w.written.add(basename(f))
    if (KUBE_FILE.test(f)) w.kube = true
    if (WORKSPACE_FILE.test(f)) w.workspace = true
  }
  const rows = Object.hasOwn(KUBE_SWITCHERS, s.name) ? KUBE_SWITCHERS[s.name]! : []
  if (!rows.some((row) => row.every((r) => r.split('|').some((alias) => words.includes(alias))))) return
  if ((s.name === 'kubectx' || s.name === 'kubens' || s.name === 'kubectl-ctx') && words.every((a) => KUBECTX_READ.has(a))) return
  if (s.name === 'oc' && words[0] === 'config' && OC_CONFIG_READ.has(words[1] ?? '')) return
  w.kube = true
}

// Only known sed options can separate scripts from files. Any `e` in a script keeps all words visible:
// this deliberately includes harmless occurrences rather than trying to parse sed's execution syntax.
function sedFileSlots(s: Step): Set<number> | null {
  const files = new Set<number>()
  const scripts: string[] = []
  let options = true
  for (let i = 1; i < s.argv.length; i++) {
    const a = s.argv[i]!
    if (s.dyn[i]) return null
    if (options && a === '--') options = false
    else if (options && SED_FLAGS.has(a)) continue
    else if (options && (a === '-e' || a === '--expression')) {
      const script = s.argv[++i]
      if (script === undefined || s.dyn[i]) return null
      scripts.push(script)
    } else if (options && a.startsWith('-')) return null
    else if (!scripts.length) scripts.push(a)
    else files.add(i)
  }
  return !scripts.length || scripts.some((script) => script.includes('e')) ? null : files
}

// Literal words are evidence about piped text, not an evaluation of the producer's output. Include all
// stages through pass-through commands; substitutions are queued separately and do not break a pipeline.
function pipedWords(w: Walk, s: Step): string[] {
  const words: string[] = []
  let cmd = s.cmd
  let idx = s.idx
  // A nested input executor may consume the enclosing command's stdin (for example tee >(xargs env)).
  if (cmd.op === '$(') {
    while (idx > 0 && w.queue[idx - 1]!.op === '$(') idx--
    while (idx < w.queue.length - 1 && w.queue[idx]!.op === '$(') {
      const nested = w.queue[idx++]!
      words.push(...nested.argv, ...Object.values(nested.assigns), ...(nested.input ?? []))
    }
    cmd = w.queue[idx]!
    words.push(...(cmd.input ?? []))
  }
  while (SINGLE_PIPE.test(cmd.op)) {
    do { idx-- } while (idx >= 0 && w.queue[idx]!.op === '$(')
    if (idx < 0) break
    cmd = w.queue[idx]!
    // Group output is not evaluated: conservatively check the enclosing command's literal words.
    if (cmd.argv[0] === '}' || cmd.argv[0] === 'fi' || cmd.argv[0] === 'done' || w.queue[idx + 1]!.op.includes(')')) {
      return w.queue.flatMap((c) => [...c.argv, ...Object.values(c.assigns), ...(c.input ?? [])])
    }
    const u = unwrap(cmd)
    const name = basename(u.argv[0] ?? '')
    // A modeled tool call is already checked; its executable name is not evidence about its output.
    const modeled = name === 'git' || name === 'gh' || name === 'glab' || name === 'tea' || name === 'fj' || INFRA_TOOLS.has(name)
    words.push(...u.argv.slice(modeled ? 1 : 0), ...Object.values(u.assigns), ...(cmd.input ?? []))
  }
  return words
}

function markOpaque(w: Walk, s: Step): void {
  if (s.u.clear || s.u.unset.has('PATH')) mark(w, 'a cleared PATH for an unmodeled command')
  const bare = s.argv[0] === s.name
  const executableOption = s.name === 'rg' ? s.argv.some((a) => a === '--pre' || a.startsWith('--pre='))
    : s.name === 'man' && s.argv.slice(1).some((a) => /^-[^-]*[PH]|^--(?:pager|html)(?:=|$)/.test(a))
  if (bare && (FLOW_HEADS.has(s.name) || (TEXT_HEADS.has(s.name) && !executableOption))) return
  const sedFiles = s.name === 'sed' ? sedFileSlots(s) : new Set<number>()
  const data = bare && (DATA_HEADS.has(s.name) || (s.name === 'brew' && s.argv[1] === 'install'))
  const executor = INPUT_EXECUTORS.has(s.name) || /^python[\d.]*$/.test(s.name) || (s.name === 'sed' && sedFiles === null)
  // Substitutions are followed as calls of their own, so their text is not this command's words. A command word
  // that is not a plain name or path (`"git push" origin main`) counts among them.
  const words = s.argv.slice(1).map((a, i) => {
    if (data) return ''
    if (executor) return a
    if (s.dyn[i + 1]) return a.replace(SUBST_TEXT, ' ')
    if (s.name === 'man') return a.replace(/^-[^-]*?[PH]/, ' ')
    return bare && s.name === 'sed' && sedFiles?.has(i + 1) && isDataWord(a) ? '' : a
  })
  if (!PLAIN_WORD.test(s.argv[0]!)) words.push(s.argv[0]!)
  const input = s.name === 'sed' && sedFiles !== null ? [] : [...(s.cmd.input ?? []), ...(executor ? pipedWords(w, s) : [])]
  const tools = toolWords([...words, ...input].join(' '), { shells: true })
  if (tools.length) w.local.push({ why: `${s.name} with ${tools.join(', ')} among its words`, tools })
}

export function extractCalls(src: string, startDir: string, home: string): Parsed {
  const first = tokenize(src)
  const w: Walk = {
    queue: [...first.cmds], calls: [], st: newProcState(startDir, home), opaque: [], local: [], chain: 0, joinNext: false, depth: 0, loops: [],
    kube: false, workspace: false, written: new Set(),
  }
  if (!first.ok) mark(w, 'a quote or substitution that does not close, or nesting deeper than 4')
  for (const why of first.opaque) mark(w, why)
  let budget = 2000
  for (let idx = 0; idx < w.queue.length; idx++) {
    const cmd = w.queue[idx]!
    if (budget-- <= 0) {
      mark(w, 'too many commands to follow')
      break
    }
    advance(w, cmd)
    expandLoop(w, cmd, idx)
    w.st.proc.step(w.chain)
    const s = flowOf(w, cmd, idx)
    for (const why of s.u.opaque) mark(w, why)
    const assigned = [...Object.keys(s.u.assigns), ...(s.name === 'export' || DECLARES.has(s.name) ? s.argv.slice(1).map((a) => a.split('=')[0]!) : [])]
    for (const k of assigned) if (SHELL_ENV.has(k)) mark(w, `an assignment to ${k}`)
    // PATH tokens can change command resolution through any builtin, including `{PATH}` redirections.
    if ([...cmd.argv, ...Object.entries(s.u.assigns).flat(), ...(cmd.outputs ?? [])].some((a) => /\bPATH\b|^-vPATH\b/.test(a))) mark(w, 'a possible write to PATH')
    const settings = Object.entries(s.u.assigns)
    if (s.name === 'export' || DECLARES.has(s.name)) for (const a of s.argv.slice(1)) {
      const eq = a.indexOf('=')
      if (eq > 0) settings.push([a.slice(0, eq), a.slice(eq + 1)])
    }
    for (const [key, value] of settings) {
      if (!EXEC_ENV.test(key)) continue
      const tools = toolWords(value, { shells: key !== 'SHELL' || !isDataWord(value), commands: true })
      if (tools.length) w.local.push({ why: `an assignment to ${key} with ${tools.join(', ')} among its words`, tools })
    }
    if (s.dyn[0]) {
      const tools = mayName(s.argv[0]!, [...OPAQUE_TOOLS])
      if (tools.length) w.local.push({ why: `a command word that may expand to ${tools.join(', ')}`, tools })
      else mark(w, `a command word ${DYNAMIC}`)
      continue
    }
    // The shell opens a command's redirections before it runs.
    markSwitch(w, s)
    if (!s.argv.length) {
      if (s.u.bare) applyAssign(w.st, s.u.assigns, s.effect)
      continue
    }
    if (Object.hasOwn(STRUCTURES, s.name)) {
      mark(w, STRUCTURES[s.name]!)
      continue
    }
    if (applyBuiltin(w, s)) continue
    if (s.name === 'git' || s.name === 'gh' || s.name === 'glab' || s.name === 'tea' || s.name === 'fj' || INFRA_TOOLS.has(s.name)) emitToolCalls(w, s)
    else if (SHELLS.has(s.name) || s.name === 'eval' || s.name === 'secret-box') inlineScript(w, s)
    else markOpaque(w, s)
  }
  return { calls: w.calls, ok: !w.opaque.length && !w.local.length, opaque: w.opaque, local: w.local }
}
