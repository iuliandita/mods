import { codexNotice, deliver, wanted, withContext, type Fs, type Runner } from '../claude/hooks/notify'
import { home, nodeFs, readConfig } from './run'

export type Io = {
  stdin: () => Promise<string>
  err: (s: string) => void
  run: Runner
  platform: string
  options?: string
  fs?: Fs
  home?: string | null
}

const USAGE = 'notify: error: unknown command: expected hook or notify; run "notify hook" from a Codex hook or "notify notify <json>" from the notify setting'

function parse(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// `hook` reads a Codex hook payload on stdin (Stop, PermissionRequest); `notify` takes the JSON Codex appends to
// the program in its `notify` setting (agent-turn-complete). Neither ever fails the caller: a hook that exits
// non-zero can stop the agent.
export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'hook' && command !== 'notify') {
    io.err(USAGE)
    return 2
  }
  const { config, warning } = readConfig(io.options)
  if (config.mode === 'off') return 0
  if (warning) io.err(warning)
  const input = parse(command === 'hook' ? await io.stdin() : (rest.at(-1) ?? ''))
  const pending = input ? codexNotice(input) : null
  if (!wanted(config, pending)) return 0
  const notice = await withContext(pending, io.home === undefined ? home() : io.home, io.fs ?? nodeFs)
  const result = await deliver(io.run, io.platform, notice, config.sound)
  if (!result.ok) io.err(result.warning)
  return 0
}
