import { stops } from './branch'
import { SECRET_PLACEHOLDER } from './calls'
import type { Config, Env, IdentityRule, Violation } from './rules'
import { IDENTITY_ENV, resolvePath, type GitCall } from './shell'

const IDENTITY_SUBS = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'am'])

const TAG_LONG = /^--(?:annotate|sign|message|file)(?:=|$)/

const IDENTITY_KEYS = new Set(['user.name', 'user.email', 'user.useconfigonly', 'author.name', 'author.email', 'committer.name', 'committer.email'])

export function annotates(call: GitCall): boolean {
  return call.args.some((a) => TAG_LONG.test(a) || /^-[A-Za-z]*[asmF]/.test(a))
}

function usesIdentity(call: GitCall): boolean {
  if (stops(call)) return false
  if (call.sub === 'tag') return annotates(call)
  return IDENTITY_SUBS.has(call.sub)
}

const INIT_THEN_COMMIT =
  'identity: this command creates a repository and commits in it in one step, so its identity cannot be checked first. Run git init on its own, then commit.'

export async function identityViolations(call: GitCall, cfg: Config, env: Env, created: boolean, configWritten = false): Promise<Violation[]> {
  if (!cfg.identityRules.length || !usesIdentity(call)) return []
  const add = (message: string): Violation[] => [{ rule: 'identity', mode: cfg.identity, message }]
  if (created) return add(INIT_THEN_COMMIT)
  const top = await env.git(call.dir, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return []
  if (configWritten) {
    return add('identity: an earlier call in this command may change git config, so the identity this commit would use cannot be checked. Run the git config on its own first, then commit.')
  }
  const toplevel = resolvePath('/', top.out, env.home)
  let best: { rule: IdentityRule; length: number } | null = null
  for (const rule of cfg.identityRules) {
    const root = resolvePath('/', rule.prefix, env.home)
    const hit = root === '/' || toplevel === root || toplevel.startsWith(root + '/')
    if (hit && (!best || root.length > best.length)) best = { rule, length: root.length }
  }
  // Identity keys and includes, in their order on the command line, so the last value wins as it does for git.
  const dashC = call.config
    .filter(([k]) => IDENTITY_KEYS.has(k.toLowerCase()) || k.toLowerCase() === 'include.path' || /^includeif\..+\.path$/i.test(k))
    .flatMap(([k, v]) => ['-c', `${k}=${v}`])
  // The guard can set variables for its probe but not remove them, so a cleared or unset identity variable cannot be checked.
  if (call.scrubbed) {
    return add('identity: this command clears environment variables git reads its identity from (env -i or env -u), so the identity cannot be checked. Run the commit without them.')
  }
  const probe = probeEnv(call.assigns)
  if (probe === null) {
    return [{ rule: 'unparsed', mode: cfg.identity, message: 'unparsed: GIT_CONFIG_COUNT is not a literal number up to 32, so the identity git would use cannot be checked. Use -c user.email=... instead.' }]
  }
  if (probe === 'other') {
    return add('identity: this command passes git config through GIT_CONFIG_PARAMETERS or an include.path in GIT_CONFIG_KEY_n, so the identity cannot be checked. Use -c user.email=... instead.')
  }
  const emailOf = async (role: 'AUTHOR' | 'COMMITTER'): Promise<string> => {
    const r = await env.git(call.dir, [...dashC, 'var', `GIT_${role}_IDENT`], probe)
    return r.ok ? (/<([^<>]*)>[^<>]*$/.exec(r.out.split('\n')[0] ?? '')?.[1]?.trim() ?? '') : ''
  }
  const author = await emailOf('AUTHOR')
  const committer = await emailOf('COMMITTER')
  if (!best) {
    return add(
      `identity: ${toplevel} is outside the configured identity roots, so a commit here would use ${author || 'an unset identity'}. Create the repository under a configured root or add a rule.`,
    )
  }
  const want = best.rule.email.toLowerCase()
  const roles: [string, string][] = [['this commit would use', author], ["this commit's committer would be", committer]]
  for (const [who, email] of roles) {
    if (email.toLowerCase() !== want) {
      return add(
        `identity: repositories under ${best.rule.prefix} commit as ${best.rule.email}, but ${who} ${email || 'an unset identity'}. Set user.email for this repository (or pass -c user.email=...) and retry.`,
      )
    }
  }
  return []
}

const MAX_CONFIG_COUNT = 32
const INCLUDE_KEY = /^include\.path$|^includeif\..+\.path$/i

// The environment of the identity probe: an exact allowlist of identity inputs, with GIT_CONFIG_COUNT/KEY_n/VALUE_n
// rebuilt and renumbered from identity keys only, so the command cannot make the probe trace, exec or read other
// config. Null when the count is not a literal integer up to 32; 'other' when the command passes config that may
// set the identity and the probe does not replay (GIT_CONFIG_PARAMETERS, or a counted include.path/includeIf key).
function probeEnv(assigns: Record<string, string>): Record<string, string> | null | 'other' {
  if (assigns.GIT_CONFIG_PARAMETERS !== undefined) return 'other'
  const out = Object.fromEntries(Object.entries(assigns).filter(([k]) => IDENTITY_ENV.test(k) && !/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(k)))
  const raw = assigns.GIT_CONFIG_COUNT
  if (raw === undefined) return out
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_CONFIG_COUNT) return null
  let n = 0
  for (let i = 0; i < Number(raw); i++) {
    const key = assigns[`GIT_CONFIG_KEY_${i}`]
    const value = assigns[`GIT_CONFIG_VALUE_${i}`]
    if (key === undefined || value === undefined) continue
    // An include may set the identity from a file, and replaying it would let the command make the probe read any config.
    if (INCLUDE_KEY.test(key) || /[$`]/.test(key) || SECRET_PLACEHOLDER.test(key)) return 'other'
    if (!IDENTITY_KEYS.has(key.toLowerCase())) continue
    out[`GIT_CONFIG_KEY_${n}`] = key
    out[`GIT_CONFIG_VALUE_${n}`] = value
    n++
  }
  if (n) out.GIT_CONFIG_COUNT = String(n)
  return out
}
