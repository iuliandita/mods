import { expect, test } from 'claude-code/testing'

import { evaluate, parseConfig, type Env } from './rules'

// Verdicts: A allow, U unparsed, D:<rule> denied by that rule. The current branch is feature/x and the current
// kube context kind-dev (relaxed, as kind-* is).
type Want = 'A' | 'U' | `D:${string}`
type World = {
  branch?: string
  context?: string
  workspace?: string
  cwd?: string
  files?: Record<string, string>
  gitConfig?: Record<string, string>
}
type Extra = { world?: World; options?: Record<string, string>; probe?: (envs: (Record<string, string> | undefined)[]) => boolean }
type Row = [cmd: string, want: Want, extra?: Extra]

const RULES = { identityRules: JSON.stringify([{ prefix: '~/personal/', email: 'me@personal.example' }]) }
const PROD = { world: { context: 'prod-eu' } }
const C_FILE = { '/h/personal/repo/c': 'current-context: prod-eu\n' }

function fakeEnv(w: World = {}): Env & { probes: (Record<string, string> | undefined)[] } {
  const r = { branch: 'feature/x', context: 'kind-dev', workspace: 'default', cwd: '/h/personal/repo', files: {}, gitConfig: {}, ...w }
  const files: Record<string, string> = r.files
  const config: Record<string, string> = r.gitConfig
  const probes: (Record<string, string> | undefined)[] = []
  return {
    cwd: r.cwd,
    home: '/h',
    probes,
    contexts: async () => ({}),
    read: async (path) => files[path] ?? null,
    run: async (_dir, argv) => {
      const key = argv.join(' ')
      if (key === 'kubectl config current-context') return { ok: true, out: r.context }
      if (key.endsWith(' workspace show')) return { ok: true, out: r.workspace }
      return { ok: false, out: '' }
    },
    git: async (_dir, args, env) => {
      const key = args.join(' ')
      if (key.startsWith('config --get-regexp')) {
        const lines = Object.entries(config).filter(([k]) => /^remote\..+\.push$/.test(k)).map(([k, v]) => `${k} ${v}`)
        return { ok: lines.length > 0, out: lines.join('\n') }
      }
      if (key.startsWith('config --get ')) {
        const v = config[key.slice('config --get '.length)]
        return v === undefined ? { ok: false, out: '' } : { ok: true, out: v }
      }
      if (key.startsWith('symbolic-ref')) return { ok: true, out: r.branch }
      if (key.startsWith('rev-parse --verify --quiet refs/heads/')) return { ok: ['develop', 'main', 'feature/x'].includes(key.slice(37)), out: '' }
      if (key.startsWith('rev-parse --verify')) return { ok: true, out: '' }
      if (key.startsWith('rev-parse --show-toplevel')) return { ok: true, out: '/h/personal/repo' }
      const ident = /var GIT_(AUTHOR|COMMITTER)_IDENT$/.exec(key)
      if (ident) {
        probes.push(env)
        // Real git: GIT_<ROLE>_EMAIL, then the last user.email from -c, then GIT_CONFIG_*, then EMAIL, then the config files.
        const dashC = [...key.matchAll(/-c user\.email=(\S+)/g)].map((m) => m[1]).pop()
        const count = Number(env?.GIT_CONFIG_COUNT ?? 0)
        let fromEnv: string | undefined
        for (let i = 0; i < count; i++) if (env?.[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() === 'user.email') fromEnv = env[`GIT_CONFIG_VALUE_${i}`]
        const email = env?.[`GIT_${ident[1]}_EMAIL`] ?? dashC ?? fromEnv ?? env?.EMAIL ?? 'me@personal.example'
        return { ok: true, out: `Me <${email}> 1700000000 +0000` }
      }
      return { ok: false, out: '' }
    },
  }
}

const heredoc = (msg: string) => `git commit -m "$(cat <<'EOF'\n${msg}\nEOF\n)"`

export const ROWS: Row[] = [
  ['xargs git push', 'A', { options: { modeUnparsed: 'off' } }],
  ['xargs git push', 'A', { options: { modeUnparsed: 'dry' } }],
  ['git push origin main', 'D:protected-branch', { options: { modeUnparsed: 'off' } }],
  ['kubectl --context prod-eu delete ns x', 'D:context', { options: { modeUnparsed: 'off' } }],
  ['ls terraform', 'A'],
  ['vim terraform/main.tf', 'A'],
  ['mkdir -p docs/git', 'A'],
  ['sed -n 1,5p git.txt', 'A'],
  ['curl https://example.com/git', 'A'],
  ['brew install gh', 'A'],
  // #90: executable scripts, path-named programs and editor option values are not data.
  [`sed -l 1 s/./git/e <<< 'x push origin main'`, 'U'],
  [`sed -e p --expression s/./git/e <<< 'x push origin main'`, 'U'],
  [`sed -e p -ne s/./git/e <<< 'x push origin main'`, 'U'],
  [`sed -s -l 1 s/./kubectl/e <<< 'x --context prod-eu delete ns x'`, 'U'],
  ['./tee git push origin main', 'U'],
  ['/tmp/bin/curl git push origin main', 'U'],
  ['./cat git push origin main', 'U'],
  ['nano -s /usr/bin/git notes.txt', 'U'],
  ['cd "$X" && git push', 'D:lookup'],
  ['cd "$X" && git push', 'D:lookup', { options: { modeUnparsed: 'dry' } }],
  ['cd "$X" && git push', 'D:lookup', { options: { modeUnparsed: 'off' } }],
  // Keep script words and executable sed input visible, even with literal file operands.
  ['sed -e e docs/git', 'U'],
  ['sed -n -e p --expression 1,5p git.txt', 'A'],
  ['sed -n /git/p notes.txt', 'U'],
  ['sed -e s/x/y/ docs/git', 'A'],
  ['sed -f scripts/filter.sed docs/git', 'U'],
  ['sed -e s/name/title/ docs/git', 'U'],
  ['sed --expression=s/./git/e notes.txt', 'U'],
  ['sed -ne s/./git/e notes.txt', 'U'],
  ['./vim terraform/main.tf', 'U'],
  ['/tmp/bin/sed -n 1,5p git.txt', 'U'],
  ['./brew install gh', 'U'],
  ['vim -S /usr/bin/git notes.txt', 'U'],
  ['vim -R terraform/main.tf', 'U'],
  ['cd "$X" && git status', 'A', { options: { modeUnparsed: 'off' } }],
  ['cd "$X" && cd /h/personal/repo && git push', 'A', { options: { modeUnparsed: 'off' } }],
  ['echo hi | tee gh.txt', 'A'],
  ['ls src/git', 'A'],
  ['xargs git push', 'U'],
  [`sort --compress-program='git push' data`, 'U'],
  [`wget --use-askpass='git push' https://example.com`, 'U'],
  ['xargs /usr/bin/git push', 'U'],
  ['find . -exec git commit -m x \\;', 'U'],
  ['find . -exec /usr/bin/git commit -m x \\;', 'U'],
  [`bash -c "git push origin main"`, 'D:protected-branch'],
  [`python -c "import os; os.system('git push')"`, 'U'],
  [`python -c "import git.cmd as g; g.Git().push()"`, 'U'],
  [`vim -c '!git push' git.txt`, 'U'],
  ['vim -c/usr/bin/git git.txt', 'U'],
  ['sed -n /git/e git.txt', 'U'],
  [`sed -e 'e /usr/bin/git push' git.txt`, 'U'],
  ['env /usr/bin/git push origin main', 'D:protected-branch'],
  ['nohup /usr/bin/git push origin main', 'D:protected-branch'],
  ['timeout 5 /usr/bin/git push origin main', 'D:protected-branch'],
  ['sudo /usr/bin/git push origin main', 'D:protected-branch'],
  ['flock /tmp/lock /usr/bin/git push origin main', 'U'],
  [`su -c '/usr/bin/git push origin main'`, 'U'],
  ['direnv exec . /usr/bin/git push origin main', 'U'],
  ['/usr/bin/git push origin main', 'D:protected-branch'],
  ['./terraform apply', 'D:context', { world: { workspace: 'prod' } }],
  [`secret-box exec -- 'git status'`, 'A'],
  ['secret-box scrub', 'A'],
  ['/opt/plugin/bin/secret-box scrub', 'A'],
  [`secret-box scrub <<<'["git push origin main"]'`, 'A'],
  [`secret-box exec --scrub -- 'git status'`, 'A'],
  [`secret-box exec -- 'git push origin main'`, 'D:protected-branch'],
  [`secret-box exec --scrub -- 'git push origin main'`, 'D:protected-branch'],
  [`secret-box exec -- 'kubectl --context prod-eu delete ns x'`, 'D:context'],
  [`secret-box exec --scrub -- 'kubectl --context prod-eu delete ns x'`, 'D:context'],
  [`secret-box exec --scrub -- "$SCRIPT"; git status`, 'U'],
  [`secret-box exec --scrub; git status`, 'U'],
  // ALLOW
  ['git status', 'A'],
  ['git add -A && git commit -m "feat: x"', 'A'],
  [heredoc('feat: x\n\nbody'), 'A'],
  [heredoc('docs: explain why git push origin main is blocked'), 'A'],
  ['git push -u origin HEAD', 'A'],
  ['git push origin feature/x', 'A'],
  ['echo hello $(date)', 'A'],
  ['for f in *.ts; do echo "$f"; done', 'A'],
  ['cd "$(git rev-parse --show-toplevel)" && git status', 'A'],
  ['git log -n "$N"', 'A'],
  ['git diff $(git merge-base HEAD origin/main)', 'A'],
  ['npm test 2>&1 | tail', 'A'],
  ['rtk git commit -m x', 'A'],
  ['grep -rn "git push" docs/', 'A'],
  ['ls -l /w/code/gh.example/mods', 'A'],
  ['cat infra/terraform.tfstate', 'A'],
  ['kubectl get pods -A', 'A'],
  ['kubectl --context kind-dev apply -f k.yaml', 'A'],
  ['terraform plan', 'A'],
  [`gh pr create --title t --body "$(cat <<'EOF'\nbody\nEOF\n)"`, 'A'],
  ['diff <(git show HEAD:a) <(git show HEAD~1:a)', 'A'],
  ['source .venv/bin/activate && pytest -q', 'A'],
  ['export FOO=1 && git commit -m x', 'A'],
  ['cat <<EOF > n.md\nnotes $(date)\nEOF', 'A'],
  ['git add src/{a,b}.ts && git commit -m x', 'A'],
  ['make build && git status', 'A'],
  ['$EDITOR notes.md', 'A'],
  ['kubectl --kubeconfig ./c config use-context kind-dev && cd sub && kubectl --kubeconfig ../c apply -f a', 'A', { world: { files: C_FILE } }],
  ['kubectl apply -f a', 'A', { world: { context: 'my-dev-x' } }],
  // git push: the first positional is the repository even with --repo (git 2.56: `--repo=origin trunk` pushes to a remote named trunk).
  ['git push --repo=origin main', 'A'],

  // COMMAND WORD
  ['$GIT push origin main', 'U'],
  ['"$(which git)" push origin main', 'U'],
  ['git $SUB origin main', 'U'],
  ['{git,true} push origin main', 'U'],
  ['gi[t] push origin main', 'U'],
  ['/usr/bin/gi? push origin main', 'U'],
  ['${G:-git} commit -m x', 'U'],
  ['$"git" push origin HEAD:main', 'D:protected-branch'],
  ['git push origin $"main"', 'D:protected-branch'],
  ['"git push" origin main', 'U'],
  [`git push origin $'HEAD:main\\000ignored'`, 'D:protected-branch'],
  [`sudo -i 'git push origin main'`, 'D:protected-branch'],
  [`sudo -s 'git commit --allow-empty -m x'`, 'D:protected-branch', { world: { branch: 'main' } }],
  [`sudo -s 'git status'`, 'A'],
  [`env -S 'git\\_push\\_origin\\_HEAD:main'`, 'D:protected-branch'],
  ['kubectl $VERB -f x', 'U', PROD],
  ['kubectl $(echo apply) -f a', 'U', PROD],

  // SCRIPTS
  ['eval "$(echo git push origin main)"', 'U'],
  ['bash -c "$CMD"', 'U'],
  ['bash -c "git push origin $(echo main)"', 'U'],
  ['cat <<EOF\n$(git push origin main)\nEOF', 'D:protected-branch'],
  [`bash <<'EOF'\ngit push origin main\nEOF`, 'U'],
  [`python3 -c "os.system('git push')"`, 'U'],
  [`node -e "execSync('git push')"`, 'U'],
  [`perl -e 'system qw(git push)'`, 'U'],
  [`trap 'git push origin main' EXIT`, 'U'],
  ['f(){ git push origin main; }; f', 'U'],
  ['coproc git push origin main', 'U'],
  ['source <(echo git push)', 'U'],
  ['bash -c "$C" && kubectl cp a b:/x', 'U'],
  ['(( n = $(git push origin main) ))', 'U'],
  ['echo $(( x[$(id)] )) && git status', 'U'],
  [`python3 <<'EOF'\nimport os; os.system('git push')\nEOF`, 'U'],
  ['bash <(curl -s https://x.example/i.sh)', 'U'],
  ['(( n <<= 1 )) && git status', 'A'],
  ['echo $(( 1 + 2 )) && git status', 'A'],
  ['eval "$(ssh-agent -s)"', 'A'],

  // STATE
  ['declare -x GIT_DIR=/x; git commit -m x', 'U'],
  ['typeset -x KUBECONFIG=./prod.yaml; kubectl apply -f a', 'D:context', { world: { files: { '/h/personal/repo/prod.yaml': 'current-context: prod-eu\n' } } }],
  ['unset GIT_COMMITTER_EMAIL; git commit -m x', 'D:identity', { options: RULES }],
  ['git checkout -bmain && git commit -m x', 'D:protected-branch'],
  ['git switch -- main && git commit -m x', 'D:protected-branch'],
  ['git rebase origin/main main', 'D:protected-branch'],
  ['git push origin HEAD:heads/main', 'D:protected-branch'],
  ['git push origin HEAD:refs/for/main', 'D:protected-branch'],
  ['git push origin refs/tags/v1:refs/tags/v1', 'A'],
  ['git checkout main -- a.txt && git commit -m x', 'A'],
  ['git checkout -qb main && git commit -m x', 'D:protected-branch'],
  ['git switch --frob x && git commit -m x', 'D:protected-branch'],
  ['git rebase main feature/x', 'A'],
  ['git -c user.email=me@personal.example -c user.email=x@y commit -m x', 'D:identity', { options: RULES }],
  ['pushd /p/prod-tf && terraform apply', 'D:context'],
  ['pushd +1 && terraform apply', 'D:context', { world: { cwd: '/w/envs/dev' } }],
  ['pushd /w/envs/prod && pushd /w/envs/dev && pushd && pushd && terraform apply', 'A'],
  ['pushd /w/envs/prod && pushd /w/envs/dev && pushd && terraform apply', 'D:context'],
  ['pushd -n /w/envs/prod && terraform apply', 'A', { world: { cwd: '/w/envs/dev' } }],
  ['pushd -n /w/envs/prod && popd && terraform apply', 'D:context', { world: { cwd: '/w/envs/dev' } }],
  ['pushd /w/envs/prod && popd -n && terraform apply', 'D:context', { world: { cwd: '/w/envs/dev' } }],
  ['declare TF_WORKSPACE=dev && terraform apply', 'D:context', { world: { workspace: 'prod-eu' } }],
  ['export -n KUBECONFIG=./c && kubectl apply -f a', 'D:context', { world: { context: 'prod-eu', files: { '/h/personal/repo/c': 'current-context: kind-dev\n' } } }],
  ['kubectl config use prod-eu && kubectl apply -f a', 'D:context'],
  ['kubectl config set-cluster kind-dev --server=https://x && kubectl apply -f a', 'D:context'],
  ['kubectx prod-eu && kubectl apply -f a', 'D:context'],
  ['echo prod > .terraform/environment && terraform apply', 'D:context', { world: { cwd: '/w/envs/dev' } }],
  ['kubectx prod-eu && kubectl get pods', 'A'],
  ['declare -f git; git status', 'U'],
  ['unset -f git; git commit -m x', 'A', { options: RULES }],
  ['kubectl config set current-context prod-eu && kubectl apply -f a', 'D:context'],
  ['kubectl --kubeconfig ./c config use-context prod-eu && kubectl --kubeconfig c apply -f a', 'D:context', { world: { files: { '/h/personal/repo/c': 'current-context: kind-dev\n' } } }],
  ['kubectl --kubeconfig ./c config use-context kind-dev && cd sub && kubectl --kubeconfig ./c apply -f a', 'D:context', { world: { files: { '/h/personal/repo/c': 'current-context: kind-dev\n', '/h/personal/repo/sub/c': 'current-context: prod-eu\n' } } }],
  ['kubectl frobnicate x', 'D:context', PROD],
  ['git push --repo=nowhere origin main', 'D:protected-branch'],
  ['git -c remote.origin.push=refs/heads/feature/x:refs/heads/main -c remote.origin.push=refs/heads/feature/x:refs/heads/feature/x push', 'D:protected-branch'],
  ['git -c push.default=upstream -c branch.feature/x.merge=refs/heads/main push', 'D:protected-branch'],

  // GLOBS AND ENV
  ['kubectl apply -f a', 'D:context', { world: { context: 'devops-eu' } }],
  ['kubectl apply -f a', 'D:context', { world: { context: 'attestation' } }],
  ['kubectl apply -f a', 'D:context', { world: { context: 'testing' } }],
  ['kubectl apply -f a', 'A', { world: { context: 'dev' } }],
  ['kubectl apply -f a', 'A', { world: { context: 'team.test' } }],
  ['kubectl config delete-context old && kubectl apply -f a', 'D:context'],
  ['kubectl config set-context --current --namespace x && kubectl apply -f a', 'D:context'],
  ['GIT_EXEC_PATH=/x git commit -m x', 'A', { options: RULES, probe: (envs) => envs.length > 0 && envs.every((e) => !e || !('GIT_EXEC_PATH' in e)) }],
  ['GIT_TRACE=/tmp/t git commit -m x', 'A', { options: RULES, probe: (envs) => envs.length > 0 && envs.every((e) => !e || !('GIT_TRACE' in e)) }],
  ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.email GIT_CONFIG_VALUE_0=x@y git commit -m x', 'D:identity', { options: RULES }],
  [
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.sshCommand GIT_CONFIG_VALUE_0=x git commit -m x',
    'A',
    { options: RULES, probe: (envs) => envs.length > 0 && envs.every((e) => !e || !Object.keys(e).some((k) => k.startsWith('GIT_CONFIG_'))) },
  ],
  [`GIT_CONFIG_PARAMETERS="'user.email'='x@y'" git commit -m x`, 'U'],
  ['GIT_CONFIG_COUNT=$N GIT_CONFIG_KEY_0=user.email GIT_CONFIG_VALUE_0=x@y git commit -m x', 'U', { options: RULES }],
  ['GIT_CONFIG_COUNT=99 git commit -m x', 'U', { options: RULES }],
  [
    'GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=x GIT_CONFIG_KEY_1=user.email GIT_CONFIG_VALUE_1=x@y git commit -m x',
    'D:identity',
    { options: RULES, probe: (envs) => envs.length > 0 && envs.every((e) => e?.GIT_CONFIG_COUNT === '1' && e.GIT_CONFIG_KEY_0 === 'user.email' && !('GIT_CONFIG_KEY_1' in e)) },
  ],
]

// Rows expected to mismatch today; each build step removes the rows it fixes.
export const KNOWN_GAPS = new Set<string>([
])

export async function verdict([cmd, want, extra = {}]: Row): Promise<{ ok: boolean; got: string[] }> {
  const env = fakeEnv(extra.world)
  const v = await evaluate(cmd, parseConfig(extra.options ?? {}), env)
  const got: string[] = v.enforced.map((x) => x.rule)
  const hit = want === 'A' ? got.length === 0 : want === 'U' ? got.includes('unparsed') : got.includes(want.slice(2))
  return { ok: hit && (extra.probe?.(env.probes) ?? true), got }
}

const keyOf = (row: Row) => `${row[1]} ${row[0]}${row[2]?.world?.context ? ` @${row[2].world.context}` : ''}`

test('corpus: every row gets its verdict, and every known gap still mismatches', async () => {
  const wrong: string[] = []
  const closed: string[] = []
  for (const row of ROWS) {
    const { ok, got } = await verdict(row)
    const key = keyOf(row)
    if (KNOWN_GAPS.has(key)) {
      if (ok) closed.push(key)
    } else if (!ok) {
      wrong.push(`${key} -> [${got.join(',')}]`)
    }
  }
  expect(wrong).toEqual([])
  expect(closed).toEqual([])
  expect([...KNOWN_GAPS].filter((k) => !ROWS.some((r) => keyOf(r) === k))).toEqual([])
})

// Every way of spelling `git push origin main` (on feature/x), bare and wrapped, is denied or unparsed.
const PUSH_FORMS: [line: string, tail?: string][] = [
  ['env git push origin main'],
  ['command git push origin main'],
  ['sudo -u u git push origin main'],
  [`bash -c 'git push origin main'`],
  [`eval 'git push origin main'`],
  ['echo $(git push origin main)'],
  ['G=git; $G push origin main'],
  ['"$(command -v git)" push origin main'],
  ['x=push; git $x origin main'],
  ['{git,} push origin main'],
  ['g\\it push origin main'],
  [`'g'"it" push origin main`],
  ['cat <<EOF', '$(git push origin main)\nEOF'],
  [`python3 -c "subprocess.run(['git','push','origin','main'])"`],
  [`python3 -c "import git.cmd as g; g.Git().push('origin','main')"`],
  [`bash <<<'git push origin main'`],
  ['git push origin HEAD:refs/heads/main'],
  ['$"git" push origin main'],
  [`git push origin $'main\\x00x'`],
  [`sudo -s 'git push origin main'`],
  [`env -S 'git\\_push\\_origin\\_main'`],
]
const WRAPS: ((line: string, tail?: string) => string)[] = [
  (l, t) => (t ? `${l}\n${t}` : l),
  (l, t) => (t ? `( ${l}\n${t}\n)` : `( ${l} )`),
  (l, t) => (t ? `{ ${l}\n${t}\n}` : `{ ${l}; }`),
  (l, t) => (t ? `if true; then ${l}\n${t}\nfi` : `if true; then ${l}; fi`),
  (l, t) => (t ? `${l} &\n${t}` : `${l} &`),
]

test('property: every form of git push origin main, bare or wrapped, is denied or unparsed', async () => {
  const missed: string[] = []
  for (const [line, tail] of PUSH_FORMS) {
    for (const wrap of WRAPS) {
      const cmd = wrap(line, tail)
      const v = await evaluate(cmd, parseConfig({}), fakeEnv())
      if (!v.enforced.some((x) => x.rule === 'protected-branch' || x.rule === 'unparsed')) missed.push(cmd)
    }
  }
  expect(missed).toEqual([])
})
