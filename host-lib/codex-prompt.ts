import { anthropicComplete, createEngine, fileStore, storeFile, type Complete, type NodeEngine } from './engine'
import { loadOptions } from './options'
import { parsePrompt, promptOutput, spawnMeasure, withDeadline, type GateResult, type PromptInput } from './prompt'

export type Io = {
  stdin: () => Promise<string>
  out: (s: string) => void
  err: (s: string) => void
  // The bundle that runs `measure`, for the detached dry-run measurement.
  bundle: string
  options?: string
  store?: string
  complete?: Complete
  measure?: (p: PromptInput) => void
  deadlineMs?: number
  // Mod-specific test inputs (skill directories, say).
  extra?: unknown
}

export type Spec<C extends { mode: string }> = {
  mod: string
  config: (options: Record<string, unknown>) => C
  // True when the prompt needs no judging (too short, a command...).
  skip: (input: PromptInput, c: C) => boolean
  // The notice to show once when this config may send the prompt to a third party; null when it cannot.
  notice: (c: C) => string | null
  // One prompt through the mod's shared logic. `notify` collects toasts.
  run: (engine: NodeEngine, c: C, input: PromptInput) => Promise<GateResult>
  // Text for `summary`, `last` and `clear`.
  stats: (cmd: 'summary' | 'last' | 'clear', c: C, store: ReturnType<typeof fileStore>) => Promise<string>
  usage: string
}

const DEADLINE_MS = 25_000

// The Codex side of a prompt mod: a UserPromptSubmit hook, its detached dry-run measurement, and a stats CLI.
export function makePromptCli<C extends { mode: string }>(spec: (io: Io) => Spec<C>) {
  const config = (io: Io, sp: Spec<C>): C => {
    const loaded = loadOptions(sp.mod, io.options)
    return sp.config(loaded.error ? {} : loaded.options)
  }

  async function judge(io: Io, sp: Spec<C>, input: PromptInput, c: C): Promise<{ result: GateResult; notices: string[] }> {
    const notices: string[] = []
    const complete = io.complete ?? anthropicComplete(() => process.env.ANTHROPIC_API_KEY)
    const engine = createEngine({ mod: sp.mod, cwd: input.cwd, complete, notify: (t) => notices.push(t), store: io.store })
    const result = await sp.run(engine, c, input)
    // Notices are fire and forget in the shared code; give them a moment to land.
    if (process.env.TYPESAFE_API_KEY) await new Promise((done) => setTimeout(done, 100))
    return { result, notices }
  }

  // Advisory: any failure lets the prompt through. In dry mode the prompt goes on at once and a process of its own
  // measures it afterwards.
  async function hook(io: Io): Promise<number> {
    const input = parsePrompt(await io.stdin())
    if (!input) return 0
    try {
      const sp = spec(io)
      const c = config(io, sp)
      if (c.mode === 'off' || sp.skip(input, c)) return 0
      if (c.mode === 'dry') {
        const notices: string[] = []
        const text = sp.notice(c)
        if (text) {
          // The measuring process cannot show anything, so the notice is shown here, once per install.
          const store = fileStore(io.store ?? storeFile(sp.mod))
          if ((await store.get('jevNotice')) !== true) {
            notices.push(text)
            await store.set('jevNotice', true)
          }
        }
        ;(io.measure ?? ((p) => spawnMeasure(io.bundle, p)))(input)
        const out = promptOutput({}, notices)
        if (out) io.out(out)
        return 0
      }
      const done = await withDeadline(judge(io, sp, input, c), io.deadlineMs ?? DEADLINE_MS)
      const out = done ? promptOutput(done.result, done.notices) : null
      if (out) io.out(out)
    } catch {
      // fail open
    }
    return 0
  }

  // The detached half of dry mode: the same logic, then the log write it schedules, which keeps this process alive.
  async function measure(io: Io): Promise<number> {
    try {
      const raw = JSON.parse(await io.stdin()) as Partial<PromptInput>
      if (typeof raw.prompt !== 'string' || typeof raw.cwd !== 'string') return 0
      const sp = spec(io)
      await judge(io, sp, { prompt: raw.prompt, cwd: raw.cwd }, config(io, sp))
    } catch {
      // the prompt is long gone
    }
    return 0
  }

  async function main(argv: string[], io: Io): Promise<number> {
    const cmd = argv[0]
    if (cmd === 'hook') return hook(io)
    if (cmd === 'measure') return measure(io)
    const sp = spec(io)
    if (cmd === 'summary' || cmd === 'last' || cmd === 'clear') {
      io.out((await sp.stats(cmd, config(io, sp), fileStore(io.store ?? storeFile(sp.mod)))) + '\n')
      return 0
    }
    io.err(`${sp.usage} (${sp.mod} hook is the Codex hook entry.)`)
    return 1
  }

  return { hook, measure, main, judge }
}
