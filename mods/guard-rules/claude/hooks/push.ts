import type { Branch, Follower } from './branch'
import type { Env } from './rules'
import type { GitCall } from './shell'
import type { ConfigTaint } from './state'

const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

const PUSH_BOOL = new Set([
  '--all', '--mirror', '--tags', '--follow-tags', '--no-follow-tags', '--force', '--force-with-lease', '--no-force-with-lease', '--force-if-includes',
  '--no-force-if-includes', '--dry-run', '--set-upstream', '--atomic', '--no-atomic', '--verify', '--no-verify', '--verbose', '--quiet', '--porcelain',
  '--delete', '--prune', '--thin', '--no-thin', '--progress', '--no-progress', '--ipv4', '--ipv6', '--signed', '--no-signed', '--no-recurse-submodules',
])

// The branch a refspec updates: `refs/heads/` or `heads/` is stripped; any other `refs/` name (but tags) is kept
// whole and counts as a wildcard, since git may resolve it to a branch.
function pushDestination(spec: string): string {
  const s = spec.replace(/^\+/, '')
  const colon = s.indexOf(':')
  const dst = (colon === -1 ? s : s.slice(colon + 1)).replace(/^(?:refs\/)?heads\//, '')
  return dst === 'HEAD' || dst === '@' ? '@current' : dst
}

function wildcardOf(name: string): boolean {
  return name.includes('*') || (name.startsWith('refs/') && !name.startsWith('refs/tags/'))
}

// The last value of a `-c` key (case-insensitive) on the call, or undefined.
function lastConfig(call: GitCall, key: string): string | undefined {
  return call.config.filter(([k]) => k.toLowerCase() === key.toLowerCase()).pop()?.[1]
}

type PushTargets = { all: string; names: string[]; implicit: boolean; sourceOnly: boolean }

// `all` names why every matching branch is pushed, or is empty. A long option the guard does not know, before the
// first positional, may take the next word as its value, so both readings count.
function pushTargets(args: string[]): PushTargets {
  const read = (valued: boolean): PushTargets & { unsure: boolean } => {
    const positional: string[] = []
    let all = ''
    let tags = false
    let unsure = false
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!
      if (PUSH_VALUE_OPTS.has(a)) i++
      else if (a === '--all' || a === '--mirror') all = '--all/--mirror'
      else if (a === '--tags') tags = true
      else if (a.startsWith('--') && !a.includes('=') && !PUSH_BOOL.has(a) && !positional.length) {
        unsure = true
        if (valued) i++
      } else if (a.startsWith('-')) continue
      else positional.push(a)
    }
    const refspecs = positional.slice(1)
    if (refspecs.some((s) => s.replace(/^\+/, '') === ':')) all ||= 'with the matching refspec ":"'
    return { all, names: refspecs.map(pushDestination), implicit: refspecs.length === 0 && !tags, sourceOnly: refspecs.some((s) => !s.includes(':')), unsure }
  }
  const plain = read(false)
  if (!plain.unsure) return plain
  const valued = read(true)
  return {
    all: plain.all || valued.all,
    names: [...plain.names, ...valued.names],
    implicit: plain.implicit || valued.implicit,
    sourceOnly: plain.sourceOnly || valued.sourceOnly,
  }
}

// Configured push refspecs of every remote (a superset of the one pushed to) and push.default.
async function pushConfig(call: GitCall, env: Env): Promise<{ specs: string[]; mode: string }> {
  const specs = call.config.filter(([k]) => /^remote\..+\.push$/i.test(k)).map(([, v]) => v)
  const listed = await env.git(call.dir, ['config', '--get-regexp', '^remote\\..*\\.push$'])
  if (listed.ok) {
    for (const line of listed.out.split('\n')) {
      const sp = line.indexOf(' ')
      if (sp > 0) specs.push(line.slice(sp + 1).trim())
    }
  }
  let mode = call.overrides['push.default']
  if (mode === undefined) {
    const r = await env.git(call.dir, ['config', '--get', 'push.default'])
    mode = r.ok ? r.out : ''
  }
  return { specs, mode: mode.trim().toLowerCase() }
}

// The protected-branch messages for a push: its explicit refspecs, else the configured push refspecs, push.default
// and the upstream, against the branches the follower says the repository could be on.
export async function pushMessages(
  call: GitCall, env: Env, follow: Follower, isProtected: (branch: string) => boolean, hint: string, unknown: string, taint: ConfigTaint,
): Promise<string[]> {
  const out: string[] = []
  const t = pushTargets(call.args)
  let known: Branch[] | undefined
  const cur = async () => (known ??= await follow.branchOf(call.dir)).map((b) => b.name)
  if (!t.all && (t.implicit || t.sourceOnly)) {
    const conf = await pushConfig(call, env)
    // The configuration read above predates the command, so an earlier write in it leaves the destination unknown.
    const upstreamMode = t.implicit && !conf.specs.length && (conf.mode === 'upstream' || conf.mode === 'tracking')
    if (taint.config || (taint.upstream && upstreamMode)) {
      return [
        `protected-branch: an earlier call in this command changes git config or a branch upstream, so where this git push goes cannot be told and it counts as a push to a protected branch. Run that call on its own first, or name the destination (git push origin HEAD:<branch>). ${hint}`,
      ]
    }
    for (const spec of conf.specs) {
      if (spec.replace(/^\+/, '') === ':') t.all ||= 'with a configured matching refspec ":"'
      else t.names.push(pushDestination(spec))
    }
    const branches = t.implicit && !conf.specs.length && (conf.mode === 'upstream' || conf.mode === 'tracking') ? await cur() : []
    if (t.implicit && !conf.specs.length && conf.mode === 'matching') t.all = 'with push.default=matching'
    for (const branch of branches) {
      if (!branch) continue
      const given = lastConfig(call, `branch.${branch}.merge`)
      const merge = given !== undefined ? { ok: true, out: given } : await env.git(call.dir, ['config', '--get', `branch.${branch}.merge`])
      if (merge.ok && merge.out) t.names.push(merge.out.trim().replace(/^refs\/heads\//, ''))
    }
  }
  const wildcard = t.names.find(wildcardOf)
  if (t.all) {
    out.push(`protected-branch: git push ${t.all} would update protected branches. ${hint}`)
  } else if (wildcard !== undefined) {
    out.push(`protected-branch: git push to the wildcard destination "${wildcard}" would update protected branches. ${hint}`)
  } else {
    const current = t.implicit || t.names.includes('@current') ? await cur() : []
    const targets = t.names.flatMap((n) => (n === '@current' ? current : [n])).concat(t.implicit ? current : [])
    const hit = targets.find((n): n is string => n !== null && isProtected(n))
    if (hit) out.push(`protected-branch: git push to protected branch "${hit}". ${hint}`)
    else if (known?.some((b) => b.unknown)) out.push(unknown)
  }

  return out
}
