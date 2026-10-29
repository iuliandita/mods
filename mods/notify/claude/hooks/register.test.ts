import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const done = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

// The engine beneath the mod: `uname -s` and the notifier, recorded. `notifier` is how the command ends.
function world(on: On, notifier: 'ok' | 'missing' | 'fail' = 'ok', uname = 'Linux\n', block?: string) {
  const seen = { runs: [] as string[][], toasts: [] as string[] }
  on('classic.Stop', () => (block === undefined ? {} : { block }))
  on('classic.Notification', () => ({}))
  on('process.run', (_$, e) => {
    const argv = [...(e as { argv: string[] }).argv]
    seen.runs.push(argv)
    if (argv[0] === 'uname') return done(uname)
    if (notifier === 'missing') return { deny: `spawn ${argv[0]} ENOENT: no such file or directory` } as never
    return done('', notifier === 'fail' ? 1 : 0)
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

const sent = (seen: { runs: string[][] }) => seen.runs.filter((a) => a[0] !== 'uname')

test('Stop shows a finish notice titled with the project folder', async ($, on) => {
  const seen = world(on)
  await $.classic.Stop({ cwd: '/work/my-repo', stop_hook_active: false })
  expect(sent(seen)).toEqual([['notify-send', '--app-name=mods', '--', 'my-repo', 'Finished']])
  expect(seen.toasts).toEqual([])
})

test('Notification shows an input notice by its type; other types and subagents are silent', async ($, on) => {
  const seen = world(on)
  await $.classic.Notification({ cwd: '/work/my-repo', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  await $.classic.Notification({ cwd: '/work/my-repo', message: 'logged in', notification_type: 'auth_success' })
  await $.classic.Stop({ cwd: '/work/my-repo', stop_hook_active: false, agent_id: 'sub' })
  expect(sent(seen)).toEqual([['notify-send', '--app-name=mods', '--', 'my-repo', 'Needs your permission']])
  expect(JSON.stringify(seen.runs)).not.toContain('Bash')
})

test('events limits what is shown', { options: { events: 'input' } }, async ($, on) => {
  const seen = world(on)
  await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false })
  await $.classic.Notification({ cwd: '/w/r', message: 'm', notification_type: 'idle_prompt' })
  expect(sent(seen).map((a) => a.at(-1))).toEqual(['Waiting for your input'])
})

test('sound on asks the notifier for its sound; macOS goes through osascript', { options: { sound: 'on' } }, async ($, on) => {
  const seen = world(on, 'ok', 'Darwin\n')
  await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false })
  const [argv] = sent(seen)
  expect(argv?.[0]).toBe('osascript')
  expect(argv?.[2]).toContain('sound name "Glass"')
})

test('mode off registers nothing and runs nothing', { options: { mode: 'off' } }, async ($, on) => {
  const seen = world(on)
  await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false })
  await $.classic.Notification({ cwd: '/w/r', message: 'm', notification_type: 'permission_prompt' })
  expect(seen.runs).toEqual([])
})

test('a missing notifier is one warning toast for the session, and the hook still succeeds', async ($, on) => {
  const seen = world(on, 'missing')
  await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false })
  await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false })
  expect(seen.toasts).toEqual(['notify: warning: notify-send not found: no notification was shown; install it or set mode to off'])
})

test('a notifier that exits non-zero is a warning too', async ($, on) => {
  const seen = world(on, 'fail')
  await $.classic.Notification({ cwd: '/w/r', message: 'm', notification_type: 'permission_prompt' })
  expect(seen.toasts).toEqual(['notify: warning: notify-send failed: it exited 1; check the desktop notification service'])
})

test('an unknown platform warns instead of failing', async ($, on) => {
  const seen = world(on, 'ok', 'Plan9\n')
  await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false })
  expect(sent(seen)).toEqual([])
  expect(seen.toasts[0]).toContain('notify: warning: no notifier for plan9')
})

test('a Stop that another hook blocks is not a finish', async ($, on) => {
  const seen = world(on, 'ok', 'Linux\n', 'keep going')
  await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false })
  expect(sent(seen)).toEqual([])
})
