import { expect, test } from 'claude-code/testing'

import { evaluate, formatDeny, parseConfig, type Config, type Env } from './rules'

type Repo = {
  branch?: string | null
  born?: boolean
  toplevel?: string
  email?: string
  authorEmail?: string
  isRepo?: boolean
  refs?: string[]
  topOf?: (dir: string) => string
  context?: string
  workspace?: string
  stored?: Record<string, 'protected' | 'relaxed'>
  gitConfig?: Record<string, string>
  files?: Record<string, string>
  cwd?: string
  // Overrides per repository, keyed by topOf(dir) (default: toplevel for every directory).
  repos?: Record<string, Partial<Repo>>
}

type Seen = [dir: string, args: string[], env: Record<string, string> | undefined]

function fakeEnv(repo: Repo = {}): Env & { calls: string[]; ran: string[]; seen: Seen[] } {
  const base = { branch: 'feature/x', born: true, toplevel: '/h/personal/repo', email: 'me@personal.example', isRepo: true, refs: ['develop', 'main', 'feature/x', 'feat'], context: '', workspace: 'default', stored: {}, gitConfig: {}, files: {}, ...repo }
  const at = (dir: string) => {
    const top = base.topOf ? base.topOf(dir) : base.toplevel
    return { ...base, ...base.repos?.[top], toplevel: top }
  }
  const calls: string[] = []
  const ran: string[] = []
  const seen: Seen[] = []
  return {
    cwd: base.cwd ?? '/h/personal/repo',
    home: '/h',
    calls,
    ran,
    seen,
    run: async (dir, argv, env) => {
      const key = argv.join(' ')
      ran.push(key)
      seen.push([dir, argv, env])
      const r = at(dir)
      if (key === 'kubectl config current-context') return r.context ? { ok: true, out: r.context } : { ok: false, out: '' }
      if (key.endsWith(' workspace show')) return { ok: true, out: r.workspace }
      return { ok: false, out: '' }
    },
    contexts: async () => base.stored,
    read: async (path) => base.files[path] ?? null,
    git: async (dir, args, env) => {
      const key = args.join(' ')
      calls.push(key)
      seen.push([dir, args, env])
      const r = at(dir)
      if (!r.isRepo) return { ok: false, out: '' }
      if (key.startsWith('config --get-regexp')) {
        const lines = Object.entries(r.gitConfig).filter(([k]) => /^remote\..+\.push$/.test(k)).map(([k, v]) => `${k} ${v}`)
        return { ok: lines.length > 0, out: lines.join('\n') }
      }
      if (key.startsWith('config --get ')) {
        const v = r.gitConfig[key.slice('config --get '.length)]
        return v === undefined ? { ok: false, out: '' } : { ok: true, out: v }
      }
      if (key.startsWith('symbolic-ref')) return r.branch ? { ok: true, out: r.branch } : { ok: false, out: '' }
      const refPrefix = 'rev-parse --verify --quiet refs/heads/'
      if (key.startsWith(refPrefix)) return { ok: r.refs.includes(key.slice(refPrefix.length)), out: '' }
      if (key.startsWith('rev-parse --verify')) return { ok: r.born, out: '' }
      if (key.startsWith('rev-parse --show-toplevel')) return { ok: true, out: r.toplevel }
      const ident = /^((?:-c \S+ )*)var GIT_(AUTHOR|COMMITTER)_IDENT$/.exec(key)
      if (ident) {
        const override = /-c user\.email=(\S+)/.exec(ident[1] ?? '')?.[1]
        const email = env?.[`GIT_${ident[2]}_EMAIL`] ?? (ident[2] === 'AUTHOR' ? r.authorEmail : undefined) ?? override ?? env?.EMAIL ?? r.email
        return email ? { ok: true, out: `Me <${email}> 1700000000 +0000` } : { ok: false, out: '' }
      }
      return { ok: false, out: '' }
    },
  }
}

const IDENTITIES = JSON.stringify([
  { prefix: '~/personal/', email: 'me@personal.example' },
  { prefix: '~/office/', email: 'me@work.example' },
])

function cfg(options: Record<string, string> = {}): Config {
  return parseConfig(options)
}

const heredoc = (msg: string) => `git commit -m "$(cat <<'EOF'\n${msg}\nEOF\n)"`

const ROBOT = String.fromCodePoint(0x1f916)
const TRAILER = '"Co-Authored-By: A <a@b.c>"'

const broken = (): Env & { calls: string[] } => ({
  cwd: '/h/personal/repo',
  home: '/h',
  calls: [],
  git: async () => ({ ok: false, out: '', failed: true }),
  run: async () => ({ ok: false, out: '', failed: true }),
  contexts: async () => ({}),
  read: async () => null,
})

test('config: defaults protect develop and main with every mode on, and bad options are collected, not thrown', () => {
  const c = cfg()
  expect(c.protectedBranches).toEqual(['develop', 'main'])
  expect([c.attribution, c.protectedBranch, c.identity]).toEqual(['on', 'on', 'on'])
  expect(c.identityRules).toEqual([])
  expect(c.error).toBeUndefined()
  expect(cfg({ identityRules: 'nope' }).error).toContain('identityRules is not valid JSON')
  expect(cfg({ identityRules: '[{"prefix":"x"}]' }).error).toContain('identityRules must be a JSON array')
  expect(cfg({ modeIdentity: 'sometimes' }).error).toContain('modeIdentity must be off, dry or on')
})

test('attribution: a trailer in a heredoc commit message is denied, prose about trailers is not', async () => {
  const e = fakeEnv()
  const v = await evaluate(heredoc('feat: x\n\nCo-Authored-By: A <a@b.c>'), cfg(), e)
  expect(v.enforced).toHaveLength(1)
  expect(formatDeny(v.enforced)).toContain('guard-rules: attribution')
  expect((await evaluate('git commit -m "docs: explain why Co-Authored-By: lines are blocked"', cfg(), e)).enforced).toEqual([])
  expect((await evaluate('git commit -m "fix: files generated with the claude CLI are stable"', cfg(), e)).enforced).toEqual([])
  expect((await evaluate('echo "Co-Authored-By: x" > note.txt', cfg(), e)).enforced).toEqual([])
  expect((await evaluate(heredoc('feat: clean message'), cfg(), e)).enforced).toEqual([])
})

test('attribution: PR bodies, annotated tags and --trailer are scanned, lightweight tags are not', async () => {
  const e = fakeEnv()
  const pr = `gh pr create --title t --body "$(cat <<'EOF'\n${ROBOT} Generated with [Claude Code](https://claude.com/claude-code)\nEOF\n)"`
  expect((await evaluate(pr, cfg(), e)).enforced.length).toBeGreaterThan(0)
  expect((await evaluate(`git tag -a v1 -m ${TRAILER}`, cfg(), e)).enforced).toHaveLength(1)
  expect((await evaluate(`glab mr create --description ${TRAILER}`, cfg(), e)).enforced).toHaveLength(1)
  expect((await evaluate('git commit -m x --trailer "Co-Authored-By: A"', cfg(), e)).enforced).toHaveLength(1)
  expect((await evaluate(`git tag v1 ${TRAILER}`, cfg(), e)).enforced).toEqual([])
  expect((await evaluate(`fj -H forge.example pr create --body ${TRAILER}`, cfg(), e)).enforced).toHaveLength(1)
  expect((await evaluate(`gh constructor create --body ${TRAILER}`, cfg(), e)).enforced).toEqual([])
})

test('protected branch: commits on develop or main are denied; feature, detached, unborn and aborts pass', async () => {
  for (const sub of ['commit -m x', 'merge feature', 'rebase main']) {
    const v = await evaluate(`git ${sub}`, cfg(), fakeEnv({ branch: 'develop' }))
    expect(v.enforced).toHaveLength(1)
    expect(v.enforced[0]?.message).toContain('! prefix')
  }
  expect((await evaluate('git commit -m x', cfg(), fakeEnv({ branch: 'main' }))).enforced).toHaveLength(1)
  expect((await evaluate('git commit -m x', cfg(), fakeEnv({ branch: 'feature/x' }))).enforced).toEqual([])
  expect((await evaluate('git commit -m x', cfg(), fakeEnv({ branch: null }))).enforced).toEqual([])
  expect((await evaluate('git commit -m x', cfg(), fakeEnv({ branch: 'develop', born: false }))).enforced).toEqual([])
  expect((await evaluate('git merge --abort', cfg(), fakeEnv({ branch: 'develop' }))).enforced).toEqual([])
  expect((await evaluate('git merge --ff-only feature/x', cfg(), fakeEnv({ branch: 'develop' }))).enforced).toEqual([])
})

test('protected push: refspecs, --all and implicit pushes to a protected branch are denied, other pushes pass', async () => {
  const onFeature = () => fakeEnv({ branch: 'feature/x' })
  for (const cmd of ['git push origin main', 'git push origin HEAD:main', 'git push origin +feature/x:develop', 'git push origin :main', 'git push --all origin']) {
    expect((await evaluate(cmd, cfg(), onFeature())).enforced).toHaveLength(1)
  }
  expect((await evaluate('git push origin HEAD', cfg(), fakeEnv({ branch: 'develop' }))).enforced).toHaveLength(1)
  expect((await evaluate('git push', cfg(), fakeEnv({ branch: 'develop' }))).enforced).toHaveLength(1)
  expect((await evaluate('git push -u origin feature/x', cfg(), onFeature())).enforced).toEqual([])
  expect((await evaluate('git push origin v1.0', cfg(), onFeature())).enforced).toEqual([])
  expect((await evaluate('git push --tags', cfg(), fakeEnv({ branch: 'develop' }))).enforced).toEqual([])
})

test('unprotectedRepos: a listed repository may commit, merge, rebase and push to a protected branch, any other may not', async () => {
  const c = cfg({ unprotectedRepos: ' ~/notes , ,/srv/vault ' })
  expect(c.unprotectedRepos).toEqual(['~/notes', '/srv/vault'])
  expect(cfg().unprotectedRepos).toEqual([])
  const at = (toplevel: string) => fakeEnv({ branch: 'main', toplevel })
  for (const cmd of ['git commit -m x', 'git merge feature/x', 'git rebase develop', 'git push origin main', 'git push']) {
    expect((await evaluate(cmd, c, at('/h/notes'))).enforced, cmd).toEqual([])
    expect((await evaluate(cmd, c, at('/h/notes/sub/repo'))).enforced, cmd).toEqual([])
    expect((await evaluate(cmd, c, at('/srv/vault'))).enforced, cmd).toEqual([])
    expect((await evaluate(cmd, c, at('/h/personal/repo'))).enforced, cmd).toHaveLength(1)
    expect((await evaluate(cmd, cfg(), at('/h/notes'))).enforced, cmd).toHaveLength(1)
  }
  // The exemption is decided per call, so a listed repository does not cover another repository in the same command.
  const both = await evaluate('git -C /h/notes commit -m x && git -C /h/work/prod commit -m x', c, fakeEnv({ branch: 'main', topOf: (d) => d }))
  expect(both.enforced).toHaveLength(1)
  // The prefix match stops at a path boundary, and a parent of a listed repository is not listed.
  for (const toplevel of ['/h/notes-old', '/h/notesx/repo', '/h', '/srv']) {
    expect((await evaluate('git commit -m x', c, at(toplevel))).enforced, toplevel).toHaveLength(1)
  }
})

test('unprotectedRepos: attribution and identity still apply in a listed repository', async () => {
  const c = cfg({ unprotectedRepos: '~/personal/', identityRules: IDENTITIES })
  const main = (email = 'me@personal.example') => fakeEnv({ branch: 'main', email })
  expect((await evaluate('git commit -m x', c, main())).enforced).toEqual([])
  const attribution = await evaluate(heredoc('feat: x\n\nCo-Authored-By: A <a@b.c>'), c, main())
  expect(attribution.enforced.map((x) => x.rule)).toEqual(['attribution'])
  const identity = await evaluate('git commit -m x', c, main('me@work.example'))
  expect(identity.enforced.map((x) => x.rule)).toEqual(['identity'])
})

test('unprotectedRepos: a toplevel lookup that fails or finds no repository does not exempt', async () => {
  const c = cfg({ unprotectedRepos: '~/personal' })
  for (const failure of [{ ok: false, out: '', failed: true }, { ok: false, out: '' }, { ok: true, out: '' }]) {
    const e = fakeEnv({ branch: 'main' })
    const git = e.git
    e.git = async (dir, args, env) => (args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? failure : git(dir, args, env))
    const rules = (await evaluate('git commit -m x', c, e)).enforced.map((x) => x.rule)
    expect(rules, JSON.stringify(failure)).toContain('protected-branch')
  }
})

test('branch switches inside one command are followed', async () => {
  expect((await evaluate('git checkout -b feat/x && git commit -m x', cfg(), fakeEnv({ branch: 'develop' }))).enforced).toEqual([])
  expect((await evaluate('git switch -c feat/x && git add . && git commit -m x', cfg(), fakeEnv({ branch: 'develop' }))).enforced).toEqual([])
  expect((await evaluate('git switch develop && git commit -m x', cfg(), fakeEnv({ branch: 'feature/x' }))).enforced).toHaveLength(1)
  expect((await evaluate('git checkout -b main && git commit -m x', cfg(), fakeEnv())).enforced).toHaveLength(1)
})

test('identity: the repository must commit as its rule email, as git resolves it', async () => {
  const c = cfg({ identityRules: IDENTITIES })
  expect((await evaluate('git commit -m x', c, fakeEnv())).enforced).toEqual([])
  const wrong = await evaluate('git commit -m x', c, fakeEnv({ email: 'me@work.example' }))
  expect(wrong.enforced[0]?.message).toContain('me@personal.example')
  expect(wrong.enforced[0]?.message).toContain('me@work.example')
  expect((await evaluate('git commit -m x', c, fakeEnv({ email: '' }))).enforced[0]?.message).toContain('an unset identity')
  expect((await evaluate('git commit -m x', c, fakeEnv({ toplevel: '/tmp/scratch' }))).enforced[0]?.message).toContain('outside the configured identity roots')
  expect((await evaluate('git -c user.email=me@personal.example commit -m x', c, fakeEnv({ email: 'me@work.example' }))).enforced).toEqual([])
  const committer = await evaluate('GIT_COMMITTER_EMAIL=me@work.example git -c user.email=me@personal.example commit -m x', c, fakeEnv())
  expect(committer.enforced).toHaveLength(1)
  expect(committer.enforced[0]?.message).toContain('committer')
})

test('identity: the email git reports for the author is what counts, not the config value', async () => {
  const c = cfg({ identityRules: IDENTITIES })
  const v = await evaluate('git commit -m x', c, fakeEnv({ email: 'me@personal.example', authorEmail: 'me@work.example' }))
  expect(v.enforced).toHaveLength(1)
  expect(v.enforced[0]?.message).toContain('me@work.example')
})

test('identity: only identity keys from -c are replayed into the guard\'s own git calls', async () => {
  const e = fakeEnv({ email: 'me@work.example' })
  const v = await evaluate('git -c core.pager=evil -c user.email=me@personal.example commit -m x', cfg({ identityRules: IDENTITIES }), e)
  expect(v.enforced).toEqual([])
  expect(e.calls.some((c) => c.includes('user.email=me@personal.example'))).toBe(true)
  expect(e.calls.some((c) => c.includes('core.'))).toBe(false)
})

test('identity: inert without rules, and never asks git', async () => {
  const e = fakeEnv({ email: 'someone@else.example' })
  expect((await evaluate('git commit -m x', cfg(), e)).enforced).toEqual([])
  expect(e.calls.some((c) => c.includes('var GIT_'))).toBe(false)
})

test('unparsed and invalid config deny git writes only', async () => {
  const unparsed = await evaluate('git commit -m "oops', cfg(), fakeEnv())
  expect(unparsed.enforced.some((x) => x.rule === 'unparsed')).toBe(true)
  expect((await evaluate('echo "oops', cfg(), fakeEnv())).enforced).toEqual([])
  const bad = cfg({ identityRules: 'nope' })
  expect((await evaluate('git commit -m x', bad, fakeEnv())).enforced.some((x) => x.rule === 'config')).toBe(true)
  expect((await evaluate('ls -la', bad, fakeEnv())).enforced).toEqual([])
})

test('lookup: a git call that could not run denies, while a non-repository still passes', async () => {
  const v = await evaluate('git commit -m x', cfg(), broken())
  expect(v.enforced.map((x) => x.rule)).toEqual(['lookup'])
  expect(v.enforced[0]?.message).toContain('failed or timed out')
  const identity = await evaluate('git commit -m x', cfg({ identityRules: IDENTITIES, modeProtectedBranch: 'off' }), broken())
  expect(identity.enforced.map((x) => x.rule)).toEqual(['lookup'])
  expect((await evaluate('git commit -m x', cfg({ identityRules: IDENTITIES }), fakeEnv({ isRepo: false }))).enforced).toEqual([])
})

test('lookup: the denial is sized by the rules that asked git, not by attribution or an inert identity rule', async () => {
  const v = await evaluate('git commit -m x', cfg({ modeProtectedBranch: 'dry' }), broken())
  expect(v.enforced).toEqual([])
  expect(v.dry.map((x) => x.rule)).toEqual(['lookup'])
})

test('context: a mutating kubectl call is denied on a protected context and allowed on a relaxed one, with --dry-run, or when it only reads', async () => {
  const prod = fakeEnv({ context: 'prod-eu' })
  const denied = await evaluate('kubectl apply -f a.yaml', cfg(), prod)
  expect(denied.enforced).toHaveLength(1)
  expect(denied.enforced[0]?.message).toContain('"prod-eu"')
  expect(denied.enforced[0]?.message).toContain('! prefix')
  expect(prod.ran).toEqual(['kubectl config current-context'])
  expect((await evaluate('kubectl apply -f a.yaml', cfg(), fakeEnv({ context: 'dev-1' }))).enforced).toEqual([])
  expect((await evaluate('kubectl apply -f a.yaml --dry-run=client', cfg(), fakeEnv({ context: 'prod-eu' }))).enforced).toEqual([])
  const named = fakeEnv({ context: 'prod-eu' })
  expect((await evaluate('kubectl --context dev-1 apply -f a.yaml', cfg(), named)).enforced).toEqual([])
  expect(named.ran).toEqual([])
  const read = fakeEnv({ context: 'prod-eu' })
  expect((await evaluate('kubectl get pods && helm list && terraform plan', cfg(), read)).enforced).toEqual([])
  expect(read.ran).toEqual([])
  expect((await evaluate('kubectl apply -f a.yaml', cfg({ modeContext: 'off' }), prod)).enforced).toEqual([])
})

test('context: an unclassified environment is denied with the way to classify it, and a stored classification wins over the patterns', async () => {
  const unknown = await evaluate('kubectl apply -f a.yaml', cfg(), fakeEnv({ context: 'scratch' }))
  expect(unknown.enforced).toHaveLength(1)
  expect(unknown.enforced[0]?.message).toContain('not classified')
  expect(unknown.enforced[0]?.message).toContain('/guard-context scratch')
  expect((await evaluate('kubectl apply -f a.yaml', cfg(), fakeEnv({ context: '' }))).enforced[0]?.message).toContain('"(none)"')
  expect((await evaluate('kubectl apply -f a.yaml', cfg(), fakeEnv({ context: 'scratch', stored: { scratch: 'relaxed' } }))).enforced).toEqual([])
  expect((await evaluate('kubectl apply -f a.yaml', cfg(), fakeEnv({ context: 'scratch', stored: { scratch: 'protected' } }))).enforced).toHaveLength(1)
  expect((await evaluate('kubectl apply -f a.yaml', cfg(), fakeEnv({ context: 'prod-eu', stored: { 'prod-eu': 'relaxed' } }))).enforced).toEqual([])
  expect((await evaluate('kubectl apply -f a.yaml', cfg({ protectedContexts: 'scratch' }), fakeEnv({ context: 'scratch' }))).enforced).toHaveLength(1)
})

test('context: terraform follows the workspace and helm the kube context, and a lookup that cannot run denies', async () => {
  const assigned = fakeEnv({ workspace: 'dev' })
  expect((await evaluate('TF_WORKSPACE=staging terraform apply', cfg(), assigned)).enforced[0]?.message).toContain('workspace "staging"')
  expect(assigned.ran).toEqual([])
  const looked = fakeEnv({ workspace: 'prod' })
  expect((await evaluate('terraform -chdir=infra destroy', cfg(), looked)).enforced).toHaveLength(1)
  expect(looked.ran).toEqual(['terraform workspace show'])
  expect((await evaluate('terraform plan', cfg(), fakeEnv({ workspace: 'prod' }))).enforced).toEqual([])
  expect((await evaluate('tofu apply', cfg(), fakeEnv({ workspace: 'dev' }))).enforced).toEqual([])
  expect((await evaluate('helm upgrade --kube-context qa-1 r c', cfg(), fakeEnv({ context: 'dev-1' }))).enforced).toHaveLength(1)
  expect((await evaluate('helm upgrade r c --dry-run', cfg(), fakeEnv({ context: 'prod-eu' }))).enforced).toEqual([])
  expect((await evaluate('kubectl delete ns x', cfg(), broken())).enforced.map((x) => x.rule)).toEqual(['lookup'])
})

test('context: a switch earlier in the same command decides the environment of later calls', async () => {
  const denied = [
    'kubectl config use-context prod-eu && kubectl apply -f x.yaml',
    'kubectl config use-context prod-eu && helm upgrade r c',
    'terraform workspace select prod && terraform apply',
    'export TF_WORKSPACE=prod && terraform apply',
    'TF_WORKSPACE=prod; tofu destroy',
  ]
  for (const command of denied) {
    expect((await evaluate(command, cfg(), fakeEnv({ context: 'dev-1', workspace: 'dev' }))).enforced, command).toHaveLength(1)
  }
  expect((await evaluate('kubectl config use-context dev-1 && kubectl apply -f x.yaml', cfg(), fakeEnv({ context: 'prod-eu' }))).enforced).toEqual([])
  expect((await evaluate('export TF_WORKSPACE=prod && unset TF_WORKSPACE && terraform apply', cfg(), fakeEnv({ workspace: 'dev' }))).enforced).toHaveLength(1)
  expect((await evaluate('export TF_WORKSPACE=prod && TF_WORKSPACE=dev terraform apply', cfg(), fakeEnv({ workspace: 'dev' }))).enforced).toEqual([])
})

test('context: only known reads and real dry runs pass, and a target the guard cannot follow is named, not guessed', async () => {
  const prod = () => fakeEnv({ context: 'prod-eu' })
  for (const command of ['kubectl apply --dry-run=bogus -f x', 'kubectl apply --dry-run=Client -f x', 'kubectl exec pod -- sh', 'kubectl frobnicate', 'helm upgrade r c --dry-run=false', 'helm test r']) {
    expect((await evaluate(command, cfg(), prod())).enforced, command).toHaveLength(1)
  }
  for (const command of ['kubectl apply --dry-run=client -f x', 'kubectl apply --dry-run -f x', 'kubectl get pods', 'kubectl rollout status deploy/x', 'kubectl config use-context prod-eu', 'helm template r c']) {
    expect((await evaluate(command, cfg(), prod())).enforced, command).toEqual([])
  }
  const file = fakeEnv({ context: 'dev-1' })
  const byFile = await evaluate('kubectl --kubeconfig ~/k/kube-prod.yaml apply -f x', cfg(), file)
  expect(byFile.enforced[0]?.message).toContain('kube-prod.yaml')
  expect(file.ran).toEqual([])
  expect((await evaluate('KUBECONFIG=/a/kube-prod.yaml:/b/other helm upgrade r c', cfg(), fakeEnv({ context: 'dev-1' }))).enforced[0]?.message).toContain('kube-prod.yaml')
  for (const command of ['kubectl --server https://x apply -f x', 'kubectl -shttps://x apply -f x', 'helm upgrade r c --kube-apiserver=https://x', 'TF_DATA_DIR=/x terraform apply', 'terraform -chdir=$DIR apply']) {
    const v = await evaluate(command, cfg(), fakeEnv({ context: 'dev-1', workspace: 'dev' }))
    expect(v.enforced[0]?.message, command).toContain('"(custom target)" is not classified')
  }
  const stored = fakeEnv({ context: 'prod-eu', stored: { '(custom target)': 'relaxed' } })
  expect((await evaluate('kubectl -s https://x apply -f x', cfg(), stored)).enforced).toEqual([])
})

test('context: a relaxed context name does not excuse an explicit server or cluster override', async () => {
  for (const command of [
    'helm upgrade r c --kube-context dev-1 --kube-apiserver=https://x',
    'kubectl --context dev-1 --server https://x apply -f x',
    'kubectl --context=dev-1 --cluster prod apply -f x',
    'kubectl --kubeconfig ~/k/dev.yaml -s https://x delete ns x',
  ]) {
    expect((await evaluate(command, cfg(), fakeEnv({ context: 'dev-1' }))).enforced[0]?.message, command).toContain('"(custom target)" is not classified')
  }
  expect((await evaluate('kubectl --context prod-eu --server https://x apply -f x', cfg(), fakeEnv({ stored: { '(custom target)': 'relaxed' } }))).enforced[0]?.message).toContain('protected context "prod-eu"')
  expect((await evaluate('kubectl --context dev-1 --server https://x apply -f x', cfg(), fakeEnv({ stored: { '(custom target)': 'relaxed' } }))).enforced).toEqual([])
})

test('context: kubectl auth is a read only for can-i and whoami', async () => {
  expect((await evaluate('kubectl auth reconcile -f rbac.yaml', cfg(), fakeEnv({ context: 'prod-eu' }))).enforced).toHaveLength(1)
  for (const command of ['kubectl auth can-i delete pods', 'kubectl auth whoami']) {
    expect((await evaluate(command, cfg(), fakeEnv({ context: 'prod-eu' }))).enforced, command).toEqual([])
  }
})

test('context: the last --dry-run flag decides', async () => {
  for (const command of ['kubectl apply --dry-run=client --dry-run=none -f x', 'helm upgrade r c --dry-run --dry-run=false']) {
    expect((await evaluate(command, cfg(), fakeEnv({ context: 'prod-eu' }))).enforced, command).toHaveLength(1)
  }
  expect((await evaluate('kubectl apply --dry-run=none --dry-run=server -f x', cfg(), fakeEnv({ context: 'prod-eu' }))).enforced).toEqual([])
})

test('context: terraform workspace new, delete and select -or-create act on the named workspace, and state-moving init flags are changes', async () => {
  for (const command of ['terraform workspace new prod', 'terraform workspace delete prod', 'tofu workspace select -or-create prod']) {
    const v = await evaluate(command, cfg(), fakeEnv({ workspace: 'dev' }))
    expect(v.enforced[0]?.message, command).toContain('workspace "prod"')
  }
  for (const command of ['terraform init -migrate-state', 'terraform init -force-copy', 'tofu init -reconfigure']) {
    expect((await evaluate(command, cfg(), fakeEnv({ workspace: 'prod' }))).enforced, command).toHaveLength(1)
  }
  for (const command of ['terraform init', 'terraform init -migrate-state=false', 'terraform workspace select prod']) {
    expect((await evaluate(command, cfg(), fakeEnv({ workspace: 'prod' }))).enforced, command).toEqual([])
  }
})

test('context: a relaxed parent directory never relaxes terraform, it can only protect', async () => {
  const v = await evaluate('cd /w/dev/infra && terraform apply', cfg(), fakeEnv({ workspace: 'default' }))
  expect(v.enforced[0]?.message).toContain('"infra" is not classified')
  expect((await evaluate('cd /w/prod/infra && terraform apply', cfg(), fakeEnv({ workspace: 'dev' }))).enforced[0]?.message).toContain('protected directory "prod"')
})

test('context: assignments on a shell wrapper reach the script it runs', async () => {
  for (const command of [`TF_WORKSPACE=prod bash -c 'terraform apply'`, `env KUBECONFIG=/k/kube-prod.yaml sh -c "kubectl apply -f x"`]) {
    expect((await evaluate(command, cfg(), fakeEnv({ context: 'dev-1', workspace: 'dev' }))).enforced, command).toHaveLength(1)
  }
})

test('context: terraform is classified by workspace and directory names, and the default workspace is no name', async () => {
  const inDefault = fakeEnv({ workspace: 'default' })
  expect((await evaluate('cd /w/envs/prod && terraform apply', cfg(), inDefault)).enforced).toHaveLength(1)
  expect((await evaluate('cd /w/envs/dev && terraform apply', cfg(), fakeEnv({ workspace: 'default' }))).enforced).toEqual([])
  const unknown = await evaluate('cd /w/infra && terraform apply', cfg(), fakeEnv({ workspace: 'default' }))
  expect(unknown.enforced).toHaveLength(1)
  expect(unknown.enforced[0]?.message).toContain('"infra" is not classified')
  expect(unknown.enforced[0]?.message).not.toContain('default')
  expect((await evaluate('cd /w/envs/dev && terraform apply', cfg(), fakeEnv({ workspace: 'staging' }))).enforced).toHaveLength(1)
  expect((await evaluate('cd /w/infra-prod/terraform && terraform apply', cfg(), fakeEnv({ workspace: 'default' }))).enforced).toHaveLength(1)
  expect((await evaluate('cd /w/infra && terraform apply', cfg(), fakeEnv({ workspace: 'default', stored: { infra: 'relaxed' } }))).enforced).toEqual([])
})

test('config: an empty protectedBranches is a config error that denies git writes', async () => {
  for (const protectedBranches of ['', ' , ']) {
    const c = cfg({ protectedBranches })
    expect(c.error, JSON.stringify(protectedBranches)).toContain('protectedBranches')
    expect((await evaluate('git commit -m x', c, fakeEnv({ branch: 'develop' }))).enforced.some((x) => x.rule === 'config')).toBe(true)
  }
})

test('branch switches in a command substitution count before the command that contains them', async () => {
  expect((await evaluate('git commit -m "x $(git switch develop)"', cfg(), fakeEnv({ branch: 'feature/x' }))).enforced).toHaveLength(1)
})

test('a switch that may have failed leaves a later write judged on the old branch too', async () => {
  const denied = [
    'git switch -c x || git commit -m y',
    'git checkout -b x; git commit -m y',
    'git checkout -b x\ngit commit -m y',
    'git switch -c x | cat && git commit -m y',
    'git switch -c x; git push',
    'git commit -m "$(git switch -c feat/y)"',
    `bash -c 'git switch -c x; true' && git commit -m y`,
  ]
  for (const command of denied) {
    expect((await evaluate(command, cfg(), fakeEnv({ branch: 'develop' }))).enforced, command).toHaveLength(1)
  }
  for (const command of ['git switch -c x && git commit -m y', `git checkout -b x && git add . && git commit -m "$(cat <<'EOF'\nm\nEOF\n)"`, `bash -c 'git switch -c x' && git commit -m y`]) {
    expect((await evaluate(command, cfg(), fakeEnv({ branch: 'develop' }))).enforced, command).toEqual([])
  }
})

test('a switch back to a previous branch the guard does not know counts as protected', async () => {
  for (const command of ['git switch - && git commit -m x', 'git checkout - && git push']) {
    expect((await evaluate(command, cfg(), fakeEnv())).enforced, command).toHaveLength(1)
  }
  expect((await evaluate('git switch -c a && git switch - && git commit -m x', cfg(), fakeEnv())).enforced).toEqual([])
})

test('env -C moves the directory of the wrapped command, and a non-literal one is unknown', async () => {
  for (const command of ['cd /w/envs/dev && env -C /w/envs/prod terraform apply', 'cd /w/envs/dev && env -C "$D" terraform apply', `cd /w/envs/dev && env -C ../prod bash -c 'terraform apply'`]) {
    expect((await evaluate(command, cfg(), fakeEnv({ workspace: 'default' }))).enforced, command).toHaveLength(1)
  }
})

test('sudo -D and --chdir move the directory of the wrapped command, and a non-literal one is unknown', async () => {
  for (const command of ['cd /w/envs/dev && sudo -D /w/envs/prod terraform apply', 'cd /w/envs/dev && sudo --chdir=../prod terraform apply', 'cd /w/envs/dev && sudo -u root --chdir "$D" terraform apply']) {
    expect((await evaluate(command, cfg(), fakeEnv({ workspace: 'default' }))).enforced, command).toHaveLength(1)
  }
})

test('a non-literal cd makes the directory unknown, so writes that depend on it fail closed', async () => {
  for (const modeUnparsed of ['on', 'dry', 'off']) {
    for (const command of ['cd "$D" && git commit -m x', 'cd $(mktemp -d) && git push origin x']) {
      expect((await evaluate(command, cfg({ modeUnparsed }), fakeEnv())).enforced.map((v) => v.rule), command).toEqual(['lookup'])
    }
  }
  expect((await evaluate('cd /w/envs/dev && cd "$D" && terraform apply', cfg(), fakeEnv({ workspace: 'default' }))).enforced).toHaveLength(1)
  for (const command of ['cd "$D" && git status', 'cd "$D" && cd /h/personal/repo && git commit -m x']) {
    expect((await evaluate(command, cfg(), fakeEnv())).enforced, command).toEqual([])
  }
  const dry = await evaluate('cd "$D" && git push', cfg({ modeAttribution: 'off', modeProtectedBranch: 'dry', modeUnparsed: 'off' }), fakeEnv())
  expect(dry.enforced).toEqual([])
  expect(dry.dry.map((v) => v.rule)).toEqual(['lookup'])
  expect((await evaluate('cd "$D" && git push', cfg({ modeAttribution: 'off', modeProtectedBranch: 'off', modeUnparsed: 'off' }), fakeEnv())).enforced).toEqual([])
})

test('git global options the guard cannot follow make a write unparsed', async () => {
  for (const command of ['git -C/x commit -m y', 'git -cuser.email=a@b.c commit -m y', 'git --git-dir=/x/.git commit -m y', 'git --work-tree /x commit -m y', 'git --frobnicate commit -m y', 'GIT_DIR=/x/.git git commit -m y']) {
    expect((await evaluate(command, cfg(), fakeEnv())).enforced.map((x) => x.rule), command).toEqual(['unparsed'])
  }
  for (const command of ['git --no-pager -c core.x=y commit -m y', 'git --git-dir=/x/.git log']) {
    expect((await evaluate(command, cfg(), fakeEnv())).enforced, command).toEqual([])
  }
})

test('env -u, -i and -S drop the assignments that name the environment', async () => {
  const files = { '/k/dev.yaml': 'current-context: dev-1\n' }
  for (const command of [
    'export KUBECONFIG=/k/dev.yaml; env -u KUBECONFIG kubectl apply -f x',
    'KUBECONFIG=/k/dev.yaml env -i kubectl apply -f x',
    `export KUBECONFIG=/k/dev.yaml; env -u KUBECONFIG bash -c 'kubectl apply -f x'`,
    'export TF_WORKSPACE=dev; env --unset=TF_WORKSPACE terraform apply',
    `export TF_WORKSPACE=dev; env -S '-u TF_WORKSPACE terraform apply'`,
  ]) {
    expect((await evaluate(command, cfg(), fakeEnv({ context: 'prod-eu', workspace: 'prod', files }))).enforced, command).toHaveLength(1)
  }
})

test('context: an option value is never read as a dry-run or context flag', async () => {
  for (const command of ['kubectl apply -n --dry-run -f x', 'kubectl apply --namespace --dry-run=client -f x', 'helm upgrade r c --timeout --dry-run', 'kubectl -n --context=dev-1 apply -f x', 'kubectl apply -f --context=dev-1', 'kubectl --as-uid get delete ns x']) {
    expect((await evaluate(command, cfg(), fakeEnv({ context: 'prod-eu' }))).enforced, command).toHaveLength(1)
  }
  for (const command of ['kubectl apply -f x.yaml --dry-run=client', 'kubectl delete pod p --force --dry-run', 'kubectl apply -n ns --dry-run -f x', 'kubectl apply -f x.yaml --context dev-1']) {
    expect((await evaluate(command, cfg(), fakeEnv({ context: 'prod-eu' }))).enforced, command).toEqual([])
  }
})

test('context: a context switch only applies to calls against the same kubeconfig', async () => {
  const files = { '/k/a.yaml': 'current-context: prod-eu\n' }
  expect((await evaluate('kubectl --kubeconfig /k/a.yaml config use-context dev-1 && kubectl apply -f x', cfg(), fakeEnv({ context: 'prod-eu', files }))).enforced).toHaveLength(1)
  expect((await evaluate('kubectl --kubeconfig /k/a.yaml config use-context dev-1 && kubectl --kubeconfig /k/a.yaml apply -f x', cfg(), fakeEnv({ context: 'prod-eu', files }))).enforced).toEqual([])
})

test('a shell script is the first word after its options, and an unclear shape fails closed', async () => {
  for (const command of [`bash -c -- 'git commit -m x'`, `bash -c -e 'git commit -m x'`, `bash -o pipefail -c 'git commit -m x'`, `bash -c -o errexit 'git commit -m x'`, `bash --norc -c 'git commit -m x'`, `bash --frob -c 'git commit -m x'`]) {
    expect((await evaluate(command, cfg(), fakeEnv({ branch: 'develop' }))).enforced, command).toHaveLength(1)
  }
})

test('wrapper options that take a value do not hide the wrapped command', async () => {
  for (const command of ['sudo --user root git commit -m x', 'sudo -g wheel git commit -m x', 'sudo -D /tmp git commit -m x', 'sudo -iu root git commit -m x', 'doas -u root git commit -m x', 'time -f %e git commit -m x']) {
    expect((await evaluate(command, cfg(), fakeEnv({ branch: 'develop' }))).enforced, command).toHaveLength(1)
  }
})

test('a shell reading its script from stdin is unparsed when the text names a write', async () => {
  for (const command of [`echo 'git commit -m x' | sh`, `printf 'git push origin main' | bash`, `bash <<< 'git commit -m x'`, `bash <<'EOF'\ngit commit -m x\nEOF`, 'source <(echo git commit -m x)', `echo 'kubectl delete ns x' | sh`]) {
    expect((await evaluate(command, cfg(), fakeEnv({ context: 'dev-1' }))).enforced.map((x) => x.rule), command).toEqual(['unparsed'])
  }
  expect((await evaluate('echo hi | sh', cfg(), fakeEnv())).enforced).toEqual([])
})

test('context: a kubeconfig is classified by its own current-context, and an unreadable one is not relaxed by its file name', async () => {
  const files = { '/k/dev.yaml': 'apiVersion: v1\ncurrent-context: prod-eu\n', '/k/ok.yaml': 'current-context: "dev-1"\n' }
  expect((await evaluate('kubectl --kubeconfig /k/dev.yaml apply -f x', cfg(), fakeEnv({ context: 'dev-1', files }))).enforced[0]?.message).toContain('protected context "prod-eu"')
  expect((await evaluate('KUBECONFIG=/k/gone-dev.yaml helm upgrade r c', cfg(), fakeEnv({ context: 'dev-1', files }))).enforced[0]?.message).toContain('"(custom target)" is not classified')
  expect((await evaluate('kubectl --kubeconfig /k/ok.yaml apply -f x', cfg(), fakeEnv({ context: 'prod-eu', files }))).enforced).toEqual([])
})

test('protected push: the matching refspec, push.default and configured push refspecs are resolved', async () => {
  const denied: [string, Record<string, string>][] = [
    ['git push origin :', {}],
    ['git push origin +:', {}],
    ['git push', { 'push.default': 'matching' }],
    ['git -c push.default=matching push origin', {}],
    ['git push', { 'push.default': 'upstream', 'branch.feature/x.merge': 'refs/heads/main' }],
    ['git push', { 'remote.origin.push': 'refs/heads/feature/x:refs/heads/main' }],
    ['git push origin feature/x', { 'remote.origin.push': 'refs/heads/feature/x:refs/heads/main' }],
    ['git push', { 'remote.origin.push': ':' }],
  ]
  for (const [command, gitConfig] of denied) {
    expect((await evaluate(command, cfg(), fakeEnv({ gitConfig }))).enforced, command).toHaveLength(1)
  }
  for (const [command, gitConfig] of [['git push', { 'push.default': 'simple' }], ['git push', { 'push.default': 'upstream', 'branch.feature/x.merge': 'refs/heads/feature/x' }]] as const) {
    expect((await evaluate(command, cfg(), fakeEnv({ gitConfig }))).enforced, command).toEqual([])
  }
})

test('attribution: gh and glab body files named in the call are read and scanned', async () => {
  const files = { '/h/personal/repo/body.md': `feat: x\n\nCo-Authored-By: A <a@b.c>\n`, '/h/personal/repo/clean.md': 'feat: x\n' }
  for (const command of ['gh pr create -t t -F body.md', 'gh pr create --body-file=body.md', 'gh release create v1 --notes-file /h/personal/repo/body.md', 'glab mr create --description-file body.md']) {
    const v = await evaluate(command, cfg(), fakeEnv({ files }))
    expect(v.enforced[0]?.message, command).toContain('the body file /h/personal/repo/body.md contains a Co-Authored-By trailer')
  }
  expect((await evaluate('gh pr create -t t -F clean.md', cfg(), fakeEnv({ files }))).enforced).toEqual([])
})

// Each state kind (directory, env, branch, kube context, workspace) crossed with the connectors that may skip a change.
const PROD = { cwd: '/w/envs/prod', workspace: 'default' }
const FLOW: [string, Repo, 'deny' | 'allow' | 'unparsed'][] = [
  ['false || cd /w/envs/dev; terraform apply', PROD, 'deny'],
  ['( cd /w/envs/dev ); terraform apply', PROD, 'deny'],
  ['cd /w/envs/dev & terraform apply', PROD, 'deny'],
  ['cd /w/envs/dev | true; terraform apply', PROD, 'deny'],
  ['pushd /w/envs/dev && popd && terraform apply', PROD, 'deny'],
  ['cd /w/envs/dev && terraform apply', PROD, 'allow'],
  ['for d in a b; do cd ..; done; terraform apply', { cwd: '/w/envs/dev', workspace: 'default' }, 'deny'],
  ['export TF_WORKSPACE=dev || true; terraform apply', { workspace: 'prod' }, 'deny'],
  ['if true; then TF_WORKSPACE=prod terraform apply; fi', { workspace: 'dev' }, 'deny'],
  ['while true; do FOO=1 TF_WORKSPACE=prod terraform apply; done', { workspace: 'dev' }, 'deny'],
  ['! git switch -c x && git commit -m y', { branch: 'develop' }, 'deny'],
  ['for i in 1 2; do git commit -m x; git switch develop; done', { branch: 'feature/x' }, 'deny'],
  ['git switch -c x & git commit -m y', { branch: 'develop' }, 'deny'],
  ['kubectl config use-context dev-1 || true; kubectl apply -f x', { context: 'prod-eu' }, 'deny'],
  ['kubectl config use-context dev-1 & kubectl apply -f x', { context: 'prod-eu' }, 'deny'],
  ['kubectl config use-context dev-1; kubectl apply -f x', { context: 'prod-eu' }, 'deny'],
  ['kubectl config use-context dev-1 && kubectl apply -f x', { context: 'prod-eu' }, 'allow'],
  ['for c in a b; do kubectl config use-context dev-1; done && kubectl apply -f x', { context: 'prod-eu' }, 'deny'],
  ['{ terraform workspace select dev; }; terraform apply', { workspace: 'prod' }, 'deny'],
  ['terraform workspace select dev | cat && terraform apply', { workspace: 'prod' }, 'deny'],
  ['terraform workspace select dev && terraform apply', { workspace: 'prod' }, 'allow'],
  ['git commit -m --abort', { branch: 'develop' }, 'deny'],
  ['git rebase --abort', { branch: 'develop' }, 'allow'],
  ['git switch main && git commit -m x', { refs: ['develop', 'feature/x'] }, 'deny'],
  [`git $'\\x63ommit' -m x`, { branch: 'develop' }, 'deny'],
  [`git commit -m $'a\\n\\nb'`, {}, 'allow'],
  ['ionice -c3 git commit -m x', { branch: 'develop' }, 'deny'],
  ['chronic git commit -m x', { branch: 'develop' }, 'deny'],
  ['git push --frob origin feature/x', { branch: 'develop' }, 'deny'],
  ['HELM_KUBEAPISERVER=https://x helm upgrade r c', { context: 'dev-1' }, 'deny'],
  ['git -C /h/other commit -m x', { topOf: (d) => d, repos: { '/h/other': { branch: 'develop' } } }, 'deny'],
  ['git -C /h/other commit -m x', { branch: 'develop', topOf: (d) => d, repos: { '/h/other': { branch: 'feature/x' } } }, 'allow'],
  ['echo main | xargs git push origin', {}, 'unparsed'],
  ['flock /l git push origin main', {}, 'unparsed'],
  [`su -c 'git push origin main'`, {}, 'unparsed'],
  ['find . -exec git commit -m x ;', {}, 'unparsed'],
  ['echo git push | grep git', {}, 'allow'],
  ['if git switch -c x; then git commit -m y; fi', { branch: 'develop' }, 'allow'],
  ['if git switch -c x; then\n  git commit -m y\nfi', { branch: 'develop' }, 'allow'],
  ['cd repo && git commit -m x', { cwd: '/h/personal', branch: 'feature/x' }, 'allow'],
  ['git switch -c x && git commit -m y', { branch: 'develop' }, 'allow'],
]

test('flow: a state change counts as certain only for later calls of its && chain, and skipped changes keep the old state possible', async () => {
  for (const [command, repo, want] of FLOW) {
    const rules = (await evaluate(command, cfg(), fakeEnv(repo))).enforced.map((x) => x.rule)
    if (want === 'allow') expect(rules, command).toEqual([])
    else if (want === 'unparsed') expect(rules, command).toContain('unparsed')
    else expect(rules.filter((r) => r !== 'unparsed').length, command).toBeGreaterThan(0)
  }
})

test('identity: the probe runs with the identity variables of the command, and a cleared environment cannot be checked', async () => {
  const c = cfg({ identityRules: IDENTITIES })
  const e = fakeEnv()
  expect((await evaluate('GIT_CONFIG_GLOBAL=/x FOO=1 git commit -m x', c, e)).enforced).toEqual([])
  expect(e.seen.filter(([, args]) => args.includes('var')).map(([, , env]) => env)).toEqual([{ GIT_CONFIG_GLOBAL: '/x' }, { GIT_CONFIG_GLOBAL: '/x' }])
  expect((await evaluate('EMAIL=me@work.example git commit -m x', c, fakeEnv({ email: '' }))).enforced[0]?.message).toContain('me@work.example')
  for (const command of ['env -i git commit -m x', 'env -u GIT_AUTHOR_EMAIL git commit -m x']) {
    expect((await evaluate(command, c, fakeEnv())).enforced[0]?.message, command).toContain('cannot be checked')
  }
})

test('a `..` the OS resolves (git -C, env -C, cd -P) is probed as written, while a logical cd collapses it', async () => {
  // /h/link points elsewhere, so /h/link/.. is not /h: only the path as written reaches the right repository.
  const repo: Repo = { branch: 'feature/x', topOf: (d) => d, repos: { '/h/link/..': { branch: 'develop' } } }
  for (const command of ['git -C /h/link/.. commit -m x', 'cd -P /h/link/.. && git commit -m x', 'env -C /h/link/.. git commit -m x']) {
    const e = fakeEnv(repo)
    expect((await evaluate(command, cfg(), e)).enforced, command).toHaveLength(1)
    expect(e.seen.some(([dir]) => dir === '/h/link/..'), command).toBe(true)
  }
  const logical = fakeEnv(repo)
  expect((await evaluate('cd /h/link/.. && git commit -m x', cfg(), logical)).enforced).toEqual([])
  expect(logical.seen.every(([dir]) => dir === '/h')).toBe(true)
  expect((await evaluate('terraform -chdir=/w/link/../prod apply', cfg(), fakeEnv({ workspace: 'default' }))).enforced[0]?.message).toContain('(custom target)')
})

test('unparsed: identity counts toward the mode only when identity rules are set', async () => {
  const off = cfg({ modeAttribution: 'off', modeProtectedBranch: 'off' })
  const v = await evaluate('git commit -m "oops', off, fakeEnv())
  expect([...v.enforced, ...v.dry]).toEqual([])
  const ruled = await evaluate('git commit -m "oops', cfg({ modeAttribution: 'off', modeProtectedBranch: 'off', identityRules: IDENTITIES }), fakeEnv())
  expect(ruled.enforced.map((x) => x.rule)).toContain('unparsed')
})

test('unparsed mode caps only parser findings and preserves the inherited defaults', async () => {
  for (const mode of ['on', 'dry', 'off']) {
    for (const command of ['xargs git push', 'xargs kubectl apply']) {
      const v = await evaluate(command, cfg({ modeUnparsed: mode }), fakeEnv())
      expect(v.enforced.map((x) => x.rule)).toEqual(mode === 'on' ? ['unparsed'] : [])
      expect(v.dry.map((x) => x.rule)).toEqual(mode === 'dry' ? ['unparsed'] : [])
    }
    const parsed = await evaluate('git push origin main', cfg({ modeUnparsed: mode }), fakeEnv())
    expect(parsed.enforced.map((x) => x.rule)).toContain('protected-branch')
  }
  expect(cfg().unparsed).toBe('on')
  expect(cfg({ modeUnparsed: 'ask' }).error).toContain('modeUnparsed must be off, dry or on')
  const off = await evaluate('xargs kubectl apply', cfg({ modeUnparsed: 'dry', modeContext: 'off' }), fakeEnv())
  expect([...off.enforced, ...off.dry]).toEqual([])
})

const SECRET = '{{secret:branch}}'

test('a switch, checkout or rebase to a branch built from a variable, substitution or secret is an unknown branch', async () => {
  const denied = [
    'B=main && git switch "$B" && git commit --allow-empty -m x',
    'B=main && git checkout "$B" && git commit --allow-empty -m x',
    'git switch -c "$(echo main)" && git commit -m x',
    'git checkout -b $B && git push',
    `git switch ${SECRET} && git commit -m x`,
    'git rebase origin/main "$B"',
    `git rebase --root ${SECRET}`,
  ]
  for (const command of denied) {
    expect((await evaluate(command, cfg(), fakeEnv())).enforced.map((x) => x.rule), command).toContain('protected-branch')
  }
  for (const command of ['git switch feature/x && git commit -m x', 'git checkout -b feat && git commit -m x', 'git checkout HEAD -- "$F" && git commit -m x']) {
    expect((await evaluate(command, cfg(), fakeEnv())).enforced, command).toEqual([])
  }
})

test('git symbolic-ref HEAD and update-ref --no-deref HEAD move the followed branch', async () => {
  for (const command of ['git symbolic-ref HEAD refs/heads/main && git commit --allow-empty -m x', 'git symbolic-ref -m r HEAD refs/heads/develop && git push', 'git symbolic-ref HEAD "$R" && git commit -m x', 'git symbolic-ref HEAD refs/tags/v1 && git commit -m x']) {
    expect((await evaluate(command, cfg(), fakeEnv())).enforced, command).toHaveLength(1)
  }
  for (const command of ['git symbolic-ref HEAD && git commit -m x', 'git symbolic-ref HEAD refs/heads/feat && git commit -m x', 'git update-ref --no-deref HEAD HEAD~1 && git commit -m x']) {
    expect((await evaluate(command, cfg(), fakeEnv({ branch: command.includes('update-ref') ? 'main' : 'feature/x' }))).enforced, command).toEqual([])
  }
})

test('identity: an earlier git config write in the command makes the identity unknown, a read does not', async () => {
  const c = cfg({ identityRules: IDENTITIES })
  for (const command of ['git config user.email wrong@example.org && git commit --allow-empty -m x', 'git config --global --add include.path /tmp/x; git commit -m x', 'git config set user.email a@b.c && git commit -m x', 'git config --edit && git commit -m x']) {
    expect((await evaluate(command, c, fakeEnv())).enforced[0]?.message, command).toContain('may change git config')
  }
  for (const command of ['git config user.email && git commit -m x', 'git config --get user.email && git commit -m x', 'git config --list --show-origin && git commit -m x', 'git config get user.email && git commit -m x']) {
    expect((await evaluate(command, c, fakeEnv())).enforced, command).toEqual([])
  }
})

test('protected push: an earlier config or upstream write leaves the implicit push destination unknown', async () => {
  const denied: [string, Record<string, string>][] = [
    ['git config remote.origin.push HEAD:main && git push origin', {}],
    ['git config push.default matching && git push', {}],
    ['git config remote.origin.push HEAD:main && git push origin feature/x', {}],
    ['git branch -u origin/main && git push', { 'push.default': 'upstream' }],
    ['git switch -c feat origin/main && git push', { 'push.default': 'upstream' }],
  ]
  for (const [command, gitConfig] of denied) {
    expect((await evaluate(command, cfg(), fakeEnv({ gitConfig }))).enforced, command).toHaveLength(1)
  }
  for (const command of ['git config remote.origin.push HEAD:main && git push origin HEAD:feature/x', 'git push -u origin feature/x && git push', 'git switch -c feat origin/main && git push', 'git config --get push.default && git push']) {
    expect((await evaluate(command, cfg(), fakeEnv())).enforced, command).toEqual([])
  }
})

test('identity: an include or GIT_CONFIG_PARAMETERS in the environment makes the identity unknown', async () => {
  const c = cfg({ identityRules: IDENTITIES })
  const denied = [
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=include.path GIT_CONFIG_VALUE_0=/tmp/wrong.cfg git commit --allow-empty -m x',
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=includeIf.onbranch:x.path GIT_CONFIG_VALUE_0=/tmp/w && git commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="$K" GIT_CONFIG_VALUE_0=/tmp/w git commit -m x',
  ]
  for (const command of denied) {
    expect((await evaluate(command, c, fakeEnv())).enforced.map((x) => x.rule), command).toContain('identity')
  }
  const e = fakeEnv()
  expect((await evaluate('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.email GIT_CONFIG_VALUE_0=me@personal.example git commit -m x', c, e)).enforced).toEqual([])
})

test('a secret placeholder in a push refspec or a git -C value is unparsed', async () => {
  for (const command of [`git push origin "HEAD:${SECRET}"`, `git push origin ${SECRET}`, `git -C ${SECRET} commit -m x`]) {
    expect((await evaluate(command, cfg(), fakeEnv())).enforced.map((x) => x.rule), command).toContain('unparsed')
  }
  expect((await evaluate('git push origin HEAD:feature/x', cfg(), fakeEnv())).enforced).toEqual([])
})
