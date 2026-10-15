import { makePromptCli, type Io } from '../../../host-lib/codex-prompt'
import { skipReason as skip } from '../claude/hooks/gate'
import { lastRecords, LOG_KEY, parseConfig, summary, USAGE, type Config, type Rec, type State } from '../claude/hooks/gate'
import { gate } from '../claude/hooks/register'

export type { Io }

const asBounced = (raw: unknown): Map<string, number> =>
  new Map(Object.entries(raw !== null && typeof raw === 'object' ? raw : {}).filter((e): e is [string, number] => typeof e[1] === 'number'))

// Bounced prompts are kept per working directory: sending the same words in another repository is a different prompt.
const KEY = '\0'
const scoped = (cwd: string, m: Map<string, number>): Map<string, number> =>
  new Map([...m].filter(([k]) => k.startsWith(cwd + KEY)).map(([k, t]) => [k.slice(cwd.length + 1), t]))

const cli = makePromptCli<Config>(() => ({
  mod: 'prompt-gate',
  config: parseConfig,
  skip: (input, c) => skip({ text: input.prompt, wait: false, origin: { kind: 'composer' } } as never, c) !== null,
  notice: (c) =>
    process.env.TYPESAFE_API_KEY && c.classifier !== 'haiku'
      ? `prompt-gate: prompts are sent to api.typesafe.ai (Jev) from ${c.jevPaths.trim() || 'every directory'}. Restrict with the jevPaths option, or set classifier=haiku. See the README Privacy section.`
      : null,
  // State that the Claude plugin keeps in memory (a bounced prompt) is kept in the store: each Codex hook is a new process.
  run: async (engine, c, input, ctl) => {
    const all = asBounced(await engine.store.get('bounced'))
    const before = scoped(input.cwd, all)
    const s: State = { ...c, vocab: null, bounced: new Map(before) }
    const e = { text: input.prompt, wait: false, origin: { kind: 'composer' } }
    const r = await gate(engine as never, s, e as never, (async (x: { text: string; context?: readonly string[] }) => ({ text: x.text, context: x.context })) as never)
    // The hook may have given up already; a bounce nobody was told about must not be remembered. A store that cannot
    // be written must not drop the answer. The latest map is re-read so a concurrent session's change is kept.
    if (!ctl.expired) {
      try {
        const latest = asBounced(await engine.store.get('bounced'))
        for (const h of before.keys()) if (!s.bounced.has(h)) latest.delete(input.cwd + KEY + h)
        for (const [h, t] of s.bounced) if (!before.has(h)) latest.set(input.cwd + KEY + h, t)
        await engine.store.set('bounced', Object.fromEntries(latest))
      } catch {
        // the answer stands
      }
    }
    return r
  },
  stats: async (cmd, c, store) => {
    if (cmd === 'clear') {
      await store.set(LOG_KEY, [])
      return 'prompt-gate: log cleared.'
    }
    const old = await store.get(LOG_KEY)
    const log = Array.isArray(old) ? (old as Rec[]) : []
    return cmd === 'last' ? lastRecords(log) : summary(c, log)
  },
  usage: USAGE.replaceAll('/prompt-gate', 'prompt-gate'),
}))

export const { main, hook, measure } = cli
