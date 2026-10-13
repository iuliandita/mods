import { expect, test } from 'claude-code/testing'

import { extractCalls, tokenize } from './shell'

const HOME = '/h'
const CWD = '/work/repo'

function git(src: string) {
  return extractCalls(src, CWD, HOME).calls.flatMap((c) => (c.kind === 'git' ? [c] : []))
}

function infra(src: string) {
  return extractCalls(src, CWD, HOME).calls.flatMap((c) => (c.kind === 'infra' ? [c] : []))
}

function only<T>(xs: T[]): T {
  const x = xs[0]
  if (x === undefined) throw new Error('expected at least one element')
  return x
}

test('a plain commit and a heredoc message with quotes and apostrophes each parse as one call and one message', () => {
  const c = only(git('git commit -m "feat: x"'))
  expect(c.sub).toBe('commit')
  expect(c.args).toEqual(['-m', 'feat: x'])
  const src = `git commit -m "$(cat <<'EOF'\nfeat(x): don't break "quotes"\n\nCo-Authored-By: A <a@b.c>\nEOF\n)"`
  const parsed = extractCalls(src, CWD, HOME)
  expect(parsed.ok).toBe(true)
  const calls = git(src)
  expect(calls).toHaveLength(1)
  expect(only(calls).args[1]).toContain('Co-Authored-By: A')
})

test('cd, && chains and git -C decide the directory a call acts on', () => {
  const calls = git('cd ~/personal/repo && git add -A && git commit -m x && git push origin main')
  expect(calls.map((c) => c.sub)).toEqual(['add', 'commit', 'push'])
  expect(calls.every((c) => c.dir === '/h/personal/repo')).toBe(true)
  const c = only(git('git -C ../other -c user.email=me@x.y commit -m "a b"'))
  expect(c.sub).toBe('commit')
  // git -C resolves `..` as the OS does (after any symlink), so the path is kept as written.
  expect(c.dir).toBe('/work/repo/../other')
  expect(c.overrides['user.email']).toBe('me@x.y')
})

test('wrappers, env assignments, bash -c, eval and substitutions are looked through', () => {
  const cases: [string, string][] = [
    ['rtk git commit -m x', 'commit'],
    ['sudo -u bob env FOO=1 git push origin HEAD:main', 'push'],
    ['timeout -s KILL 5 git status', 'status'],
    [`bash -c 'cd /tmp/x && git commit -m "q"'`, 'commit'],
    ['eval "git commit -m z"', 'commit'],
    ['echo $(git commit -m z) && ls', 'commit'],
  ]
  for (const [src, sub] of cases) {
    const calls = git(src)
    expect(calls).toHaveLength(1)
    expect(only(calls).sub).toBe(sub)
  }
  expect(only(git('GIT_AUTHOR_EMAIL=a@b.c git commit -m x')).assigns.GIT_AUTHOR_EMAIL).toBe('a@b.c')
  expect(only(git(`bash -c 'cd /tmp/x && git commit -m "q"'`)).dir).toBe('/tmp/x')
  // xargs adds arguments the guard cannot see, so it is not looked through: the command is not ok.
  expect(extractCalls('echo a | xargs -n1 git add', CWD, HOME).ok).toBe(false)
})

test('wrapper options of command, exec and env do not hide the wrapped call', () => {
  for (const src of [
    'command -p git commit -m x',
    'command -v git commit',
    'exec -a name git commit -m x',
    'exec -cl git commit -m x',
    'env -i git commit -m x',
    'env -u FOO -C /tmp git commit -m x',
    'env --unset=FOO git commit -m x',
    `env -S 'git commit -m x'`,
    `env -iS 'git commit -m x'`,
    `env --split-string='git commit -m x'`,
  ]) {
    expect(git(src).map((c) => c.sub), src).toEqual(['commit'])
  }
  expect(only(git(`env -S 'GIT_AUTHOR_EMAIL=a@b.c git commit'`)).assigns.GIT_AUTHOR_EMAIL).toBe('a@b.c')
})

test('secret-box exec -- SCRIPT is parsed like bash -c, placeholders included', () => {
  const k = only(infra(`/x/bin/secret-box exec -- 'kubectl --context prod-eu delete ns x {{secret:t}}'`))
  expect([k.tool, k.sub, k.context]).toEqual(['kubectl', 'delete', 'prod-eu'])
  expect(extractCalls(`secret-box exec -- 'git push -f {{secret:t}}'`, CWD, HOME).ok).toBe(true)
  expect(extractCalls('secret-box exec', CWD, HOME).ok).toBe(false)
})

test('heredoc bodies and comments are text, not commands', () => {
  const body = `cat <<'EOF' > notes.txt\ngit commit -m "this is text"\nEOF\ngit status`
  expect(git(body).map((c) => c.sub)).toEqual(['status'])
  expect(git('git status # git commit -m x').map((c) => c.sub)).toEqual(['status'])
})

test('an unterminated quote is reported as not ok but still yields the call', () => {
  const parsed = extractCalls('git commit -m "oops', CWD, HOME)
  expect(parsed.ok).toBe(false)
  expect(parsed.calls).toHaveLength(1)
})

test('pathological input never throws, and an overlong command is not ok', () => {
  for (const src of ['', '"', "'", '$(', '`', '<<', '<<EOF', '$(((((', 'git commit -m "$(', ';;;;&&||']) {
    expect(() => tokenize(src)).not.toThrow()
  }
  expect(extractCalls('true; '.repeat(2100) + 'git commit -m x', CWD, HOME).ok).toBe(false)
})

test('kubectl, helm, terraform and tofu calls carry their verb, environment and directory', () => {
  const k = only(infra('kubectl --context prod-eu -n x apply -f a.yaml'))
  expect([k.tool, k.sub, k.context, k.dir]).toEqual(['kubectl', 'apply', 'prod-eu', CWD])
  expect(only(infra('kubectl --context=prod-eu --namespace x delete pod p')).context).toBe('prod-eu')
  const h = only(infra('helm --kube-context prod upgrade r c'))
  expect([h.tool, h.sub, h.context]).toEqual(['helm', 'upgrade', 'prod'])
  const t = only(infra('terraform -chdir=infra apply'))
  expect([t.tool, t.sub, t.dir]).toEqual(['terraform', 'apply', '/work/repo/infra'])
  const u = only(infra('TF_WORKSPACE=prod tofu destroy'))
  expect([u.tool, u.sub, u.assigns.TF_WORKSPACE]).toEqual(['tofu', 'destroy', 'prod'])
  expect(only(infra('kubectl get pods')).sub).toBe('get')
})
