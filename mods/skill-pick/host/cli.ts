import { makePromptCli, type Io } from '../../../host-lib/codex-prompt'
import { codexSkillDirs, listing, scanSkills } from '../../../host-lib/skills'
import { addListing, lastRecords, LOG_KEY, parseConfig, skipReason as skip, summary, USAGE, type Config, type Rec, type State } from '../claude/hooks/pick'
import { choose } from '../claude/hooks/register'

export type { Io }

// Test input: the folders to look for skills in, instead of Codex's own.
type Extra = { skillDirs?: string[] }

// Codex names no Skill tool, so the line the Claude plugin adds is cut back to the list.
export const hostContext = (lines: readonly string[] | undefined): string[] => (lines ?? []).map((l) => l.replace(' with the Skill tool', ''))

const cli = makePromptCli<Config>((io) => ({
  mod: 'skill-pick',
  config: parseConfig,
  skip: (input, c) => skip({ text: input.prompt, wait: false, origin: { kind: 'composer' } } as never, c) !== null,
  notice: (c) =>
    process.env.TYPESAFE_API_KEY && c.picker !== 'haiku'
      ? `skill-pick: prompts and skill descriptions are sent to api.typesafe.ai (Jev) from ${c.jevPaths.trim() || 'every directory'}. Restrict with the jevPaths option, or set picker=haiku. See the README Privacy section.`
      : null,
  run: async (engine, c, input) => {
    const s: State = { ...c, listings: [], last: [], pending: null }
    addListing(s, listing(scanSkills((io.extra as Extra | undefined)?.skillDirs ?? codexSkillDirs(input.cwd))))
    const e = { text: input.prompt, wait: false, origin: { kind: 'composer' } }
    const r = await choose(engine as never, s, e as never, (async (x: { text: string; context?: readonly string[] }) => ({ text: x.text, context: x.context })) as never)
    return { ...r, context: hostContext((r as { context?: readonly string[] }).context) }
  },
  stats: async (cmd, c, store) => {
    if (cmd === 'clear') {
      await store.set(LOG_KEY, [])
      return 'skill-pick: log cleared.'
    }
    const old = await store.get(LOG_KEY)
    const log = Array.isArray(old) ? (old as Rec[]) : []
    return cmd === 'last' ? lastRecords(log) : summary(c, log)
  },
  usage: USAGE.replaceAll('/skill-pick', 'skill-pick'),
}))

export const { main, hook, measure } = cli
