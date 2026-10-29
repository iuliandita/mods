import { expect, test } from 'claude-code/testing'

import { claudeNotice, clean, codexNotice, deliver, notifierArgv, opencodeNotice, parseConfig, platformFromUname, resolvePlace, wanted, withContext, type Fs, type Notice } from './notify'

const notice = (over: Partial<Notice> = {}): Notice => ({ kind: 'finish', title: 'my-repo', body: 'Finished', ...over })

test('options: defaults, each option, and a value that cannot be read counts as the default', () => {
  const d = parseConfig(undefined)
  expect([d.mode, [...d.events], d.sound]).toEqual(['on', ['finish', 'input'], false])
  expect(parseConfig({ mode: 'off' }).mode).toBe('off')
  expect(parseConfig({ mode: 'sideways' }).mode).toBe('on')
  expect([...parseConfig({ events: 'input' }).events]).toEqual(['input'])
  expect([...parseConfig({ events: ' Finish , nope ' }).events]).toEqual(['finish'])
  expect([...parseConfig({ events: ['input', 'finish'] }).events]).toEqual(['input', 'finish'])
  for (const events of ['', 'nope', 3, null]) expect([...parseConfig({ events }).events]).toEqual(['finish', 'input'])
  expect(parseConfig({ sound: 'on' }).sound).toBe(true)
  for (const sound of ['off', 'true', true, 1, '']) expect(parseConfig({ sound }).sound).toBe(false)
})

test('Claude Code events: Stop is finish, the three Notification types are input, anything else is silent', () => {
  expect(claudeNotice('Stop', { cwd: '/work/my-repo' })).toEqual({ kind: 'finish', harness: 'Claude Code', cwd: '/work/my-repo', reason: 'Finished' })
  const bodies = new Map([
    ['permission_prompt', 'Needs your permission'],
    ['idle_prompt', 'Waiting for your input'],
    ['elicitation_dialog', 'Needs your input'],
  ])
  for (const [type, body] of bodies) expect(claudeNotice('Notification', { cwd: '/work/my-repo', notification_type: type })).toEqual({ kind: 'input', harness: 'Claude Code', cwd: '/work/my-repo', reason: body })
  for (const type of ['auth_success', 'constructor', '', undefined]) expect(claudeNotice('Notification', { cwd: '/w/r', notification_type: type })).toBeNull()
  expect(claudeNotice('Stop', { cwd: '/w/r', agent_id: 'a1' })).toBeNull()
})

test('Codex events: Stop and the notify setting finish, PermissionRequest is input', () => {
  expect(codexNotice({ hook_event_name: 'Stop', cwd: '/w/repo' })).toEqual({ kind: 'finish', harness: 'Codex', cwd: '/w/repo', reason: 'Finished' })
  expect(codexNotice({ type: 'agent-turn-complete', cwd: '/w/repo' })?.kind).toBe('finish')
  expect(codexNotice({ hook_event_name: 'PermissionRequest', cwd: '/w/repo' })).toEqual({ kind: 'input', harness: 'Codex', cwd: '/w/repo', reason: 'Needs your permission' })
  for (const other of [{}, { hook_event_name: 'PreToolUse' }, { type: 'approval-requested' }]) expect(codexNotice(other)).toBeNull()
  for (const event of [{ hook_event_name: 'Stop' }, { hook_event_name: 'PermissionRequest' }, { type: 'agent-turn-complete' }]) {
    expect(codexNotice({ ...event, agent_id: 'child' })).toBeNull()
  }
})

test('OpenCode events: execution success or legacy idle is finish, a permission or a form is input', () => {
  expect(opencodeNotice('session.execution.succeeded', '/w/repo')?.kind).toBe('finish')
  expect(opencodeNotice('session.idle', '/w/repo')?.kind).toBe('finish')
  expect(opencodeNotice('permission.asked', '/w/repo')?.reason).toBe('Needs your permission')
  expect(opencodeNotice('form.created', '/w/repo')?.reason).toBe('Needs your input')
  for (const type of ['session.created', 'permission.replied', 'form.replied', 'session.execution.started', 'session.execution.failed']) expect(opencodeNotice(type, '/w/repo')).toBeNull()
})

test('events and mode decide whether a notice is shown', () => {
  const finish = notice()
  const input = notice({ kind: 'input' })
  expect([wanted(parseConfig({}), finish), wanted(parseConfig({}), input)]).toEqual([true, true])
  expect([wanted(parseConfig({ events: 'input' }), finish), wanted(parseConfig({ events: 'input' }), input)]).toEqual([false, true])
  expect(wanted(parseConfig({ mode: 'off' }), finish)).toBe(false)
  expect(wanted(parseConfig({}), null)).toBe(false)
})

// A fake file tree: file contents by path; a path with a null value is a folder (or a file that cannot be read).
const tree = (files: Record<string, string | null>): Fs => ({
  read: async (p) => files[p] ?? null,
  exists: async (p) => Object.keys(files).some((f) => f === p || f.startsWith(`${p}/`)),
})
const SHA = '0123456789abcdef0123456789abcdef01234567'

const PLACES: [string, string | undefined, Record<string, string | null>, { place: string; branch: string | null }][] = [
  ['repo root', '/h/code/mods', { '/h/code/mods/.git/HEAD': 'ref: refs/heads/develop\n' }, { place: 'mods', branch: 'develop' }],
  ['subfolder of a repo', '/h/code/mods/mods/notify', { '/h/code/mods/.git/HEAD': 'ref: refs/heads/feature/x\n' }, { place: 'mods', branch: 'feature/x' }],
  ['trailing slash', '/h/code/mods/', { '/h/code/mods/.git/HEAD': 'ref: refs/heads/develop\n' }, { place: 'mods', branch: 'develop' }],
  ['worktree .git file, relative path', '/h/wt/fix', { '/h/wt/fix/.git': 'gitdir: ../../code/mods/.git/worktrees/fix\n', '/h/code/mods/.git/worktrees/fix/HEAD': 'ref: refs/heads/fix/1\n' }, { place: 'fix', branch: 'fix/1' }],
  ['submodule .git file, absolute path', '/h/code/a/sub', { '/h/code/a/sub/.git': 'gitdir: /h/code/a/.git/modules/sub\n', '/h/code/a/.git/modules/sub/HEAD': `${SHA}\n` }, { place: 'sub', branch: '0123456' }],
  ['detached HEAD', '/h/code/mods', { '/h/code/mods/.git/HEAD': `${SHA}\n` }, { place: 'mods', branch: '0123456' }],
  ['unreadable HEAD', '/h/code/mods', { '/h/code/mods/.git/HEAD': null }, { place: 'mods', branch: null }],
  ['odd HEAD content', '/h/code/mods', { '/h/code/mods/.git/HEAD': 'garbage' }, { place: 'mods', branch: null }],
  ['no repo', '/h/notes/ideas', {}, { place: 'ideas', branch: null }],
  ['cwd is home', '/h', { '/h/.git/HEAD': 'ref: refs/heads/main' }, { place: '~', branch: null }],
  ['a repo at home is not used', '/h/scratch', { '/h/.git/HEAD': 'ref: refs/heads/main' }, { place: 'scratch', branch: null }],
  ['no cwd', undefined, {}, { place: 'agent', branch: null }],
]

test('place and branch: repo root, subfolder, worktree, submodule, detached, unreadable, no repo, home', async () => {
  for (const [name, cwd, files, want] of PLACES) expect([name, await resolvePlace(cwd, '/h', tree(files))]).toEqual([name, want])
})

test('place and branch are cleaned and cut at 60 characters, and a failing reader gives the folder name', async () => {
  const long = await resolvePlace('/h/r', '/h', tree({ '/h/r/.git/HEAD': `ref: refs/heads/a\u001b[31m${'x'.repeat(100)}` }))
  expect([...(long.branch ?? '')]).toHaveLength(60)
  expect(long.branch).not.toContain('\u001b')
  expect([...(await resolvePlace(`/h/${'y'.repeat(100)}`, '/h', tree({}))).place]).toHaveLength(60)
  const broken: Fs = { read: async () => Promise.reject(new Error('EIO')), exists: async () => Promise.reject(new Error('EIO')) }
  expect(await resolvePlace('/h/r/sub', '/h', broken)).toEqual({ place: 'sub', branch: null })
  expect(clean('  a \t b  ', 10)).toBe('a b')
})

const HARNESSES = [
  ['Claude Code', claudeNotice('Stop', { cwd: '/h/mods' }), 'mods (Claude Code)'],
  ['Codex', codexNotice({ hook_event_name: 'PermissionRequest', cwd: '/h/mods' }), 'mods (Codex)'],
  ['OpenCode', opencodeNotice('form.created', '/h/mods'), 'mods (OpenCode)'],
] as const

test('the title names the harness and the body the branch', async () => {
  for (const [, pending, title] of HARNESSES) {
    const n = await withContext(pending!, '/h', tree({ '/h/mods/.git/HEAD': 'ref: refs/heads/develop' }))
    expect([n.title, n.body.endsWith(' on develop')]).toEqual([title, true])
  }
  expect(await withContext(claudeNotice('Stop', { cwd: '/h' })!, '/h', tree({}))).toEqual({ kind: 'finish', title: '~ (Claude Code)', body: 'Finished' })
})

test('Linux clears library overrides before notify-send with the text after `--`; sound adds a hint', () => {
  expect(notifierArgv('linux', notice({ title: '-rf' }), false)).toEqual(['env', '-u', 'LD_LIBRARY_PATH', '-u', 'LD_PRELOAD', 'notify-send', '--app-name=mods', '--', '-rf', 'Finished'])
  expect(notifierArgv('linux', notice(), true)).toEqual(['env', '-u', 'LD_LIBRARY_PATH', '-u', 'LD_PRELOAD', 'notify-send', '--app-name=mods', '--hint=string:sound-name:message-new-instant', '--', 'my-repo', 'Finished'])
})

test('macOS uses osascript with quoted string literals; quotes and backslashes cannot end the string', () => {
  expect(notifierArgv('darwin', notice(), false)).toEqual(['osascript', '-e', 'display notification "Finished" with title "my-repo"'])
  expect(notifierArgv('darwin', notice(), true)?.[2]).toEndWith('sound name "Glass"')
  const hostile = notifierArgv('darwin', notice({ title: 'a" & do shell script "x\\' }), false)?.[2]
  expect(hostile).toBe('display notification "Finished" with title "a\\" & do shell script \\"x\\\\"')
  for (const other of ['win32', 'freebsd', 'unknown']) expect(notifierArgv(other, notice(), false)).toBeNull()
  expect([platformFromUname('Linux\n'), platformFromUname('Darwin')]).toEqual(['linux', 'darwin'])
})

test('delivery: sent, or one warning line for a missing notifier, a failing one or an unsupported platform', async () => {
  const calls: string[][] = []
  const ok = async (argv: string[]) => (calls.push(argv), { exitCode: 0 })
  expect(await deliver(ok, 'linux', notice(), false)).toEqual({ ok: true })
  expect(calls).toHaveLength(1)

  const missing = await deliver(async () => Promise.reject(new Error('spawn env ENOENT')), 'linux', notice(), false)
  expect(missing).toEqual({ ok: false, warning: 'notify: warning: notify-send not found: no notification was shown; install it or set mode to off' })
  const broken = await deliver(async () => Promise.reject(new Error('EACCES')), 'darwin', notice(), false)
  expect(broken.ok === false && broken.warning).toContain('notify: warning: osascript could not run')
  const failing = await deliver(async () => ({ exitCode: 3 }), 'linux', notice(), false)
  expect(failing.ok === false && failing.warning).toContain('notify-send failed: it exited 3')
  const none = await deliver(ok, 'win32', notice(), false)
  expect(none.ok === false && none.warning).toContain('no notifier for win32')
  expect(calls).toHaveLength(1)
  for (const r of [missing, broken, failing, none]) expect(r.ok === false && r.warning.split('\n')).toHaveLength(1)
})

test('Linux exit 127 reports a missing notify-send', async () => {
  expect(await deliver(async () => ({ exitCode: 127 }), 'linux', notice(), false)).toEqual({
    ok: false,
    warning: 'notify: warning: notify-send not found: no notification was shown; install it or set mode to off',
  })
})
