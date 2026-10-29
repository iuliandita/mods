// Pure helpers: options, event mapping, notice text and the notifier command. No engine calls here, so the
// Codex and OpenCode adapters share them with the Claude hooks module.

export type Mode = 'off' | 'on'
export type Kind = 'finish' | 'input'
export type Config = { mode: Mode; events: ReadonlySet<Kind>; sound: boolean }
export type Notice = { kind: Kind; title: string; body: string }

const KINDS: readonly Kind[] = ['finish', 'input']

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : [])

// Options as the Claude plugin options give them, or as the user-level file does on the other hosts. An
// unreadable value counts as the default, so a typo cannot silence every notification by accident.
export function parseConfig(raw: Record<string, unknown> | null | undefined): Config {
  const o = raw ?? {}
  const listed = list(o.events)
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Kind => (KINDS as readonly string[]).includes(s))
  return {
    mode: o.mode === 'off' ? 'off' : 'on',
    events: new Set(listed.length > 0 ? listed : KINDS),
    sound: o.sound === 'on',
  }
}

// Printable text only: no control, bidi or zero-width characters, one line, cut on code points.
export function clean(s: string, max: number): string {
  return [...s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('')
}

export function projectName(cwd: unknown): string {
  if (typeof cwd !== 'string') return 'agent'
  return clean(cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? '', 60) || 'agent'
}

const REASON = {
  finish: 'Finished',
  permission: 'Needs your permission',
  idle: 'Waiting for your input',
  question: 'Needs your input',
} as const

const NOTIFICATION_TYPES = new Map<string, string>([
  ['permission_prompt', REASON.permission],
  ['idle_prompt', REASON.idle],
  ['elicitation_dialog', REASON.question],
])

const make = (kind: Kind, cwd: unknown, body: string): Notice => ({ kind, title: projectName(cwd), body })

// Claude Code: the Stop hook, and the Notification hook by its type. Other types (a finished login, say) and
// the message text itself are not shown: a message can name a command.
export function claudeNotice(event: 'Stop' | 'Notification', input: { cwd?: unknown; notification_type?: unknown; agent_id?: unknown }): Notice | null {
  if (input.agent_id) return null
  if (event === 'Stop') return make('finish', input.cwd, REASON.finish)
  const body = NOTIFICATION_TYPES.get(String(input.notification_type))
  return body ? make('input', input.cwd, body) : null
}

// Codex: the Stop and PermissionRequest hooks (stdin), or the `notify` setting's agent-turn-complete payload.
export function codexNotice(input: { hook_event_name?: unknown; type?: unknown; cwd?: unknown }): Notice | null {
  if (input.hook_event_name === 'Stop' || input.type === 'agent-turn-complete') return make('finish', input.cwd, REASON.finish)
  if (input.hook_event_name === 'PermissionRequest') return make('input', input.cwd, REASON.permission)
  return null
}

// OpenCode: events of the server plugin. Subagent sessions (those created with a parent) are left out by the caller.
export function opencodeNotice(type: string, cwd: unknown): Notice | null {
  if (type === 'session.idle') return make('finish', cwd, REASON.finish)
  if (type === 'permission.asked') return make('input', cwd, REASON.permission)
  if (type === 'form.created') return make('input', cwd, REASON.question)
  return null
}

export const wanted = (cfg: Config, n: Notice | null): n is Notice => n !== null && cfg.mode === 'on' && cfg.events.has(n.kind)

const quoteAppleScript = (s: string): string => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

// The command for a platform (`process.platform` names), or null when there is none. The text goes in as
// arguments or quoted string literals, never through a shell.
export function notifierArgv(platform: string, n: Notice, sound: boolean): string[] | null {
  if (platform === 'linux') return ['notify-send', '--app-name=mods', ...(sound ? ['--hint=string:sound-name:message-new-instant'] : []), '--', clean(n.title, 60), n.body]
  if (platform === 'darwin') {
    const script = `display notification ${quoteAppleScript(n.body)} with title ${quoteAppleScript(clean(n.title, 60))}${sound ? ' sound name "Glass"' : ''}`
    return ['osascript', '-e', script]
  }
  return null
}

// A runner starts a command and resolves with its exit code; it rejects when the program cannot be started.
export type Runner = (argv: string[]) => Promise<{ exitCode: number }>

export type Delivery = { ok: true } | { ok: false; warning: string }

const NOT_FOUND = /ENOENT|not found|no such file/i

// Shows the notice. A missing notifier, an unsupported platform or a failing command is a warning for the
// caller to print once, never an error: a notification must not break the session.
export async function deliver(run: Runner, platform: string, n: Notice, sound: boolean): Promise<Delivery> {
  const argv = notifierArgv(platform, n, sound)
  if (!argv) return { ok: false, warning: `notify: warning: no notifier for ${platform}: only Linux (notify-send) and macOS (osascript) are supported; set mode to off` }
  const bin = argv[0] as string
  try {
    const { exitCode } = await run(argv)
    return exitCode === 0 ? { ok: true } : { ok: false, warning: `notify: warning: ${bin} failed: it exited ${exitCode}; check the desktop notification service` }
  } catch (e) {
    return NOT_FOUND.test(String(e))
      ? { ok: false, warning: `notify: warning: ${bin} not found: no notification was shown; install it or set mode to off` }
      : { ok: false, warning: `notify: warning: ${bin} could not run: no notification was shown; check that it is installed and executable` }
  }
}

// `uname -s` in lower case ('linux', 'darwin') reads as `process.platform` does for the two supported systems.
export const platformFromUname = (name: string): string => name.trim().toLowerCase()
