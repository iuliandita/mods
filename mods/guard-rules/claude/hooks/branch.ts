import { createTracker, REAL, UNKNOWN, type Possible } from './flow'
import { pushMessages } from './push'
import type { Config, Env, Violation } from './rules'
import type { GitCall } from './shell'
import type { ConfigTaint } from './state'

export const COMMIT_SUBS = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'am', 'rebase'])

const STOP_SUBS = new Set(['merge', 'cherry-pick', 'revert', 'am', 'rebase'])

const FOLLOWED_SUBS = new Set(['checkout', 'switch', 'rebase', 'symbolic-ref', 'update-ref'])

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${body}$`)
}

export function isProtected(branch: string, cfg: Config): boolean {
  return cfg.protectedBranches.some((p) => globToRegExp(p).test(branch))
}

// Only a bare `--abort` or `--quit` of a sequencer command stops it; the same word as a message does not.
export function stops(call: GitCall): boolean {
  return STOP_SUBS.has(call.sub) && call.args.length === 1 && (call.args[0] === '--abort' || call.args[0] === '--quit')
}

async function currentBranch(env: Env, dir: string): Promise<{ name: string | null; born: boolean }> {
  const head = await env.git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!head.ok || !head.out) return { name: null, born: true }
  const commit = await env.git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  return { name: head.out, born: commit.ok }
}

// REAL is the branch git reports; UNKNOWN is a branch the guard cannot tell (`git switch -`).
type Followed = Possible<{ cur: string; prev?: string } | { detached: true }>

export type Branch = { name: string | null; born: boolean; unknown?: boolean }

export type Follower = { branchOf(dir: string): Promise<Branch[]>; track(call: GitCall): Promise<void>; step(chain: number): void }

// Follows branch switches inside one command, per repository root, as the set of branches each repository could be on.
export function createFollower(env: Env): Follower {
  const repos = createTracker<Exclude<Followed, typeof REAL | typeof UNKNOWN>>((f) => ('detached' in f ? '\0detached' : `${f.cur}\0${f.prev ?? '\0'}`))
  const roots = new Map<string, string>()
  const real = new Map<string, Promise<Branch>>()
  const currentOf = (dir: string): Promise<Branch> => {
    let b = real.get(dir)
    if (b === undefined) real.set(dir, (b = currentBranch(env, dir)))
    return b
  }

  const rootOf = async (dir: string): Promise<string> => {
    let root = roots.get(dir)
    if (root === undefined) {
      const top = await env.git(dir, ['rev-parse', '--show-toplevel'])
      root = top.ok && top.out ? top.out : dir
      roots.set(dir, root)
    }
    return root
  }

  const to = async (dir: string, before: Followed[], name: string): Promise<Followed[]> => {
    let real: string | undefined
    if (before.includes(REAL)) real = (await currentOf(dir)).name ?? undefined
    return before.map((f) => ({ cur: name, prev: f === REAL ? real : f !== UNKNOWN && 'cur' in f ? f.cur : undefined }))
  }

  // The states after a switch, or undefined when the call does not switch.
  const after = async (call: GitCall, before: Followed[]): Promise<Followed[] | undefined> => {
    const { dir } = call
    if (call.sub === 'rebase') {
      // `git rebase <upstream> <branch>` checks out <branch> first, and stays on it.
      const branch = stops(call) ? undefined : rebaseBranch(call)
      return branch === undefined ? undefined : branch === UNKNOWN ? [UNKNOWN] : to(dir, before, branch)
    }
    if (call.sub === 'symbolic-ref' || call.sub === 'update-ref') {
      const head = headWrite(call)
      if (head === undefined) return undefined
      if (head === 'detach') return [{ detached: true }]
      return head === UNKNOWN ? [UNKNOWN] : to(dir, before, head)
    }
    const target = switchTarget(call)
    if (target === undefined) return undefined
    if (target === 'detach') return [{ detached: true }]
    if (target === 'unknown') return [UNKNOWN]
    if (target === 'prev') {
      // In a loop the previous branch depends on how many times the body ran.
      if (call.flow.loop) return [UNKNOWN]
      return before.map((f) => (f !== REAL && f !== UNKNOWN && 'cur' in f && f.prev !== undefined ? { cur: f.prev, prev: f.cur } : UNKNOWN))
    }
    if (target.sure) return to(dir, before, target.name)
    // A name with no local branch may still be created from a remote branch of that name (DWIM), so it is possible.
    const exists = await env.git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${target.name}`])
    const next = await to(dir, before, target.name)
    return exists.ok ? next : [...before, ...next]
  }

  return {
    async branchOf(dir) {
      if (!repos.size()) return [await currentOf(dir)]
      return Promise.all(
        repos.get(await rootOf(dir)).map(async (f): Promise<Branch> => {
          if (f === REAL) return currentOf(dir)
          if (f === UNKNOWN) return { name: null, born: true, unknown: true }
          if ('detached' in f) return { name: null, born: true }
          return { name: f.cur, born: (await env.git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok }
        }),
      )
    },

    step: repos.step,

    async track(call) {
      if (!FOLLOWED_SUBS.has(call.sub)) return
      const root = await rootOf(call.dir)
      const next = await after(call, repos.get(root))
      if (next) repos.set(root, next, call.flow)
    },
  }
}

const SWITCH_BOOL = new Set([
  '-q', '--quiet', '-f', '--force', '--discard-changes', '-m', '--merge', '--no-track', '--guess', '--no-guess', '--progress', '--no-progress',
  '--recurse-submodules', '--no-recurse-submodules', '--ignore-other-worktrees', '--overwrite-ignore', '--no-overwrite-ignore', '-l',
  '--ignore-skip-worktree-bits',
])
const REBASE_VALUE = new Set(['--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec', '-C', '--whitespace', '-S', '--gpg-sign'])

// Where a checkout or switch goes, getopt style (`-bmain`, `-qb main`, `--create=x`, `--orphan x`); undefined when
// it does not switch (`checkout -- file`, `checkout main file`). An option the guard does not know is `unknown`.
// `sure` means the branch is created or named after `--`, so it is the branch even when no local one exists yet.
type SwitchTarget = undefined | 'detach' | 'prev' | 'unknown' | { name: string; sure: boolean }

export function switchTarget(call: GitCall): SwitchTarget {
  const { sub, args } = call
  if (sub !== 'checkout' && sub !== 'switch') return undefined
  // A word that is not literal may be the branch, or split into more words; after a checkout `--` it is only a path.
  const dashAt = args.indexOf('--')
  if (call.dynArgs?.some((d, k) => d && (sub === 'switch' || dashAt === -1 || k < dashAt))) return 'unknown'
  const create = sub === 'checkout' ? 'bB' : 'cC'
  const createLong = sub === 'checkout' ? ['--orphan'] : ['--create', '--force-create', '--orphan']
  const positional: string[] = []
  let dashes = -1
  let track = false
  let detach = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (dashes !== -1 || a === '-' || a === '--' || !a.startsWith('-')) {
      if (a === '--' && dashes === -1) dashes = positional.length
      else positional.push(a)
      continue
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    const key = eq === -1 ? a : a.slice(0, eq)
    if (createLong.includes(key)) return { name: eq === -1 ? (args[++i] ?? '') : a.slice(eq + 1), sure: true }
    if (key === '--detach') detach = true
    else if (key === '--track') track = true
    else if (key === '--conflict' && eq !== -1) continue
    else if (SWITCH_BOOL.has(a)) continue
    else if (a.startsWith('--')) return 'unknown'
    else {
      for (let j = 1; j < a.length; j++) {
        const c = a[j]!
        if (create.includes(c)) {
          const name = j + 1 < a.length ? a.slice(j + 1) : args[++i]
          return name === undefined ? 'unknown' : { name, sure: true }
        }
        if (c === 't') track = true
        else if (c === 'd' && sub === 'switch') detach = true
        else if (!'qfml'.includes(c)) return 'unknown'
      }
    }
  }
  if (detach) return 'detach'
  // `checkout -- x` and `checkout main -- file` restore files; `checkout main --` and `switch -- main` switch.
  if (dashes !== -1 && sub === 'checkout' && dashes !== positional.length) return undefined
  if (positional.length !== 1) return undefined
  const name = positional[0]!
  if (name === '-' && dashes === -1) return 'prev'
  if (track) return { name: name.slice(name.indexOf('/') + 1), sure: true }
  return { name, sure: false }
}

// The branch `git rebase <upstream> <branch>` (or `--root <branch>`) checks out and rewrites, or undefined; UNKNOWN
// when a word is not literal, since it may name or split into that branch.
function rebaseBranch(call: GitCall): string | typeof UNKNOWN | undefined {
  const { args } = call
  if (call.dynArgs?.some(Boolean)) return UNKNOWN
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (REBASE_VALUE.has(a)) i++
    else if (!a.startsWith('-')) positional.push(a)
  }
  return args.includes('--root') ? positional[0] : positional[1]
}

// Where `git symbolic-ref HEAD <ref>` or `git update-ref --no-deref HEAD <rev>` points HEAD: a branch, 'detach',
// UNKNOWN (a ref outside refs/heads/, a deleted HEAD, or a word that is not literal), or undefined when HEAD stays.
function headWrite(call: GitCall): string | 'detach' | typeof UNKNOWN | undefined {
  const positional: string[] = []
  let del = false
  let noDeref = false
  for (let i = 0; i < call.args.length; i++) {
    const a = call.args[i]!
    if (a === '--') {
      positional.push(...call.args.slice(i + 1))
      break
    }
    if (a === '-m') i++
    else if (a === '-d' || a === '--delete') del = true
    else if (a === '--no-deref') noDeref = true
    else if (!a.startsWith('-')) positional.push(a)
  }
  const dynamic = call.dynArgs?.some(Boolean) ?? false
  if (call.sub === 'update-ref') {
    if (!noDeref || del || (positional[0] !== 'HEAD' && !dynamic)) return undefined
    return dynamic ? UNKNOWN : 'detach'
  }
  if (dynamic && positional.length) return UNKNOWN
  if (positional[0] !== 'HEAD') return undefined
  if (del) return UNKNOWN
  const ref = positional[1]
  if (ref === undefined) return undefined
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : UNKNOWN
}

export async function protectedBranchViolations(call: GitCall, cfg: Config, env: Env, follow: Follower, taint: ConfigTaint = { config: false, upstream: false }): Promise<Violation[]> {
  const out: Violation[] = []
  const hint = 'Work on a feature branch and land it by pull request; for an intentional direct change, ask the user to run it themselves with the ! prefix.'
  const add = (message: string) => out.push({ rule: 'protected-branch', mode: cfg.protectedBranch, message })
  const ffFlags = call.args.filter((a) => a === '--ff' || a === '--no-ff' || a === '--ff-only')
  const fastForward = call.sub === 'merge' && ffFlags[ffFlags.length - 1] === '--ff-only'
  const unknown = `protected-branch: an earlier "git switch", "git checkout", "git rebase" or "git symbolic-ref" in this command (such as "git switch -", a branch built from a variable, or an option the guard does not know) goes to a branch the guard cannot tell, so git ${call.sub} counts as on a protected branch. Run the switch on its own first. ${hint}`
  const rewritten = call.sub === 'rebase' && !stops(call) ? rebaseBranch(call) : undefined
  if (rewritten === UNKNOWN) {
    add(`protected-branch: git rebase names a branch built from a variable, substitution or secret placeholder, so it counts as rewriting a protected branch. ${hint}`)
  } else if (rewritten !== undefined && isProtected(rewritten, cfg)) {
    add(`protected-branch: git rebase rewrites protected branch "${rewritten}". ${hint}`)
  } else if (COMMIT_SUBS.has(call.sub) && !stops(call) && !fastForward) {
    const branches = await follow.branchOf(call.dir)
    const b = branches.find((x) => x.name && x.born && isProtected(x.name, cfg))
    if (b) add(`protected-branch: git ${call.sub} on protected branch "${b.name}". ${hint}`)
    else if (branches.some((x) => x.unknown)) add(unknown)
  } else if (call.sub === 'push') {
    for (const message of await pushMessages(call, env, follow, (n) => isProtected(n, cfg), hint, unknown, taint)) add(message)
  }
  return out
}
