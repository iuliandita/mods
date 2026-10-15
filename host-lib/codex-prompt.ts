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
  // One prompt through the mod's shared logic. `ctl.expired` turns true when the hook gave up on the answer.
  run: (engine: NodeEngine, c: C, input: PromptInput, ctl: { expired: boolean }) => Promise<GateResult>
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

  async function judge(io: Io, sp: Spec<C>, input: PromptInput, c: C, ctl = { expired: false }): Promise<{ result: GateResult; notices: string[] }> {
    const notices: string[] = []
    const complete = io.complete ?? anthropicComplete(() => process.env.ANTHROPIC_API_KEY)
    const engine = createEngine({ mod: sp.mod, cwd: input.cwd, complete, notify: (t) => notices.push(t), store: io.store })
    const result = await sp.run(engine, c, input, ctl)
    // Notices are fire and forget in the shared code; give them a moment to land.
    if (process.env.TYPESAFE_API_KEY) await new Promise((done) => setTimeout(done, 100))
    return { result, notices }
  }

  // Notices about where a prompt goes, each shown once per install: the judging model, and Jev when it may be used.
  async function firstNotices(io: Io, sp: Spec<C>, c: C): Promise<string[]> {
    const store = fileStore(io.store ?? storeFile(sp.mod))
    const wanted: [string, string | null][] = [
      ['anthropicNotice', process.env.ANTHROPIC_API_KEY ? `${sp.mod}: prompts are sent to api.anthropic.com with ANTHROPIC_API_KEY to be judged. Set mode=off in ~/.config/iuliandita-mods/${sp.mod}.json to stop.` : null],
      ['jevNotice', sp.notice(c)],
    ]
    const out: string[] = []
    for (const [key, text] of wanted) {
      if (text && (await store.get(key)) !== true) {
        out.push(text)
        await store.set(key, true)
      }
    }
    return out
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
        // Nothing can be judged without a key, and a process per prompt that only logs an error is not worth it.
        if (!io.measure && !process.env.ANTHROPIC_API_KEY && !process.env.TYPESAFE_API_KEY) return 0
        // The measuring process cannot show anything, so the notices are shown here, once per install.
        const notices = await firstNotices(io, sp, c)
        ;(io.measure ?? ((p) => spawnMeasure(io.bundle, p)))(input)
        const out = promptOutput({}, notices)
        if (out) io.out(out)
        return 0
      }
      const ctl = { expired: false }
      const done = await withDeadline(judge(io, sp, input, c, ctl), io.deadlineMs ?? DEADLINE_MS)
      if (!done) ctl.expired = true
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
