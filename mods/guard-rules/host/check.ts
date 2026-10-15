import { evaluate, formatDeny, type Config, type Env } from '../claude/hooks/rules'
import { extractCalls } from '../claude/hooks/shell'

export type Check = { deny?: string; notice?: string }

const FAILED =
  'guard-rules: the guard failed, so the command was blocked (fail closed). Check the options file (~/.config/iuliandita-mods/guard-rules.json) and the host log. If this keeps happening, set modeAttribution, modeProtectedBranch and modeIdentity to off in the options file (modeContext for kubectl, helm and terraform), or disable the plugin.'

// Best effort: a command that runs the CLI's `context` subcommand with anything but `list` is left for the user to
// type. The model could still spell it past this filter, so it is not a boundary.
const SELF_CLASSIFY = /guard-rules\S*\s+context\s+(?!list\b)\S/

const CLASSIFY_DENIED =
  'guard-rules: only the user can change classifications. Ask the user to run "guard-rules context ..." in their own terminal.'

// The shared rules word their hints for Claude Code.
function hostText(message: string): string {
  return message
    .replaceAll('/guard-context', 'guard-rules context')
    .replaceAll('with the ! prefix', 'in their own terminal')
    .replaceAll('plugin options', 'options file (~/.config/iuliandita-mods/guard-rules.json)')
}

// One shell command, judged the way the Claude plugin judges a Bash call. Never throws: a failure is a deny.
export async function checkCommand(command: string, cfg: Config, env: Env): Promise<Check> {
  try {
    if (SELF_CLASSIFY.test(command.replace(/["'\\]/g, ''))) return { deny: CLASSIFY_DENIED }
    const probe = extractCalls(command, '/', '/')
    if (probe.ok && probe.calls.length === 0) return {}
    const verdict = await evaluate(command, cfg, env)
    if (verdict.enforced.length) return { deny: hostText(formatDeny(verdict.enforced)) }
    if (verdict.dry.length) return { notice: hostText(`guard-rules (dry run): ${verdict.dry.map((v) => v.message).join(' | ')}`) }
    return {}
  } catch {
    return { deny: FAILED }
  }
}
