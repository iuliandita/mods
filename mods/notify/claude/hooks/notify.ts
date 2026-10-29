// Pure helpers: options, event mapping, notice text and the notifier command. No engine calls here, so the
// Codex and OpenCode adapters share them with the Claude hooks module.

export type Mode = 'off' | 'on'
export type Kind = 'finish' | 'input'
export type Config = { mode: Mode; events: ReadonlySet<Kind>; sound: boolean }
export type Notice = { kind: Kind; title: string; body: string }
export type Harness = 'Claude Code' | 'Codex' | 'OpenCode'
// What an event maps to before the repo and branch are looked up.
export type Pending = { kind: Kind; harness: Harness; cwd: unknown; reason: string }

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

const folderName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? ''

// File access for the lookup, injected so the Claude engine, plain Node and tests can each supply their own.
// `read` gives the text of a small file or null; `exists` is true for a file or directory.
export type Fs = { read(path: string): Promise<string | null>; exists(path: string): Promise<boolean> }

const MAX_DEPTH = 64
const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)

function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '' && part !== '.') out.push(part)
  }
  return '/' + out.join('/')
}

// The branch from the text of a HEAD file: a branch name, the first 7 characters of a detached commit, or null.
export function branchFromHead(text: string | null): string | null {
  const head = (text ?? '').trim()
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
  if (ref) return clean(ref[1] as string, 60) || null
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(head) ? head.slice(0, 7) : null
}

async function branchOf(fs: Fs, dir: string): Promise<string | null> {
  let head = await fs.read(`${dir}/.git/HEAD`)
  if (head === null) {
    const link = /^gitdir:\s*(.+)$/m.exec((await fs.read(`${dir}/.git`)) ?? '')
    if (link) {
      const target = (link[1] as string).trim()
      head = await fs.read(`${normalize(target.startsWith('/') ? target : `${dir}/${target}`)}/HEAD`)
    }
  }
  return branchFromHead(head)
}

// The repo folder name (the nearest parent with a `.git` file or folder, below the home folder) or, with no repo,
// the working folder name (`~` for home itself), and the branch when it can be read. A read that fails gives no
// branch and never an error. No process is started.
export async function resolvePlace(cwd: unknown, home: string | null, fs: Fs): Promise<{ place: string; branch: string | null }> {
  if (typeof cwd !== 'string') return { place: 'agent', branch: null }
  const start = trimSlash(cwd)
  const homeDir = home === null || home === '' ? null : trimSlash(home)
  if (homeDir !== null && start === homeDir) return { place: '~', branch: null }
  try {
    let dir = start
    for (let i = 0; i < MAX_DEPTH && dir.startsWith('/') && dir !== '/' && dir !== homeDir; i++) {
      if (await fs.exists(`${dir}/.git`)) return { place: clean(folderName(dir), 60) || 'agent', branch: await branchOf(fs, dir).catch(() => null) }
      dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
    }
  } catch {
    // an unreadable tree falls back to the working folder name
  }
  return { place: clean(folderName(start), 60) || 'agent', branch: null }
}

export async function withContext(p: Pending, home: string | null, fs: Fs): Promise<Notice> {
  const { place, branch } = await resolvePlace(p.cwd, home, fs)
  return { kind: p.kind, title: `${place} (${p.harness})`, body: branch ? `${p.reason} on ${branch}` : p.reason }
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

const make = (kind: Kind, harness: Harness, cwd: unknown, reason: string): Pending => ({ kind, harness, cwd, reason })

// Claude Code: the Stop hook, and the Notification hook by its type. Other types (a finished login, say) and
// the message text itself are not shown: a message can name a command.
export function claudeNotice(event: 'Stop' | 'Notification', input: { cwd?: unknown; notification_type?: unknown; agent_id?: unknown }): Pending | null {
  if (input.agent_id) return null
  if (event === 'Stop') return make('finish', 'Claude Code', input.cwd, REASON.finish)
  const body = NOTIFICATION_TYPES.get(String(input.notification_type))
  return body ? make('input', 'Claude Code', input.cwd, body) : null
}

// Codex: the Stop and PermissionRequest hooks (stdin), or the `notify` setting's agent-turn-complete payload.
export function codexNotice(input: { hook_event_name?: unknown; type?: unknown; cwd?: unknown; agent_id?: unknown }): Pending | null {
  if (input.agent_id) return null
  if (input.hook_event_name === 'Stop' || input.type === 'agent-turn-complete') return make('finish', 'Codex', input.cwd, REASON.finish)
  if (input.hook_event_name === 'PermissionRequest') return make('input', 'Codex', input.cwd, REASON.permission)
  return null
}

// OpenCode: events of the server plugin. Subagent sessions (those created with a parent) are left out by the caller.
export function opencodeNotice(type: string, cwd: unknown): Pending | null {
  if (type === 'session.execution.succeeded' || type === 'session.idle') return make('finish', 'OpenCode', cwd, REASON.finish)
  if (type === 'permission.asked') return make('input', 'OpenCode', cwd, REASON.permission)
  if (type === 'form.created') return make('input', 'OpenCode', cwd, REASON.question)
  return null
}

export const wanted = <T extends { kind: Kind }>(cfg: Config, n: T | null): n is T => n !== null && cfg.mode === 'on' && cfg.events.has(n.kind)

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
