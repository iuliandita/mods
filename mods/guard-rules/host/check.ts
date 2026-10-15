import { evaluate, formatDeny, type Config, type Env } from '../claude/hooks/rules'
import { extractCalls, resolvePath } from '../claude/hooks/shell'
import { guardDirs } from './env'

export type Check = { deny?: string; notice?: string }

const FAILED =
  'guard-rules: the guard failed, so the command was blocked (fail closed). Check the options file (~/.config/iuliandita-mods/guard-rules.json) and the host log. If this keeps happening, set modeAttribution, modeProtectedBranch and modeIdentity to off in the options file (modeContext for kubectl, helm and terraform), or disable the plugin.'

// Best effort: a command that runs the CLI's `context` subcommand with anything but `list` is left for the user to
// type. The model could still spell it past this filter, so it is not a boundary.
const SELF_CLASSIFY = /guard-rules\S*\s+context\s+(?!list\b)\S/

const CLASSIFY_DENIED =
  'guard-rules: only the user can change classifications. Ask the user to run "guard-rules context ..." in their own terminal.'

// Best effort, like the filter above: the guard's own options and class files are for the user to change. A shell
// command that names their directories, or an edit tool aimed at them, is refused. It reads text and paths, so a
// path built at run time gets past it.
const OWN_DIRS = /(?:\.config|\.local\/share)\/iuliandita-mods/

const OWN_FILES_DENIED =
  'guard-rules: the guard\'s own options and class files are for the user to change. Ask the user to edit them in their own terminal.'

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) strings(v, out)
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) strings(v, out)
  return out
}

// A file-editing tool call (apply_patch, edit, write): any string in its input that names the guard's directories,
// or a path that resolves into them from the call's directory, is refused. `dirs` is for tests.
export function checkTool(input: unknown, cwd: string, home: string, dirs = guardDirs()): Check {
  const hit = strings(input).some((text) => {
    const flat = text.replace(/["'\\]/g, '')
    if (OWN_DIRS.test(flat)) return true
    return flat.split('\n').some((line) => {
      const path = line.replace(/^\*\*\* (?:Add File|Update File|Delete File|Move to): /, '').trim()
      if (path === '' || path.length > 4096) return false
      const full = resolvePath(cwd, path, home)
      return dirs.some((d) => full === d || full.startsWith(d + '/'))
    })
  })
  return hit ? { deny: OWN_FILES_DENIED } : {}
}

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
    const flat = command.replace(/["'\\]/g, '')
    if (SELF_CLASSIFY.test(flat)) return { deny: CLASSIFY_DENIED }
    if (OWN_DIRS.test(flat)) return { deny: OWN_FILES_DENIED }
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
