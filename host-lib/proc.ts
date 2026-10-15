import { execFile, type ChildProcess } from 'node:child_process'

export type RunResult = { ok: boolean; out: string; failed?: boolean }

const TIMEOUT_MS = 5_000
const MAX_BUFFER = 1 << 20

const running = new Set<ChildProcess>()

// Stops the lookups still running when a hook gives up on its deadline.
export function killAll(): void {
  for (const child of running) child.kill('SIGKILL')
}

// `failed` is only for a program that could not run at all (spawn error, timeout); a non-zero exit is an answer.
export function run(dir: string, argv: string[], vars?: Record<string, string>, timeoutMs = TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv
    if (cmd === undefined) return resolve({ ok: false, out: '', failed: true })
    const child = execFile(cmd, args, { cwd: dir, env: vars ? { ...process.env, ...vars } : process.env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout) => {
      running.delete(child)
      if (!err) return resolve({ ok: true, out: stdout.trim() })
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      resolve(typeof e.code === 'number' && !e.killed ? { ok: false, out: stdout.trim() } : { ok: false, out: '', failed: true })
    })
    running.add(child)
  })
}
