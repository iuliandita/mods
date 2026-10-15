import { makePromptCli, type Io } from '../../../host-lib/codex-prompt'
import { skipReason as skip } from '../claude/hooks/gate'
import { lastRecords, LOG_KEY, parseConfig, summary, USAGE, type Config, type Rec, type State } from '../claude/hooks/gate'
import { gate } from '../claude/hooks/register'

export type { Io }

const asBounced = (raw: unknown): Map<string, number> =>
  new Map(Object.entries(raw !== null && typeof raw === 'object' ? raw : {}).filter((e): e is [string, number] => typeof e[1] === 'number'))

const cli = makePromptCli<Config>(() => ({
  mod: 'prompt-gate',
  config: parseConfig,
  skip: (input, c) => skip({ text: input.prompt, wait: false, origin: { kind: 'composer' } } as never, c) !== null,
  notice: (c) =>
    process.env.TYPESAFE_API_KEY && c.classifier !== 'haiku'
      ? `prompt-gate: prompts are sent to api.typesafe.ai (Jev) from ${c.jevPaths.trim() || 'every directory'}. Restrict with the jevPaths option, or set classifier=haiku. See the README Privacy section.`
      : null,
  // State that the Claude plugin keeps in memory (a bounced prompt) is kept in the store: each Codex hook is a new process.
  run: async (engine, c, input) => {
    const s: State = { ...c, vocab: null, bounced: asBounced(await engine.store.get('bounced')) }
    const e = { text: input.prompt, wait: false, origin: { kind: 'composer' } }
    const r = await gate(engine as never, s, e as never, (async (x: { text: string; context?: readonly string[] }) => ({ text: x.text, context: x.context })) as never)
    await engine.store.set('bounced', Object.fromEntries(s.bounced))
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
