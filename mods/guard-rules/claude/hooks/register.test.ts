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

test('ask mode returns a classic permission ask only for enforced parser findings', {
  options: { modeUnparsed: 'ask' },
  plugins: [{
    name: 'permission-observer',
    tier: 'prepend',
    register(on) {
      on('classic.PreToolUse', { tool: 'Bash' }, async ($, e, next) => {
        const result = await next(e)
        $.ui.toast(JSON.stringify(result))
        return result
      })
    },
  }],
}, async ($, on) => {
  world(on)
  const decisions: string[] = []
  on('ui.toast', (_$, e) => {
    decisions.push(e.text)
    return { value: undefined }
  })
  on('classic.PreToolUse', () => ({}))
  await $.tool.call({ tool: 'Bash', command: 'xargs git push' })
  expect(decisions).toHaveLength(1)
  expect(decisions[0]).toContain('"ask":"guard-rules: unparsed:')
  expect(decisions[0]).not.toContain('"allow"')
  decisions.length = 0
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(decisions).toEqual(['{}'])
})

test('ask mode keeps parsed violations as hard denies', {
  options: { modeUnparsed: 'ask', identityRules: '[{"prefix":"/h/","email":"me@personal.example"}]' },
}, async ($, on) => {
  world(on, { branch: 'main' })
  on('store.get', () => ({ value: {} }))
  for (const [command, reason] of [
    ['xargs git push; git commit -m x', 'protected branch'],
    ['xargs git push; git commit -m "Co-Authored-By: A"', 'attribution'],
    ['xargs git push; git commit -m x', 'identity'],
    ['xargs git push; kubectl --context prod delete pod x', 'context'],
    ['xargs git push; git -C "$D" push', 'lookup'],
  ] as const) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny, command).toContain(reason)
  }
})

test('ask mode fails closed when its classic permission check fails', { options: { modeUnparsed: 'ask' } }, async ($, on) => {
  let reads = 0
  on('session.cwd', () => {
    if (++reads > 1) throw new Error('unavailable')
    return { value: '/h/personal/repo' }
  })
  on('env.get', () => ({ value: '/h' }))
  let ran = false
  on('tool.call', { tool: 'Bash' }, () => {
    ran = true
    return { result: { stdout: 'ran', stderr: '', interrupted: false } as never }
  })
  const result = await $.tool.call({ tool: 'Bash', command: 'xargs git push' })
  expect(JSON.stringify(result)).toContain('permission check failed')
  expect(JSON.stringify(result)).toContain('fail closed')
  expect(ran).toBe(false)
})

test('ask mode preserves other classic denials and checks rewritten commands', { options: { modeUnparsed: 'ask' } }, async ($, on) => {
  world(on, { branch: 'main' })
  let rewrite = false
  on('classic.PreToolUse', () => rewrite
    ? { allow: true, updatedInput: { command: 'git commit -m x' } }
    : { deny: 'another permission gate denied this call' })
  const denied = await $.tool.call({ tool: 'Bash', command: 'xargs git push' })
  expect(JSON.stringify(denied)).toContain('another permission gate denied')
  rewrite = true
  const rewritten = await $.tool.call({ tool: 'Bash', command: 'xargs git push' })
  expect(JSON.stringify(rewritten)).toContain('protected branch')
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
