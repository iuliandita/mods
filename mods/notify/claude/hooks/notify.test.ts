import { expect, test } from 'claude-code/testing'

import { claudeNotice, clean, codexNotice, deliver, notifierArgv, opencodeNotice, parseConfig, platformFromUname, projectName, wanted, type Notice } from './notify'

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
  expect(claudeNotice('Stop', { cwd: '/work/my-repo' })).toEqual({ kind: 'finish', title: 'my-repo', body: 'Finished' })
  const bodies = new Map([
    ['permission_prompt', 'Needs your permission'],
    ['idle_prompt', 'Waiting for your input'],
    ['elicitation_dialog', 'Needs your input'],
  ])
  for (const [type, body] of bodies) expect(claudeNotice('Notification', { cwd: '/work/my-repo', notification_type: type })).toEqual({ kind: 'input', title: 'my-repo', body })
  for (const type of ['auth_success', 'constructor', '', undefined]) expect(claudeNotice('Notification', { cwd: '/w/r', notification_type: type })).toBeNull()
  expect(claudeNotice('Stop', { cwd: '/w/r', agent_id: 'a1' })).toBeNull()
})

test('Codex events: Stop and the notify setting finish, PermissionRequest is input', () => {
  expect(codexNotice({ hook_event_name: 'Stop', cwd: '/w/repo' })).toEqual({ kind: 'finish', title: 'repo', body: 'Finished' })
  expect(codexNotice({ type: 'agent-turn-complete', cwd: '/w/repo' })?.kind).toBe('finish')
  expect(codexNotice({ hook_event_name: 'PermissionRequest', cwd: '/w/repo' })).toEqual({ kind: 'input', title: 'repo', body: 'Needs your permission' })
  for (const other of [{}, { hook_event_name: 'PreToolUse' }, { type: 'approval-requested' }]) expect(codexNotice(other)).toBeNull()
  for (const event of [{ hook_event_name: 'Stop' }, { hook_event_name: 'PermissionRequest' }, { type: 'agent-turn-complete' }]) {
    expect(codexNotice({ ...event, agent_id: 'child' })).toBeNull()
  }
})

test('OpenCode events: idle is finish, a permission or a form is input', () => {
  expect(opencodeNotice('session.idle', '/w/repo')?.kind).toBe('finish')
  expect(opencodeNotice('permission.asked', '/w/repo')?.body).toBe('Needs your permission')
  expect(opencodeNotice('form.created', '/w/repo')?.body).toBe('Needs your input')
  for (const type of ['session.created', 'permission.replied', 'session.execution.succeeded']) expect(opencodeNotice(type, '/w/repo')).toBeNull()
})

test('events and mode decide whether a notice is shown', () => {
  const finish = notice()
  const input = notice({ kind: 'input' })
  expect([wanted(parseConfig({}), finish), wanted(parseConfig({}), input)]).toEqual([true, true])
  expect([wanted(parseConfig({ events: 'input' }), finish), wanted(parseConfig({ events: 'input' }), input)]).toEqual([false, true])
  expect(wanted(parseConfig({ mode: 'off' }), finish)).toBe(false)
  expect(wanted(parseConfig({}), null)).toBe(false)
})

test('the title is the project folder name, cleaned and cut; no folder gives a fallback', () => {
  expect(projectName('/srv/work/api/')).toBe('api')
  expect(projectName('C:\\work\\api')).toBe('api')
  expect(projectName('/')).toBe('agent')
  expect(projectName(undefined)).toBe('agent')
  expect(projectName('/w/a\u001b[31mb\u202ec\nd')).toBe('a [31mb c d')
  expect([...projectName(`/w/${'x'.repeat(100)}`)]).toHaveLength(60)
  expect(clean('  a \t b  ', 10)).toBe('a b')
})

test('Linux uses notify-send with the text after `--`; sound adds a hint', () => {
  expect(notifierArgv('linux', notice({ title: '-rf' }), false)).toEqual(['notify-send', '--app-name=mods', '--', '-rf', 'Finished'])
  expect(notifierArgv('linux', notice(), true)).toEqual(['notify-send', '--app-name=mods', '--hint=string:sound-name:message-new-instant', '--', 'my-repo', 'Finished'])
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

  const missing = await deliver(async () => Promise.reject(new Error('spawn notify-send ENOENT')), 'linux', notice(), false)
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
