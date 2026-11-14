import type { On } from 'claude-code'
import type { Env } from './notify'
import { expect, test } from 'claude-code/testing'

const done = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

// The engine beneath the mod: `uname -s` and the notifier, recorded. `notifier` is how the command ends.
function world(on: On, notifier: 'ok' | 'missing' | 'fail' | 'hang' = 'ok', uname = 'Linux\n', block?: string, env: Env = {}) {
  const seen = { runs: [] as string[][], toasts: [] as string[] }
  let now = 1_000
  on('clock.now', () => ({ value: now }))
  on('classic.Stop', () => (block === undefined ? {} : { block }))
  on('classic.Notification', () => ({}))
  on('env.get', (_$, e) => ({ value: env[e.name] }) as never)
  on('process.run', (_$, e) => {
    const argv = [...(e as { argv: string[] }).argv]
    seen.runs.push(argv)
    if (argv[0] === 'uname') return done(uname)
    if (notifier === 'hang') {
      now += (e as { init?: { timeoutMs?: number } }).init?.timeoutMs ?? 0
      return { deny: 'the command was still running' } as never
    }
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

test('Stop shows a finish notice titled with the project folder and harness', async ($, on) => {
  const seen = world(on)
  await $.classic.Stop({ cwd: '/work/my-repo', stop_hook_active: false })
  expect(sent(seen)).toEqual([['env', '-u', 'LD_LIBRARY_PATH', '-u', 'LD_PRELOAD', 'notify-send', '--app-name=mods', '--', 'my-repo (Claude Code)', 'Finished']])
  expect(seen.toasts).toEqual([])
})

test('Notification shows an input notice by its type; other types and subagents are silent', async ($, on) => {
  const seen = world(on)
  await $.classic.Notification({ cwd: '/work/my-repo', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  await $.classic.Notification({ cwd: '/work/my-repo', message: 'logged in', notification_type: 'auth_success' })
  await $.classic.Stop({ cwd: '/work/my-repo', stop_hook_active: false, agent_id: 'sub' })
  expect(sent(seen)).toEqual([['env', '-u', 'LD_LIBRARY_PATH', '-u', 'LD_PRELOAD', 'notify-send', '--app-name=mods', '--', 'my-repo (Claude Code)', 'Needs your permission']])
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

test('a notifier that never answers is waited for once, then delivery stops for the session', async ($, on) => {
  const seen = world(on, 'hang')
  await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false })
  await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false })
  await $.classic.Notification({ cwd: '/w/r', message: 'm', notification_type: 'permission_prompt' })
  expect(sent(seen)).toHaveLength(1)
  expect(seen.toasts).toEqual(['notify: warning: notify-send timed out: no notification was shown; check the desktop notification service'])
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

test('the title and body use the repo folder and branch read through the engine', async ($, on) => {
  const seen = world(on, 'ok', 'Linux\n', undefined, { HOME: '/h' })
  on('fs.stat', (_$, e) => ((e as { path: string }).path === '/h/code/mods/.git' ? ({ value: { kind: 'dir' } } as never) : ({ deny: 'ENOENT' } as never)))
  on('fs.read', (_$, e) => ((e as { path: string }).path === '/h/code/mods/.git/HEAD' ? ({ value: 'ref: refs/heads/develop\n' } as never) : ({ deny: 'ENOENT' } as never)))
  await $.classic.Stop({ cwd: '/h/code/mods/mods/notify', stop_hook_active: false })
  expect(sent(seen)).toEqual([['env', '-u', 'LD_LIBRARY_PATH', '-u', 'LD_PRELOAD', 'notify-send', '--app-name=mods', '--', 'mods (Claude Code)', 'Finished on develop']])
})

test('child env signals and the process opt-out suppress Stop and Notification', async ($, on) => {
  const env: Record<string, string | undefined> = {}
  const seen = world(on, 'ok', 'Linux\n', undefined, env)
  for (const values of [
    { T3CODE_THREAD_ID: 'thread:delegated-task:child' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
    { IULIANDITA_MODS_NOTIFY: 'off' },
  ]) {
    for (const key of Object.keys(env)) delete env[key]
    Object.assign(env, values)
    await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false })
    await $.classic.Notification({ cwd: '/w/r', message: 'private', notification_type: 'elicitation_dialog' })
  }
  expect(sent(seen)).toEqual([])
  for (const key of Object.keys(env)) delete env[key]
  Object.assign(env, { T3CODE_THREAD_ID: 'bare-uuid', CLAUDE_CODE_ENTRYPOINT: 't3-code', CLAUDE_CODE_CHILD_SESSION: '1' })
  await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false, last_assistant_message: 'private\n[needs you] hidden' })
  expect(sent(seen).map((a) => a.at(-1))).toEqual(['Needs you'])
})

test('state off keeps the finish reason fixed', { options: { state: 'off' } }, async ($, on) => {
  const seen = world(on)
  await $.classic.Stop({ cwd: '/w/r', stop_hook_active: false, last_assistant_message: '[done]' })
  expect(sent(seen).map((a) => a.at(-1))).toEqual(['Finished'])
})

test('native questions notify once across redraws, Notification and Stop; answering permits a finish', async ($, on) => {
  const seen = world(on)
  on('session.cwd', () => ({ value: '/work/my-repo' }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('classic.PostToolUse', () => ({}))
  const question = { plugin: 'notify', component: 'AskUserQuestion' as const, surface: 'terminal' as const, requestId: 'question', props: { tool: 'AskUserQuestion', questions: [] } }
  const first = await $.ui.mount(question)
  await first.redraw()
  await $.classic.Notification({ cwd: '/work/my-repo', message: 'private', notification_type: 'elicitation_dialog' })
  await $.classic.Stop({ cwd: '/work/my-repo', stop_hook_active: false })
  expect(sent(seen).map((a) => a.at(-1))).toEqual(['Needs your input'])
  await $.classic.PostToolUse({ cwd: '/work/my-repo', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: {}, tool_use_id: 'question' })
  await $.classic.Stop({ cwd: '/work/my-repo', stop_hook_active: false, last_assistant_message: '[done]' })
  expect(sent(seen).map((a) => a.at(-1))).toEqual(['Needs your input', 'Done'])
  await first.unmount()
})
