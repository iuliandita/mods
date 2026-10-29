import type { Flow } from './flow'
import type { Simple } from './lex'
import { hasVariable, joinPath } from './paths'
import { IDENTITY_ENV } from './words'

export type GitCall = {
  kind: 'git'
  sub: string
  args: string[]
  dir: string
  overrides: Record<string, string>
  // Every `-c` in order, key as written: multivalued keys (`remote.*.push`) and includes keep all their values.
  config: [key: string, value: string][]
  assigns: Record<string, string>
  op: string
  flow: Flow
  // `env -i`, or `env -u` of a variable git reads its identity from.
  scrubbed?: boolean
  // Why the repository or environment the call acts on cannot be followed; a write is then unparsed.
  opaque?: string
  // The starting directory is unknown; a guarded write fails the parsed lookup check.
  unresolvedDir?: true
  // Follows `args`: set when some word is not literal (a variable, substitution, glob or secret placeholder).
  dynArgs?: boolean[]
}

// secret-box resolves a placeholder before the command runs, so the guard cannot know the value.
export const SECRET_PLACEHOLDER = /\{\{secret:[^}]*\}\}/

export type GhCall = { kind: 'gh'; cli: 'gh' | 'glab' | 'tea' | 'fj'; area: string; verb: string; args: string[]; dir: string; flow: Flow }

export type InfraTool = 'kubectl' | 'helm' | 'terraform' | 'tofu'

export type InfraCall = {
  kind: 'infra'
  tool: InfraTool
  sub: string
  args: string[]
  dir: string
  assigns: Record<string, string>
  context?: string
  kubeconfig?: string
  custom?: boolean
  // An option the guard does not know came before the verb, so the verb may be its value.
  unsure?: boolean
  flow: Flow
}

export type Call = GitCall | GhCall | InfraCall

const FJ_VALUE = new Set(['-H', '--host', '-C', '--cwd', '--style'])
export const INFRA_TOOLS = new Set<string>(['kubectl', 'helm', 'terraform', 'tofu'])
const INFRA_VALUE: Record<InfraTool, Set<string>> = {
  kubectl: new Set([
    '--context', '-n', '--namespace', '--cluster', '--user', '--kubeconfig', '-s', '--server', '--as', '--as-group', '--as-uid', '--token',
    '--username', '--password', '--certificate-authority', '--client-certificate', '--client-key', '--tls-server-name',
    '--request-timeout', '--cache-dir', '-v', '--vmodule', '--log-flush-frequency', '--profile', '--profile-output',
  ]),
  helm: new Set([
    '--kube-context', '-n', '--namespace', '--kubeconfig', '--kube-as-user', '--kube-as-group', '--kube-token', '--kube-apiserver',
    '--kube-ca-file', '--kube-tls-server-name', '--registry-config', '--repository-cache', '--repository-config', '--burst-limit', '--qps',
    '--content-cache', '--color', '--colour',
  ]),
  terraform: new Set(),
  tofu: new Set(),
}
// Flags known not to take a separate value; any other option without "=" may take the next word.
const INFRA_BOOL: Record<InfraTool, Set<string>> = {
  kubectl: new Set([
    '--dry-run', '--all', '--all-namespaces', '-A', '--force', '--wait', '--overwrite', '--recursive', '-R', '--server-side', '--force-conflicts',
    '--prune', '--record', '--local', '--ignore-not-found', '--now', '--disable-compression', '--insecure-skip-tls-verify',
    '--match-server-version', '--warnings-as-errors', '-i', '-t', '--stdin', '--tty', '--rm', '--quiet', '-q',
  ]),
  helm: new Set([
    '--dry-run', '--install', '-i', '--atomic', '--wait', '--wait-for-jobs', '--create-namespace', '--force', '--reuse-values', '--reset-values',
    '--reset-then-reuse-values', '--debug', '--devel', '--skip-crds', '--no-hooks', '--cleanup-on-fail', '--dependency-update',
    '--disable-openapi-validation', '--render-subchart-notes', '--keep-history', '--rollback-on-failure', '--take-ownership', '--hide-notes',
    '--skip-schema-validation', '--insecure-skip-tls-verify', '--plain-http', '--verify', '--enable-dns', '--hide-secret',
    '--kube-insecure-skip-tls-verify',
  ]),
  terraform: new Set(),
  tofu: new Set(),
}
const INFRA_CONTEXT_OPT: Partial<Record<InfraTool, string>> = { kubectl: '--context', helm: '--kube-context' }
const INFRA_TARGET_OPTS: Partial<Record<InfraTool, Set<string>>> = {
  kubectl: new Set(['--server', '-s', '--cluster']),
  helm: new Set(['--kube-apiserver']),
}

const GIT_FLAGS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '-v', '--version', '-h', '--help', '--html-path', '--man-path', '--info-path',
  '--exec-path', '--list-cmds',
])
// Options that move the repository or its refs somewhere the guard's own lookups do not follow.
const GIT_OPAQUE = new Set(['--git-dir', '--work-tree', '--namespace', '--config-env', '--bare'])
const GIT_OPAQUE_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_NAMESPACE']
const PUSH_OPTION_VALUE = new Set(['-o', '--push-option'])

// Reports a word the shell expands in a slot that decides what a call does.
export type Mark = (why: string) => void

// `ok` is false for an option form git's own parser may read differently, or a target the guard cannot follow.
export function parseGit(s: Simple, argv: string[], dyn0: boolean[], dir0: string, home: string, flow: Flow, mark: Mark): { call: GitCall | null; ok: boolean } {
  const dyn = argv.map((a, k) => (dyn0[k] ?? false) || SECRET_PLACEHOLDER.test(a))
  let dir = dir0
  let unresolvedDir = false
  let ok = !GIT_OPAQUE_ENV.some((k) => k in s.assigns)
  const overrides: Record<string, string> = {}
  const config: [string, string][] = []
  let i = 1
  while (i < argv.length) {
    const a = argv[i]!
    const key = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a
    if ((a === '-C' || a === '-c') && dyn[i + 1]) mark(`a git ${a} value built from a variable, substitution or glob`)
    if (a === '-C') {
      const target = argv[i + 1] ?? ''
      if (hasVariable(target) || dyn[i + 1]) {
        ok = false
        unresolvedDir = true
      }
      else dir = joinPath(dir, target, home)
      i += 2
    } else if (a === '-c') {
      const kv = argv[i + 1] ?? ''
      const eq = kv.indexOf('=')
      if (eq > 0) {
        overrides[kv.slice(0, eq).toLowerCase()] = kv.slice(eq + 1)
        config.push([kv.slice(0, eq), kv.slice(eq + 1)])
      }
      i += 2
    } else if (GIT_OPAQUE.has(key)) {
      ok = false
      i += key === a && a !== '--bare' ? 2 : 1
    } else if (key === '--attr-source') {
      i += key === a ? 2 : 1
    } else if (GIT_FLAGS.has(key)) {
      i++
    } else if (a.startsWith('-')) {
      ok = false
      i++
    } else {
      break
    }
  }
  const sub = argv[i]
  if (sub === undefined) return { call: null, ok }
  if (dyn[i]) mark('a git subcommand built from a variable, substitution or glob')
  // The remote and refspecs decide what a push updates. A secret placeholder as the remote is a URL with a token,
  // which names no branch; one in a refspec hides the destination.
  for (let j = i + 1, positional = 0; sub === 'push' && j < argv.length; j++) {
    const a = argv[j]!
    if (PUSH_OPTION_VALUE.has(a)) {
      j++
      continue
    }
    if (dyn0[j] || (dyn[j] && positional > 0)) mark('a git push remote or refspec built from a variable, substitution, glob or secret placeholder')
    if (!a.startsWith('-')) positional++
  }
  const scrubbed = s.clear || s.unset?.some((k) => IDENTITY_ENV.test(k))
  const dynArgs = dyn.slice(i + 1)
  return {
    call: {
      kind: 'git', sub, args: argv.slice(i + 1), dir, overrides, config, assigns: s.assigns, op: s.op, flow,
      ...(scrubbed ? { scrubbed } : {}), ...(dynArgs.some(Boolean) ? { dynArgs } : {}),
      ...(unresolvedDir ? { unresolvedDir: true } : {}),
    },
    ok,
  }
}

export function parseGh(argv: string[], dyn: boolean[], cli: GhCall['cli'], dir: string, flow: Flow, mark: Mark): GhCall | null {
  const rest: string[] = []
  const restDyn: boolean[] = []
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-R' || argv[i] === '--repo' || (cli === 'tea' && argv[i] === '-r') || (cli === 'fj' && FJ_VALUE.has(argv[i]!))) i++
    else if (argv[i]!.startsWith('-')) continue
    else {
      rest.push(argv[i]!)
      restDyn.push(dyn[i] ?? false)
    }
  }
  if (restDyn[0] || restDyn[1]) mark(`a ${cli} area or verb built from a variable, substitution or glob`)
  if (rest.length === 0) return null
  return { kind: 'gh', cli, area: rest[0]!, verb: rest[1] ?? '', args: argv.slice(1), dir, flow }
}

// True when a kubectl or helm option may take the next word as its value: a known value option, or any
// option the guard does not know, without an attached "=" value.
export function takesValue(tool: InfraTool, a: string): boolean {
  if (tool === 'terraform' || tool === 'tofu' || !a.startsWith('-') || a === '--' || a.includes('=')) return false
  if (!a.startsWith('--') && a.length !== 2) return false
  return INFRA_VALUE[tool].has(a) || !INFRA_BOOL[tool].has(a)
}

// Index of the first token after the options, or -1; `-chdir=DIR` moves `dir`.
function infraVerb(argv: string[], tool: InfraTool, onChdir: (dir: string) => void): { at: number; unsure: boolean } {
  const value = INFRA_VALUE[tool]
  let unsure = false
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('-chdir=') && (tool === 'terraform' || tool === 'tofu')) onChdir(a.slice(7))
    else if (value.has(a)) i++
    else if (!a.startsWith('-')) return { at: i, unsure }
    else if (takesValue(tool, a)) unsure = true
  }
  return { at: -1, unsure }
}

export function parseInfra(s: Simple, argv: string[], dyn: boolean[], tool: InfraTool, dir0: string, home: string, flow: Flow, mark: Mark): InfraCall | null {
  let dir = dir0
  let custom = false
  const { at, unsure } = infraVerb(argv, tool, (target) => {
    if (hasVariable(target)) custom = true
    else dir = joinPath(dir, target, home)
  })
  const verb = argv[at]
  if (at === -1 || verb === undefined) return null
  if (dyn[at]) mark(`a ${tool} verb built from a variable, substitution or glob`)
  const opt = INFRA_CONTEXT_OPT[tool]
  const targets = INFRA_TARGET_OPTS[tool]
  let context: string | undefined
  let kubeconfig: string | undefined
  // The previous word was an unknown option, so this word may be its value rather than an option.
  let loose = false
  for (let i = 1; opt !== undefined && i < argv.length && argv[i] !== '--'; i++) {
    const a = argv[i]!
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    const key = eq === -1 ? a : a.slice(0, eq)
    const val = eq === -1 ? argv[i + 1] : a.slice(eq + 1)
    const target = targets?.has(key) || (!a.startsWith('--') && targets?.has(a.slice(0, 2)))
    if (loose && (key === opt || key === '--kubeconfig' || target)) custom = true
    loose = false
    if ((key === opt || key === '--kubeconfig') && dyn[eq === -1 ? i + 1 : i]) mark(`a ${tool} ${key} value built from a variable, substitution or glob`)
    if (key === opt && val) context = val
    else if (key === '--kubeconfig' && val) kubeconfig = val
    else if (target) custom = true
    if (eq === -1 && INFRA_VALUE[tool].has(a)) i++
    else if (takesValue(tool, a)) loose = true
  }
  return { kind: 'infra', tool, sub: verb, args: argv.slice(at + 1), dir, assigns: s.assigns, context, kubeconfig, custom, unsure, flow }
}

// The words after the verb that are not options or option values (`rollout restart`, `state rm`).
export function positionals(call: InfraCall): string[] {
  const value = INFRA_VALUE[call.tool]
  const out: string[] = []
  for (let i = 0; i < call.args.length && call.args[i] !== '--'; i++) {
    if (value.has(call.args[i]!)) i++
    else if (!call.args[i]!.startsWith('-')) out.push(call.args[i]!)
  }
  return out
}
