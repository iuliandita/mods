import { createTracker, REAL, UNKNOWN, type Tracker } from './flow'
import type { Config, Env, Violation } from './rules'
import { hasVariable } from './paths'
import { positionals, resolvePath, takesValue, type InfraCall } from './shell'

export type Class = 'protected' | 'relaxed'
export type Classes = Record<string, Class>
export type Origin = { kind: string } | undefined

// Anything not listed is mutating: an unknown verb or plugin fails closed.
const KUBECTL_READ = new Set([
  'get', 'describe', 'logs', 'top', 'explain', 'api-resources', 'api-versions', 'version', 'diff', 'cluster-info', 'wait',
  'events', 'completion', 'kustomize', 'port-forward', 'plugin', 'config',
])
const KUBECTL_ROLLOUT_READ = new Set(['status', 'history'])
const KUBECTL_AUTH_READ = new Set(['can-i', 'whoami'])
const HELM_READ = new Set([
  'list', 'ls', 'status', 'get', 'show', 'template', 'lint', 'diff', 'history', 'search', 'repo', 'env', 'version', 'verify',
  'dependency', 'plugin', 'completion', 'pull', 'package',
])
const TERRAFORM_READ = new Set([
  'plan', 'validate', 'fmt', 'init', 'show', 'output', 'providers', 'version', 'graph', 'console', 'get', 'login', 'logout', 'metadata',
])
const TERRAFORM_WORKSPACE_READ = new Set(['show', 'list', 'select'])
// `init` flags that move or drop backend state.
const TERRAFORM_INIT_WRITE = /^--?(?:migrate-state|force-copy|reconfigure)(?:=(?!false$)|$)/
const OR_CREATE = /^--?or-create(?:=(?!false$)|$)/
const TERRAFORM_STATE_READ = new Set(['list', 'show', 'pull'])
// Verbs that take --dry-run; it never turns any other verb into a read.
const KUBECTL_DRY = new Set([
  'apply', 'create', 'delete', 'replace', 'patch', 'edit', 'scale', 'autoscale', 'drain', 'cordon', 'uncordon', 'taint', 'label',
  'annotate', 'set', 'expose', 'run', 'rollout',
])
const HELM_DRY = new Set(['install', 'upgrade', 'uninstall', 'delete', 'rollback'])
const DRY_VALUES = new Set(['client', 'server', 'true'])

const CUSTOM = '(custom target)'
// Helm variables that point at a cluster no context name describes.
const HELM_TARGET_ENV = ['HELM_KUBEAPISERVER', 'HELM_KUBETOKEN', 'HELM_KUBECAFILE']
const TF_TARGET_ENV = ['TF_DATA_DIR', 'TF_CLOUD_ORGANIZATION', 'TF_CLOUD_HOSTNAME', 'TF_CLOUD_PROJECT']
const TF_ARGS_ENV = /^TF_CLI_ARGS(?:_[A-Za-z0-9_]+)?$/
const NAME_LIMIT = 200
const CONTROL = /[\u0000-\u001f\u007f]/
const CONTROL_ALL = new RegExp(CONTROL.source, 'g')
const USAGE = 'usage: /guard-context <name> protected|relaxed, /guard-context forget <name>, /guard-context list'

// The last --dry-run flag wins, as in the tools' own flag parsing; a word that may be an option's value is skipped.
function isDryRun(call: InfraCall): boolean {
  let dry = false
  const args = call.args
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') break
    if (a === '--dry-run') dry = true
    else if (a.startsWith('--dry-run=')) dry = DRY_VALUES.has(a.slice('--dry-run='.length))
    else if (takesValue(call.tool, a)) i++
  }
  return dry
}

export function isMutating(call: InfraCall): boolean {
  if (call.unsure) return true
  // Injected flags can make otherwise read-exempt operations move state (for example init -migrate-state).
  if ((call.tool === 'terraform' || call.tool === 'tofu') && Object.keys(call.assigns).some((k) => TF_ARGS_ENV.test(k))) return true
  const next = positionals(call)[0] ?? ''
  if (call.tool === 'kubectl') {
    if (KUBECTL_READ.has(call.sub)) return false
    if (call.sub === 'rollout' && KUBECTL_ROLLOUT_READ.has(next)) return false
    if (call.sub === 'auth' && KUBECTL_AUTH_READ.has(next)) return false
    return !(KUBECTL_DRY.has(call.sub) && isDryRun(call))
  }
  if (call.tool === 'helm') return !HELM_READ.has(call.sub) && !(HELM_DRY.has(call.sub) && isDryRun(call))
  if (call.sub === 'init') return call.args.some((a) => TERRAFORM_INIT_WRITE.test(a))
  if (TERRAFORM_READ.has(call.sub)) return false
  if (call.sub === 'workspace') return !TERRAFORM_WORKSPACE_READ.has(next) || call.args.some((a) => OR_CREATE.test(a))
  if (call.sub === 'state') return !TERRAFORM_STATE_READ.has(next)
  return true
}

const BOUNDARY = '[-_./:@]'

// `bounded`: a `*` next to a literal must meet it at a token boundary (`-_./:@`), so the relaxed `*dev*` matches
// `dev` and `my-dev-x` but not `devops-eu`. Protected patterns stay plain substring globs.
function matches(patterns: string[], name: string, bounded = false): boolean {
  return patterns.some((p) => {
    const parts = p.toLowerCase().split('*')
    let body = esc(parts[0]!)
    for (let i = 1; i < parts.length; i++) {
      const left = parts[i - 1]!
      const right = parts[i]!
      // A literal edge that is itself a boundary needs none from the star.
      const needLeft = bounded && left !== '' && !new RegExp(`${BOUNDARY}$`).test(left)
      const needRight = bounded && right !== '' && !new RegExp(`^${BOUNDARY}`).test(right)
      const star = needLeft && needRight ? `(?:${BOUNDARY}(?:.*${BOUNDARY})?)?` : needLeft ? `(?:${BOUNDARY}.*)?` : needRight ? `(?:.*${BOUNDARY})?` : '.*'
      body += star + esc(right)
    }
    return new RegExp(`^${body}$`).test(name)
  })
}

function esc(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

export function classify(name: string, stored: Classes, cfg: Pick<Config, 'protectedContexts' | 'relaxedContexts'>): Class | 'unknown' {
  const n = name.toLowerCase()
  const own = Object.prototype.hasOwnProperty.call(stored, n) ? stored[n] : undefined
  if (own === 'protected' || own === 'relaxed') return own
  if (matches(cfg.protectedContexts, n)) return 'protected'
  if (matches(cfg.relaxedContexts, n, true)) return 'relaxed'
  return 'unknown'
}

function shown(name: string): string {
  return name.replace(CONTROL_ALL, '?').slice(0, 100)
}

// What earlier calls of one command may have switched, as possibility sets: the kube context per kubeconfig, and the
// terraform workspace per tool and directory (REAL: not switched). `shown` memoizes `workspace show` per tool and directory.
export type ContextState = { contexts: Tracker<string>; workspaces: Tracker<string>; shown: Map<string, string | null> }

export function newContextState(): ContextState {
  return { contexts: createTracker<string>((v) => v), workspaces: createTracker<string>((v) => v), shown: new Map() }
}

export function stepContext(state: ContextState, chain: number): void {
  state.contexts.step(chain)
  state.workspaces.step(chain)
}

function kubeconfigs(call: InfraCall, home: string): string[] {
  if (call.kubeconfig) return [call.kubeconfig]
  return call.assigns.KUBECONFIG?.split(':').filter(Boolean).length
    ? call.assigns.KUBECONFIG.split(':').filter(Boolean)
    : [resolvePath('/', '~/.kube/config', home)]
}

// The switch-state key of a call's kubeconfig: each entry resolved against the call's directory, so `./c` and `c`
// share state and `./c` in two directories does not; no kubeconfig is the default file.
async function kubeKey(call: InfraCall, env: Env): Promise<string> {
  const entries = kubeconfigs(call, env.home).map((p) => hasVariable(p) ? p : resolvePath(call.dir, p, env.home))
  if (entries.length === 1) return entries[0]!
  for (const path of entries) {
    if (hasVariable(path)) return path
    if (env.exists ? await env.exists(path) : await env.read(path) !== null) return path
  }
  // kubectl creates the last file when none exists.
  return entries[entries.length - 1]!
}

// `kubectl config` verbs that only read; any other verb (`set-cluster`, `set-credentials`, `delete-*`, a plugin or an
// unknown one) may write the kubeconfig in ways the guard does not follow.
const CONFIG_READ = new Set(['view', 'get-contexts', 'current-context', 'get-clusters', 'get-users'])

// A name built from a variable or substitution is whatever it expands to, which the guard cannot tell.
function known(name: string): string | typeof UNKNOWN {
  return hasVariable(name) ? UNKNOWN : name
}

const CTX_PLUGINS = new Set(['ctx', 'kubectx', 'switch', 'konfig'])
const CTX_READ = new Set(['-c', '--current', '-h', '--help'])

function changedEnvironment(call: InfraCall, home: string): boolean {
  const targets = call.tool === 'kubectl' || call.tool === 'helm'
    ? ['HOME', 'KUBECONFIG', 'HELM_KUBECONTEXT', ...HELM_TARGET_ENV]
    : ['HOME', 'TF_WORKSPACE', ...TF_TARGET_ENV, ...[...Object.keys(call.assigns), ...(call.unset ?? [])].filter((k) => TF_ARGS_ENV.test(k))]
  return Boolean(call.clear || call.unset?.some((k) => targets.includes(k)) ||
    targets.some((k) => Object.hasOwn(call.assigns, k) && call.assigns[k] === '') ||
    (Object.hasOwn(call.assigns, 'HOME') && call.assigns.HOME !== home))
}

function terraformTargetOverride(call: InfraCall): boolean {
  return TF_TARGET_ENV.some((k) => Object.hasOwn(call.assigns, k)) || Object.keys(call.assigns).some((k) => TF_ARGS_ENV.test(k))
}

export async function followSwitch(call: InfraCall, state: ContextState, env: Env): Promise<void> {
  const [verb, target, value] = positionals(call)
  const key = await kubeKey(call, env)
  // A switch through another or reset environment must not relax a later call in the inherited environment.
  const uncertain = call.custom || changedEnvironment(call, env.home) ||
    ((call.tool === 'terraform' || call.tool === 'tofu') && terraformTargetOverride(call))
  const switched = (name: string) => uncertain ? UNKNOWN : known(name)
  if (call.tool === 'kubectl' && call.sub === 'config') {
    // `use` is an alias of `use-context`.
    if ((verb === 'use-context' || verb === 'use') && target) state.contexts.set(key, [switched(target)], call.flow)
    // `config set current-context X` is a switch; other writes leave the current context unknown.
    else if (verb === 'set' && target === 'current-context' && value) state.contexts.set(key, [switched(value)], call.flow)
    else if (verb !== undefined && !CONFIG_READ.has(verb)) state.contexts.set(key, [UNKNOWN], call.flow)
  }
  // A krew plugin that switches context (`kubectl ctx NAME`); with no argument or only a read flag it just lists.
  if (call.tool === 'kubectl' && CTX_PLUGINS.has(call.sub) && call.args.some((a) => !CTX_READ.has(a))) {
    state.contexts.set(key, [UNKNOWN], call.flow)
  }
  if ((call.tool === 'terraform' || call.tool === 'tofu') && call.sub === 'workspace' && (verb === 'select' || verb === 'new') && target) {
    state.workspaces.set(`${call.tool}\0${call.dir}`, [switched(target)], call.flow)
  }
}

// A `weak` candidate can make a call protected but never relaxed.
type Candidate = { name: string; kind: string; weak?: boolean }

function lastPart(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

// The root `current-context` of one kubeconfig, read only where its text is the value kubectl resolves: a root-level
// key (nested ones belong to other fields) with a plain scalar or a quoted one without escapes. '' when none is set,
// null when the guard cannot tell (an escape, anchor, tag, block or flow value, a continuation, a duplicate key).
export function parseCurrentContext(text: string): string | null {
  if (/\r(?!\n)|[\u0085\u2028\u2029]/.test(text)) return null
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const first = lines.find((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
  if (first !== undefined && /^\s*[{[]/.test(first)) return null
  if (lines.slice(1).some((l) => /^(?:---|\.\.\.)(?:\s|$)/.test(l))) return null
  const key = /^(?:current-context|"current-context"|'current-context')[ \t]*:(?:[ \t]+(.*))?$/
  const at = lines.flatMap((l, i) => (key.test(l) ? [i] : []))
  // Unrecognized keys, nested mentions and escaped key spellings can hide a root value. Never let a later
  // kubeconfig's relaxed value stand in for YAML this deliberately small parser cannot interpret.
  if (lines.some((l, i) => (l.includes('current-context') && !at.includes(i)) || /^[^:#]*\\/.test(l))) return null
  if (at.length === 0) return ''
  if (at.length > 1) return null
  const i = at[0]!
  // The value may not continue on an indented line below, or in a sequence at the key's column.
  for (const l of lines.slice(i + 1)) {
    if (l.trim() === '') continue
    if (/^[ \t]+#/.test(l)) break
    if (/^[ \t]/.test(l) || /^-(?:\s|$)/.test(l)) return null
    break
  }
  const rest = (key.exec(lines[i]!)?.[1] ?? '').trim()
  if (rest === '' || rest.startsWith('#')) return ''
  const quoted = /^(?:"([^"\\]*)"|'([^'\\]*)')[ \t]*(?:#.*)?$/.exec(rest)
  if (quoted) return quoted[1] ?? quoted[2] ?? ''
  if (/^["'&*!|>{[%@`?,]|^-(?:\s|$)/.test(rest)) return null
  const plain = rest.replace(/[ \t]+#.*$/, '').trim()
  if (/: |:$/.test(plain) || /^(?:~|null|Null|NULL)$/.test(plain)) return null
  return plain
}

// The current-context the kubeconfig files set (the first file that sets one wins, as kubectl merges them);
// '' when none sets one, null when a file cannot be read or its value cannot be told.
async function fileContext(paths: string[], dir: string, env: Env): Promise<string | null> {
  for (const path of paths) {
    if (hasVariable(path)) return null
    const text = await env.read(resolvePath(dir, path, env.home))
    if (text === null) return null
    const name = parseCurrentContext(text)
    if (name === null) return null
    if (name) return name
  }
  return ''
}

// One candidate list per environment the call could act on; null when a lookup could not run (the caller reports
// it as a lookup failure). An UNKNOWN switch is a custom target.
async function candidates(call: InfraCall, env: Env, state: ContextState): Promise<Candidate[][] | null> {
  const kube = call.tool === 'kubectl' || call.tool === 'helm'
  const switched = kube ? state.contexts.get(await kubeKey(call, env)) : state.workspaces.get(`${call.tool}\0${call.dir}`)
  const out: Candidate[][] = []
  for (const p of switched) {
    const list = p === UNKNOWN ? [{ name: CUSTOM, kind: 'target' }] : await candidatesAt(call, env, state, p)
    if (list === null) return null
    out.push(list)
  }
  return out
}

async function candidatesAt(call: InfraCall, env: Env, state: ContextState, p: string | typeof REAL): Promise<Candidate[] | null> {
  const first = (r: { ok: boolean; out: string }) => (r.ok ? r.out.split('\n')[0]?.trim() ?? '' : '')
  // The probes inherit the hook's environment. A removed/empty target or another home cannot be replayed
  // safely, so no inherited relaxed context or directory may stand in for the command's actual target.
  const changed = changedEnvironment(call, env.home)
  if (call.tool === 'kubectl' || call.tool === 'helm') {
    const named = call.context || (call.tool === 'helm' ? call.assigns.HELM_KUBECONTEXT : '')
    if (named && hasVariable(named)) return [{ name: CUSTOM, kind: 'target' }]
    const config = kubeconfigs(call, env.home)
    const switched = p === REAL ? undefined : p
    const current = !named && switched === undefined && (call.kubeconfig || call.assigns.KUBECONFIG) ? await fileContext(config, call.dir, env) : undefined
    const file = lastPart(config[0] ?? '')
    const base: Candidate | undefined = named
      ? { name: named, kind: 'context' }
      : switched !== undefined
        ? { name: switched, kind: 'context' }
        : typeof current === 'string'
          ? { name: current || '(none)', kind: 'context' }
          : current === null && file
            ? { name: file, kind: 'kubeconfig' }
            : undefined
    // A server or cluster override, or a kubeconfig the guard cannot read, points somewhere no name describes, so only the target can relax it.
    if (changed || call.custom || current === null || (call.tool === 'helm' && HELM_TARGET_ENV.some((k) => call.assigns[k]))) return base ? [{ name: CUSTOM, kind: 'target' }, { ...base, weak: true }] : [{ name: CUSTOM, kind: 'target' }]
    if (base) return [base]
    const r = await env.run(call.dir, ['kubectl', 'config', 'current-context'])
    return r.failed ? null : [{ name: first(r) || '(none)', kind: 'context' }]
  }
  if (changed || call.custom || terraformTargetOverride(call)) return [{ name: CUSTOM, kind: 'target' }]
  const [verb, target] = positionals(call)
  const targeted = call.sub === 'workspace' && verb !== undefined && ['new', 'delete', 'select'].includes(verb) ? target : undefined
  let workspace = targeted || call.assigns.TF_WORKSPACE || (p === REAL ? '' : p)
  // A workspace built from a variable or substitution is unknown; no directory name may stand in for it.
  if (hasVariable(workspace)) return [{ name: CUSTOM, kind: 'target' }]
  if (!workspace) {
    const key = `${call.tool}\0${call.dir}`
    let shown = state.shown.get(key)
    if (shown === undefined) {
      const r = await env.run(call.dir, [call.tool, 'workspace', 'show'])
      shown = r.failed ? null : first(r)
      state.shown.set(key, shown)
    }
    if (shown === null) return null
    workspace = shown
  }
  const parts = call.dir.split('/').filter(Boolean)
  const out: Candidate[] = []
  if (workspace && workspace !== 'default') out.push({ name: workspace, kind: 'workspace' })
  if (parts.length) out.push({ name: parts[parts.length - 1]!, kind: 'directory' })
  if (parts.length > 1) out.push({ name: parts[parts.length - 2]!, kind: 'directory', weak: true })
  return out.length ? out : [{ name: '(none)', kind: 'workspace' }]
}

export async function contextViolations(call: InfraCall, cfg: Config, env: Env, state: ContextState = newContextState()): Promise<Violation[]> {
  if (cfg.context === 'off' || !isMutating(call)) return []
  const lists = await candidates(call, env, state)
  if (lists === null) return []
  const stored = await env.contexts()
  // Every environment the call could act on must pass; a protected one is reported before an unclassified one.
  let worst: Violation | undefined
  for (const found of lists) {
    const classes = found.map((c) => classify(c.name, stored, cfg))
    const protectedAt = classes.indexOf('protected')
    if (protectedAt === -1 && classes.some((c, i) => c === 'relaxed' && !found[i]!.weak)) continue
    const at = protectedAt === -1 ? 0 : protectedAt
    const { name, kind } = found[at]!
    const message =
      protectedAt !== -1
        ? `context: ${call.tool} ${call.sub} on protected ${kind} "${shown(name)}". Preview with --dry-run, diff or plan instead, or ask the user to run it themselves with the ! prefix.`
        : `context: ${kind} "${shown(name)}" is not classified on this machine. Ask the user whether it is protected or relaxed; they record the answer by typing /guard-context ${shown(name)} protected|relaxed (or run this command themselves with the ! prefix).`
    if (protectedAt !== -1) return [{ rule: 'context', mode: cfg.context, message }]
    worst ??= { rule: 'context', mode: cfg.context, message }
  }
  return worst ? [worst] : []
}

export function parseGuardCommand(args: string): { action: 'set' | 'forget' | 'list' | 'error'; name?: string; cls?: Class; message?: string } {
  const words = args.trim().match(/\(custom target\)|\S+/gi) ?? []
  const error = (message: string) => ({ action: 'error' as const, message: `${message}; ${USAGE}` })
  const valid = (word: string | undefined): string | null => (word !== undefined && word.length <= NAME_LIMIT && !CONTROL.test(word) ? word.toLowerCase() : null)
  const first = words[0]?.toLowerCase()
  if (first === 'list' && words.length === 1) return { action: 'list' }
  if (first === 'forget') {
    const name = words.length === 2 ? valid(words[1]) : null
    return name === null ? error('forget takes one valid name') : { action: 'forget', name }
  }
  const cls = words[1]?.toLowerCase()
  const name = words.length === 2 ? valid(words[0]) : null
  if (name === null || (cls !== 'protected' && cls !== 'relaxed')) return error('expected a valid name and protected or relaxed')
  return { action: 'set', name, cls }
}

export function isUserOrigin(origin: Origin): boolean {
  return origin?.kind === 'composer' || origin?.kind === 'bridge'
}

// `stored` is set only when the classifications changed and must be written back.
export function applyGuardCommand(args: string, origin: Origin, stored: Classes, cfg: Config): { text: string; stored?: Classes } {
  if (!isUserOrigin(origin)) {
    return { text: 'guard-context: only the user can change classifications, and this run did not come from the user. Type /guard-context yourself.' }
  }
  const cmd = parseGuardCommand(args)
  if (cmd.action === 'error') return { text: `guard-context: ${cmd.message}` }
  if (cmd.action === 'list') {
    const rows = Object.entries(stored).map(([n, c]) => `  ${n}: ${c}`)
    return {
      text: [
        rows.length ? 'Classified on this machine:' : 'Nothing is classified on this machine.',
        ...rows,
        `Protected patterns: ${cfg.protectedContexts.join(', ') || '(none)'}`,
        `Relaxed patterns: ${cfg.relaxedContexts.join(', ') || '(none)'}`,
      ].join('\n'),
    }
  }
  const name = cmd.name as string
  if (cmd.action === 'forget') {
    const { [name]: gone, ...rest } = stored
    return gone === undefined ? { text: `guard-context: "${name}" was not classified.` } : { text: `guard-context: forgot "${name}".`, stored: rest }
  }
  return { text: `guard-context: "${name}" is now ${cmd.cls}.`, stored: { ...stored, [name]: cmd.cls as Class } }
}
