import { COMMIT_SUBS, createFollower, protectedBranchViolations } from './branch'
import { contextViolations, followSwitch, isMutating, newContextState, stepContext, type Classes } from './context'
import { annotates, identityViolations } from './identity'
import { extractCalls, resolvePath, tokenize, type Call, type GhCall, type GitCall, type Parsed } from './shell'
import { taintConfig, type ConfigTaint } from './state'
import { SHELL_NAMES, toolWords } from './words'

export type Mode = 'off' | 'dry' | 'on'
export type RuleId = 'attribution' | 'protected-branch' | 'identity' | 'context' | 'unparsed' | 'config' | 'lookup'
export type Violation = { rule: RuleId; mode: Mode; message: string }
export type IdentityRule = { prefix: string; email: string }

export type Config = {
  attribution: Mode
  protectedBranch: Mode
  identity: Mode
  context: Mode
  unparsed: Mode
  protectedBranches: string[]
  unprotectedRepos: string[]
  identityRules: IdentityRule[]
  protectedContexts: string[]
  relaxedContexts: string[]
  error?: string
}

// `failed` means git could not be run at all (thrown or timed out), never a non-zero exit.
export type GitResult = { ok: boolean; out: string; failed?: boolean }

export interface Env {
  cwd: string
  home: string
  // `env` is set over the guard's own environment for the child.
  git(dir: string, args: string[], env?: Record<string, string>): Promise<GitResult>
  run(dir: string, argv: string[], env?: Record<string, string>): Promise<GitResult>
  contexts(): Promise<Classes>
  // Null when the file cannot be read.
  read(path: string): Promise<string | null>
  // Throws when existence cannot be established; omitted by in-memory test environments.
  exists?(path: string): Promise<boolean>
}

export type Verdict = { enforced: Violation[]; dry: Violation[] }

const GH_MESSAGE: Record<string, Set<string>> = {
  pr: new Set(['create', 'edit', 'comment', 'review', 'merge']),
  issue: new Set(['create', 'edit', 'comment']),
  release: new Set(['create', 'edit']),
}
const GLAB_VERBS = new Set(['create', 'update', 'note', 'edit', 'merge'])
const TEA_VERBS = new Set(['create', 'edit', 'comment'])
const FJ_VERBS = new Set(['create', 'edit', 'comment', 'merge'])
const FORGE_MESSAGE: Record<GhCall['cli'], Record<string, Set<string>>> = {
  gh: GH_MESSAGE,
  glab: { mr: GLAB_VERBS, issue: GLAB_VERBS, release: GLAB_VERBS },
  tea: Object.fromEntries(['pulls', 'pr', 'issues', 'issue', 'releases', 'release'].map((a) => [a, TEA_VERBS])),
  fj: { pr: FJ_VERBS, issue: FJ_VERBS, release: FJ_VERBS },
}
const DEFAULT_PROTECTED_CONTEXTS = '*prod*,*production*,*live*,*qa*,*staging*,*stage*,*uat*,*preprod*,*pre-prod*'
const DEFAULT_RELAXED_CONTEXTS = '*dev*,*development*,*test*,*local*,*sandbox*,minikube,kind-*,k3d-*,docker-desktop,rancher-desktop'
const BODY_FILE_OPTS = new Set(['-F', '--body-file', '--notes-file', '--description-file'])

const ATTRIBUTION: { name: string; re: RegExp }[] = [
  { name: 'a Co-Authored-By trailer', re: /(?:^|["']|\\n)[ \t]*co-authored-by:/im },
  { name: 'a "Generated with ... Claude" line', re: /(?:^|["']|\\n)[ \t]*(?:\u{1F916}[ \t]*)?generated with[^\n]*claude/imu },
  { name: 'a Claude-Session trailer', re: /(?:^|["']|\\n)[ \t]*claude-session:/im },
  { name: 'a Co-Authored-By trailer', re: /--trailer[= ]\s*["']?(?:co-authored-by|claude-session)\b/i },
  { name: 'a claude.ai session link', re: /claude\.ai\/code\/session_/i },
  { name: 'a Claude Code link', re: /claude\.com\/claude-code/i },
  { name: 'a robot-emoji line', re: /(?:^|["']|\\n)[ \t]*\u{1F916}/imu },
]
const INFRA_TOOLS = new Set(['kubectl', 'helm', 'terraform', 'tofu'])
const ATTRIBUTION_HINT = ' If this text is not part of a commit or PR message, run the git or gh command separately from the command that contains it.'

function parseList(value: unknown, fallback: string): string[] {
  return String(value ?? fallback)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

function parseMode(value: unknown, name: string, errors: string[]): Mode {
  const v = value === undefined || value === null ? '' : String(value).trim().toLowerCase()
  if (v === '') return 'on'
  if (v === 'off' || v === 'dry' || v === 'on') return v
  errors.push(`${name} must be off, dry or on`)
  return 'on'
}

export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const errors: string[] = []
  const branches = String(options.protectedBranches ?? 'develop,main')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)
  if (!branches.length) errors.push('protectedBranches must name at least one branch (set modeProtectedBranch to off to turn the rule off)')
  let identityRules: IdentityRule[] = []
  const raw = String(options.identityRules ?? '').trim()
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      const valid =
        Array.isArray(parsed) &&
        parsed.every(
          (r) =>
            r !== null &&
            typeof r === 'object' &&
            typeof (r as IdentityRule).prefix === 'string' &&
            typeof (r as IdentityRule).email === 'string' &&
            (r as IdentityRule).prefix.length > 0 &&
            (r as IdentityRule).email.trim().length > 0,
        )
      if (valid) identityRules = parsed as IdentityRule[]
      else errors.push('identityRules must be a JSON array of {"prefix", "email"} objects')
    } catch {
      errors.push('identityRules is not valid JSON')
    }
  }
  return {
    attribution: parseMode(options.modeAttribution, 'modeAttribution', errors),
    protectedBranch: parseMode(options.modeProtectedBranch, 'modeProtectedBranch', errors),
    identity: parseMode(options.modeIdentity, 'modeIdentity', errors),
    context: parseMode(options.modeContext, 'modeContext', errors),
    unparsed: parseMode(options.modeUnparsed, 'modeUnparsed', errors),
    protectedBranches: branches,
    unprotectedRepos: parseList(options.unprotectedRepos, ''),
    identityRules,
    protectedContexts: parseList(options.protectedContexts, DEFAULT_PROTECTED_CONTEXTS),
    relaxedContexts: parseList(options.relaxedContexts, DEFAULT_RELAXED_CONTEXTS),
    error: errors.length ? errors.join('; ') : undefined,
  }
}

function isMessageCall(call: Call): boolean {
  if (call.kind === 'gh') {
    const areas = FORGE_MESSAGE[call.cli]
    return (Object.hasOwn(areas, call.area) && areas[call.area]?.has(call.verb)) || false
  }
  if (call.kind === 'infra') return false
  if (call.sub === 'tag') return annotates(call)
  return call.sub === 'commit' || call.sub === 'merge' || call.sub === 'revert'
}

function isGuarded(call: Call, cfg: Config): boolean {
  if (call.kind === 'gh') return isMessageCall(call)
  if (call.kind === 'infra') return cfg.context !== 'off' && isMutating(call)
  if (call.sub === 'tag') return annotates(call)
  return COMMIT_SUBS.has(call.sub) || call.sub === 'push'
}

function attributionViolations(text: string, cfg: Config, where = 'the command'): Violation[] {
  return ATTRIBUTION.filter((p) => p.re.test(text)).map((p) => ({
    rule: 'attribution',
    mode: cfg.attribution,
    message: `attribution: ${where} contains ${p.name}. AI attribution does not belong in commits, tags, PRs or issues; remove it and retry.${where === 'the command' ? ATTRIBUTION_HINT : ''}`,
  }))
}

// Literal gh and glab body files (`-F`, `--body-file`, `--notes-file`, `--description-file`); stdin and variables are not followed.
function bodyFiles(call: GhCall, home: string): string[] {
  if (call.cli !== 'gh' && call.cli !== 'glab') return []
  const out: string[] = []
  for (let i = 0; i < call.args.length && call.args[i] !== '--'; i++) {
    const a = call.args[i]!
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    const key = eq !== -1 ? a.slice(0, eq) : a.startsWith('-F') && !a.startsWith('--') ? '-F' : a
    const value = eq !== -1 ? a.slice(eq + 1) : key === '-F' && a.length > 2 ? a.slice(2) : BODY_FILE_OPTS.has(key) ? call.args[++i] : undefined
    if (BODY_FILE_OPTS.has(key) && value && value !== '-' && !/[$`]/.test(value)) out.push(resolvePath(call.dir, value, home))
  }
  return out
}

function strictest(modes: Mode[]): Mode {
  return modes.includes('on') ? 'on' : modes.includes('dry') ? 'dry' : 'off'
}

// A construct the guard does not model (`opaque`) is unparsed when the command names a tool anywhere; a command it
// does not model that names a tool among its own words (`local`), or a guarded git call in a repository the guard
// cannot follow, is unparsed by itself. Git and forge tools take the strictest git-side mode, infra tools the
// context mode, and a shell name both.
function unparsedViolations(command: string, parsed: Parsed, guarded: Call[], cfg: Config): Violation[] {
  if (cfg.unparsed === 'off') return []
  const cap = (mode: Mode): Mode => cfg.unparsed === 'dry' && mode === 'on' ? 'dry' : mode
  const tools = new Map<string, string>()
  // `${G:-git}` names git through a default-value operator.
  const plain = command.replace(/["'\\]/g, '').replace(/\$\{\w*:?[-=+?]/g, ' ')
  if (parsed.opaque.length) {
    const why = parsed.opaque[0]!
    for (const t of toolWords(plain, { anyCase: true })) tools.set(t, why)
    for (const call of parsed.calls) tools.set(call.kind === 'infra' ? call.tool : call.kind === 'gh' ? call.cli : 'git', why)
  }
  for (const l of parsed.local) for (const t of l.tools) if (!tools.has(t)) tools.set(t, l.why)
  const call = guarded.find((c): c is GitCall => c.kind === 'git' && c.opaque !== undefined)
  if (call && !tools.has('git')) tools.set('git', call.opaque!)
  const named = [...tools.keys()]
  const gitWhy = named.filter((t) => !INFRA_TOOLS.has(t)).map((t) => tools.get(t)!)[0]
  const infraWhy = named.filter((t) => INFRA_TOOLS.has(t) || SHELL_NAMES.includes(t)).map((t) => tools.get(t)!)[0]
  const out: Violation[] = []
  const hint = 'Use literal command words and simple quoting, without nested or piped scripts, and retry.'
  if (gitWhy !== undefined) {
    out.push({
      rule: 'unparsed',
      mode: cap(strictest(cfg.identityRules.length ? [cfg.attribution, cfg.protectedBranch, cfg.identity] : [cfg.attribution, cfg.protectedBranch])),
      message: `unparsed: this command uses ${gitWhy}, which the guard cannot follow, and it names git or a forge CLI. ${hint}`,
    })
  }
  if (infraWhy !== undefined) {
    out.push({ rule: 'unparsed', mode: cap(cfg.context), message: `unparsed: this command uses ${infraWhy}, which the guard cannot follow, and it names kubectl, helm or terraform. ${hint}` })
  }
  return out
}

export async function evaluate(command: string, cfg: Config, rawEnv: Env): Promise<Verdict> {
  const all: Violation[] = []
  let gitLookupFailed = false
  let runLookupFailed = false
  const env: Env = {
    ...rawEnv,
    git: async (dir, args, vars) => {
      const r = await rawEnv.git(dir, args, vars)
      if (r.failed) gitLookupFailed = true
      return r
    },
    run: async (dir, argv, vars) => {
      const r = await rawEnv.run(dir, argv, vars)
      if (r.failed) runLookupFailed = true
      return r
    },
  }
  const parsed = extractCalls(command, env.cwd, env.home)
  const guarded = parsed.calls.filter((c) => isGuarded(c, cfg))

  all.push(...unparsedViolations(command, parsed, guarded, cfg))
  if (guarded.length && cfg.error) {
    all.push({ rule: 'config', mode: 'on', message: `config: guard-rules settings are invalid (${cfg.error}). Fix them in the plugin options.` })
  }
  if (cfg.attribution !== 'off' && parsed.calls.some(isMessageCall)) {
    all.push(...attributionViolations(command, cfg))
    // Scan words separately so quote boundaries and escapes cannot split a trailer, and a word's start stays visible.
    for (const word of tokenize(command).cmds.flatMap((c) => c.argv)) all.push(...attributionViolations(word, cfg))
    for (const call of parsed.calls) for (const word of call.args) all.push(...attributionViolations(word, cfg))
    for (const call of parsed.calls) {
      if (call.kind !== 'gh' || !isMessageCall(call)) continue
      for (const path of bodyFiles(call, env.home)) {
        const text = await env.read(path)
        if (text !== null) all.push(...attributionViolations(text, cfg, `the body file ${path}`))
      }
    }
  }
  const follow = createFollower(env)
  const directoryMode = strictest(cfg.identityRules.length ? [cfg.attribution, cfg.protectedBranch, cfg.identity] : [cfg.attribution, cfg.protectedBranch])
  let created = false
  let taint: ConfigTaint = { config: false, upstream: false }
  const switched = newContextState()
  for (const call of parsed.calls) {
    if (call.kind === 'infra') {
      stepContext(switched, call.flow.chain)
      all.push(...(await contextViolations(call, cfg, env, switched)))
      await followSwitch(call, switched, env)
      continue
    }
    if (call.kind !== 'git') continue
    if (call.unresolvedDir && isGuarded(call, cfg)) {
      all.push({
        rule: 'lookup',
        mode: directoryMode,
        message: `lookup: the directory for git ${call.sub} cannot be resolved, so its repository cannot be checked. Use a literal directory or run the directory change on its own first.`,
      })
    }
    follow.step(call.flow.chain)
    if (cfg.protectedBranch !== 'off') all.push(...(await protectedBranchViolations(call, cfg, env, follow, taint)))
    if (cfg.identity !== 'off') all.push(...(await identityViolations(call, cfg, env, created, taint.config)))
    if (cfg.protectedBranch !== 'off') await follow.track(call)
    taint = taintConfig(taint, call)
    if (call.sub === 'init' || call.sub === 'clone') created = true
  }
  const lookupMode = strictest(cfg.identityRules.length ? [cfg.protectedBranch, cfg.identity] : [cfg.protectedBranch])
  if (gitLookupFailed && lookupMode !== 'off') {
    all.push({
      rule: 'lookup',
      mode: lookupMode,
      message:
        'lookup: git could not be run to check the branch or identity (it failed or timed out), so the command was blocked. Retry it; if this keeps happening, set the rule modes to off in the plugin options.',
    })
  }
  if (runLookupFailed && cfg.context !== 'off') {
    all.push({
      rule: 'lookup',
      mode: cfg.context,
      message:
        'lookup: the current kubectl context or terraform workspace could not be read (the command failed or timed out), so the command was blocked. Retry it, or name the environment in the command (--context, --kube-context, TF_WORKSPACE); if this keeps happening, set modeContext to off in the plugin options.',
    })
  }

  const seen = new Set<string>()
  const unique = all.filter((v) => !seen.has(v.message) && seen.add(v.message))
  return {
    enforced: unique.filter((v) => v.mode === 'on'),
    dry: unique.filter((v) => v.mode === 'dry'),
  }
}

export function formatDeny(violations: Violation[]): string {
  return violations.map((v) => `guard-rules: ${v.message}`).join('\n')
}
