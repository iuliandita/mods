import { loadOptions } from '../../../host-lib/options'
import { runsValues, VALUES_DENIED } from '../claude/hooks/commands'
import { helperExists, helperMissing, parseMode, placeholderNames, rewrite } from './core'

export type Io = { stdin: () => Promise<string>; out: (s: string) => void; err: (s: string) => void; helper: string; options?: string }

const deny = (io: Io, reason: string): number => {
  io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
  return 0
}

// Codex PreToolUse on Bash. A command without a placeholder is left alone. One with a placeholder is replaced by the
// helper running it (so the value is filled in only when it runs, and the helper scrubs the output, which a Codex
// hook cannot). Like the Claude plugin it fails closed for placeholder commands only.
export async function hook(io: Io): Promise<number> {
  let input: { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown }
  try {
    input = JSON.parse(await io.stdin())
  } catch {
    return 0
  }
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return 0
  const toolInput = input.tool_input as { command?: unknown } | null
  if (typeof toolInput?.command !== 'string') return 0
  const command = toolInput.command
  try {
    const loaded = loadOptions('secret-box', io.options)
    const mode = loaded.error ? 'on' : parseMode(loaded.options.mode)
    const names = placeholderNames(command)
    if (mode === 'on' && runsValues(command)) return deny(io, VALUES_DENIED)
    if (mode === 'off' || names.length === 0) return 0
    if (mode === 'dry') {
      io.out(JSON.stringify({ systemMessage: `secret-box (dry run): would resolve ${names.join(', ')} at execution time` }))
      return 0
    }
    if (!helperExists(io.helper)) return deny(io, helperMissing(io.helper))
    io.out(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'secret-box fills in the placeholders when the command runs',
          updatedInput: { ...toolInput, command: rewrite(io.helper, command) },
        },
      }),
    )
    return 0
  } catch {
    if (!runsValues(command) && placeholderNames(command).length === 0) return 0
    return deny(io, 'secret-box: the hook failed, so the command was blocked before it ran (fail closed). Set mode to off or dry in ~/.config/iuliandita-mods/secret-box.json, or disable the plugin.')
  }
}

export async function main(argv: string[], io: Io): Promise<number> {
  if (argv[0] === 'hook') return hook(io)
  io.err('usage: secret-box hook (a Codex hook, JSON on stdin). Store and list secrets with the secret-box helper in the plugin\'s bin directory.')
  return 1
}
