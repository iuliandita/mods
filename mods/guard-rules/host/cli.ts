import { userInfo } from 'node:os'
import { resolve } from 'node:path'

import { applyGuardCommand, parseGuardCommand } from '../claude/hooks/context'
import { checkCommand, checkTool, type Check } from './check'
import { killAll, loadClasses, loadConfig, nodeEnv, saveClasses, warnAskOnce } from './env'

// Codex names its patch tool apply_patch and also matches it as Edit and Write.
const FILE_TOOLS = new Set(['apply_patch', 'Edit', 'Write'])

const USAGE = 'usage: guard-rules hook (a Codex hook, JSON on stdin) | guard-rules context list | <name> protected|relaxed | forget <name>'

// Under the hook timeout Codex applies (30 s in the bundled hooks.json), so the guard answers before it is cut off.
const DEADLINE_MS = 15_000
const TIMED_OUT = 'guard-rules: checking the command took too long, so it was blocked (fail closed). Retry it.'

// `config` and `store` name other files for a test; the real entries never set them.
export type Io = { stdin: () => Promise<string>; out: (s: string) => void; err: (s: string) => void; interactive: boolean; config?: string; store?: string; deadlineMs?: number }

async function withDeadline(work: Promise<Check>, ms: number): Promise<Check> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Check>((done) => {
    timer = setTimeout(() => {
      killAll()
      done({ deny: TIMED_OUT })
    }, ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

function emit(io: Io, result: Check): void {
  if (result.deny) {
    io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.deny } }))
  } else if (result.notice) {
    io.out(JSON.stringify({ systemMessage: result.notice }))
  }
}

// Codex PreToolUse. A Bash call is judged by the rules; a file-editing call only for the guard's own files. A deny is the documented JSON decision; a hook that cannot answer
// at all exits 2, which Codex also treats as a block (any other failing exit lets the call through).
async function hook(io: Io): Promise<number> {
  let input: { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; cwd?: unknown }
  try {
    input = JSON.parse(await io.stdin())
  } catch {
    io.err('guard-rules: the hook input was not JSON, so the call was blocked (fail closed).')
    return 2
  }
  if (input.hook_event_name !== 'PreToolUse') return 0
  if (typeof input.tool_name === 'string' && FILE_TOOLS.has(input.tool_name)) {
    if (typeof input.cwd !== 'string') {
      io.err('guard-rules: a file edit without a directory cannot be checked, so it was blocked (fail closed).')
      return 2
    }
    emit(io, checkTool(input.tool_input, input.cwd, process.env.HOME || userInfo().homedir))
    return 0
  }
  if (input.tool_name !== 'Bash') return 0
  const toolInput = input.tool_input as { command?: unknown; workdir?: unknown } | null
  if (typeof toolInput?.command !== 'string' || typeof input.cwd !== 'string') {
    io.err('guard-rules: a Bash call without a command or a directory cannot be checked, so it was blocked (fail closed).')
    return 2
  }
  const cwd = typeof toolInput.workdir === 'string' && toolInput.workdir !== '' ? resolve(input.cwd, toolInput.workdir) : input.cwd
  const cfg = loadConfig(io.config)
  if (cfg.unparsed === 'ask') warnAskOnce(io.err, io.store)
  const result = await withDeadline(checkCommand(toolInput.command, cfg, nodeEnv(cwd, () => loadClasses(io.store))), io.deadlineMs ?? DEADLINE_MS)
  emit(io, result)
  return 0
}

// `list` only reads. Changing a class needs a terminal on stdin and stdout, so a pipe cannot do it quietly; a
// terminal is not proof the user typed it, which is why the hook also refuses to run this command for the model.
function context(args: string[], io: Io): number {
  const text = args.join(' ')
  const cmd = parseGuardCommand(text)
  if (cmd.action !== 'list' && cmd.action !== 'error' && !io.interactive) {
    io.err('guard-rules: only the user can change classifications; run this in your own terminal.')
    return 1
  }
  const result = applyGuardCommand(text, { kind: 'composer' }, loadClasses(io.store), loadConfig(io.config))
  if (result.stored) saveClasses(result.stored, io.store)
  io.out(result.text + '\n')
  return cmd.action === 'error' ? 1 : 0
}

export async function main(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === 'hook') return hook(io)
  if (sub === 'context') return context(rest, io)
  io.err(USAGE)
  return 1
}
