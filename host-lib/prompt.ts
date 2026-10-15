import { spawn } from 'node:child_process'

// Shared by the Codex UserPromptSubmit hooks of prompt-gate and skill-pick.
export type PromptInput = { prompt: string; cwd: string }

export function parsePrompt(stdin: string): PromptInput | null {
  try {
    const i = JSON.parse(stdin) as { hook_event_name?: unknown; prompt?: unknown; cwd?: unknown }
    if (i.hook_event_name !== 'UserPromptSubmit' || typeof i.prompt !== 'string') return null
    return { prompt: i.prompt, cwd: typeof i.cwd === 'string' && i.cwd ? i.cwd : process.cwd() }
  } catch {
    return null
  }
}

export type GateResult = { drop?: string; context?: readonly string[] }

// What Codex reads on stdout: a block with its reason, or context for the model, plus notices as a warning.
export function promptOutput(r: GateResult, notices: readonly string[]): string | null {
  const systemMessage = notices.length ? { systemMessage: notices.join('\n') } : {}
  if (r.drop !== undefined) return JSON.stringify({ decision: 'block', reason: r.drop, ...systemMessage })
  if (r.context?.length) return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.context.join('\n') }, ...systemMessage })
  return notices.length ? JSON.stringify(systemMessage) : null
}

// The prompt is released first and measured from a process of its own, which outlives the hook.
export function spawnMeasure(bundle: string, payload: PromptInput): void {
  const child = spawn(process.execPath, [bundle, 'measure'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
  child.on('error', () => {})
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify(payload))
  child.unref()
}

// Resolves to undefined when the work is still running after `ms`.
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => done(undefined), ms)
    work.then(
      (v) => (clearTimeout(timer), done(v)),
      (e) => (clearTimeout(timer), fail(e)),
    )
  })
}
