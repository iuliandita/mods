import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { applyGuardCommand, classify } from './context'
import { parseConfig } from './rules'

type Git = { branch?: string | null; toplevel?: string }

const done = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Stands in for the engine beneath the plugin: cwd, HOME, git, and the Bash tool itself.
function world(on: On, repo: Git = {}) {
  const r = { branch: 'feature/x', toplevel: '/h/personal/repo', ...repo }
  const git: string[] = []
  on('session.cwd', () => ({ value: '/h/personal/repo' }))
  on('env.get', () => ({ value: '/h' }))
  on('process.run', (_$, e) => {
    const args = e.argv.slice(3).join(' ')
    git.push(args)
    if (args.startsWith('symbolic-ref')) return r.branch ? done(r.branch + '\n') : done('', 1)
    if (args.startsWith('rev-parse --verify')) return done('abc\n')
    if (args.startsWith('rev-parse --show-toplevel')) return done(r.toplevel + '\n')
    return done('', 1)
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran', stderr: '', interrupted: false } as never }))
  return git
}

test('through the real tool.call chain: a trailer is denied, a clean feature-branch commit runs', async ($, on) => {
  world(on)
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "x" -m "Co-Authored-By: A <a@b.c>"' })
  expect(r.deny).toContain('guard-rules: attribution')
  const clean = await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: x"' })
  expect(clean.deny).toBeUndefined()
})

test('a commit on a protected branch is denied, with the way out in the reason', async ($, on) => {
  world(on, { branch: 'develop' })
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: x"' })
  expect(r.deny).toContain('protected branch "develop"')
  expect(r.deny).toContain('! prefix')
})

test('a guard that cannot read the session fails closed and says how to recover', async ($) => {
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: x"' })
  expect(r.deny).toContain('fail closed')
  expect(r.deny).toContain('modeAttribution, modeProtectedBranch and modeIdentity to off')
})

test('a command without git or gh never reads the session or git', async ($, on) => {
  const seen: string[] = []
  on('session.cwd', () => {
    seen.push('cwd')
    return { value: '/h/personal/repo' }
  })
  on('env.get', () => {
    seen.push('env')
    return { value: '/h' }
  })
  on('process.run', () => {
    seen.push('process')
    return done('', 1)
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran', stderr: '', interrupted: false } as never }))
  for (const command of ['ls -la', 'echo github', 'npm test']) {
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny).toBeUndefined()
  }
  expect(seen).toEqual([])
})

test('dry mode reports through a toast and lets the command run', { options: { modeAttribution: 'dry' } }, async ($, on) => {
  world(on)
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "x" -m "Co-Authored-By: A <a@b.c>"' })
  expect(r.deny).toBeUndefined()
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('dry run')
  expect(toasts[0]).toContain('Co-Authored-By')
})

test('a wrapper prefix or a spelled-out git or gh command does not hide a trailer', async ($, on) => {
  world(on)
  const trailer = '-m x -m "Co-Authored-By: a"'
  for (const command of [`rtk git commit ${trailer}`, `g""it commit ${trailer}`, `bash -c 'g""it commit ${trailer}'`, 'g""h pr create --title t --body "Co-Authored-By: a"']) {
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny).toContain('guard-rules: attribution')
  }
})

test('a git lookup that fails denies the command, while a working lookup still allows it', async ($, on) => {
  on('session.cwd', () => ({ value: '/h/personal/repo' }))
  on('env.get', () => ({ value: '/h' }))
  on('process.run', () => ({ deny: 'boom' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran', stderr: '', interrupted: false } as never }))
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(r.deny).toContain('guard-rules: lookup')
  expect(r.deny).toContain('failed or timed out')
  const status = await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(status.deny).toBeUndefined()
})


// The engine stamps `origin` and a test cannot mint a `composer` one, so the user's side is
// covered through `applyGuardCommand`; here a plugin-origin run must be refused and record nothing.
test('/guard-context: only the user can classify an environment', {
  plugins: [{
    name: 'caller',
    register(on) {
      on('turn.complete', async ($, e, next) => {
        const r = await $.command.run({ command: 'guard-context', args: 'scratch relaxed' })
        $.ui.toast(String(r.text))
        return next(e)
      })
    },
  }],
}, async ($, on) => {
  const kept: Record<string, unknown> = {}
  on('store.get', (_$, e) => ({ value: kept[e.key] }))
  on('store.set', (_$, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'guard-context' } }))
  on('session.start', () => ({ cwd: '/h/personal/repo' }))
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('session.cwd', () => ({ value: '/h/personal/repo' }))
  on('env.get', () => ({ value: '/h' }))
  on('process.run', (_$, e) => (e.argv[0] === 'kubectl' ? done('scratch\n') : done('', 1)))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran', stderr: '', interrupted: false } as never }))
  await $.session.start({ cwd: '/h/personal/repo', surface: null, isInteractive: false })

  await $.turn.complete({} as never)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('only the user')
  expect(kept).toEqual({})
  const denied = await $.tool.call({ tool: 'Bash', command: 'kubectl apply -f a.yaml' })
  expect(denied.deny).toContain('/guard-context scratch')

  const cfg = parseConfig({})
  const typed = applyGuardCommand('scratch relaxed', { kind: 'composer' }, {}, cfg)
  expect(typed.stored).toEqual({ scratch: 'relaxed' })
  expect(classify('scratch', typed.stored ?? {}, cfg)).toBe('relaxed')
  expect(applyGuardCommand('Scratch protected', { kind: 'bridge' }, {}, cfg).stored).toEqual({ scratch: 'protected' })
  expect(applyGuardCommand('forget scratch', { kind: 'composer' }, { scratch: 'relaxed' }, cfg).stored).toEqual({})
  expect(applyGuardCommand('list', { kind: 'composer' }, { scratch: 'relaxed' }, cfg).text).toContain('scratch')
  for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'sdk' }, undefined]) {
    expect(applyGuardCommand('scratch relaxed', origin as never, {}, cfg).stored).toBeUndefined()
  }
  for (const bad of ['scratch maybe', 'x'.repeat(201) + ' relaxed', 'scr\u0001atch relaxed', '']) {
    expect(applyGuardCommand(bad, { kind: 'composer' }, {}, cfg).stored).toBeUndefined()
  }
})

test('the identity probe gets the identity variables of the command through process.run', { options: { identityRules: '[{"prefix":"/h/","email":"me@personal.example"}]' } }, async ($, on) => {
  const envs: (Record<string, string> | undefined)[] = []
  on('session.cwd', () => ({ value: '/h/personal/repo' }))
  on('env.get', () => ({ value: '/h' }))
  on('process.run', (_$, e) => {
    const args = e.argv.slice(3).join(' ')
    if (args.includes('var GIT_')) envs.push(e.init?.env)
    if (args.startsWith('symbolic-ref')) return done('feature/x\n')
    if (args.startsWith('rev-parse --verify')) return done('abc\n')
    if (args.startsWith('rev-parse --show-toplevel')) return done('/h/personal/repo\n')
    if (args.includes('var GIT_')) return done('Me <me@personal.example> 1 +0000\n')
    return done('', 1)
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ran', stderr: '', interrupted: false } as never }))
  const r = await $.tool.call({ tool: 'Bash', command: 'GIT_CONFIG_GLOBAL=/x git commit -m x' })
  expect(r.deny).toBeUndefined()
  expect(envs).toEqual([{ GIT_CONFIG_GLOBAL: '/x' }, { GIT_CONFIG_GLOBAL: '/x' }])
})
