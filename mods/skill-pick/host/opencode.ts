import { createEngine, promptText, type Complete } from '../../../host-lib/engine'
import { loadOptions } from '../../../host-lib/options'
import { listing } from '../../../host-lib/skills'
import { addListing, parseConfig, type State } from '../claude/hooks/pick'
import { choose } from '../claude/hooks/register'

// The parts of the OpenCode v2 plugin context this adapter uses, so the bundle needs no host package.
type Context = {
  location: { directory: string }
  generate: { text(input: { prompt: string }): Promise<{ text: string }> }
  skill: { list(): Promise<{ data: ReadonlyArray<{ name: string; description?: string }> }> }
  session: { hook(name: 'prompt', callback: (e: { prompt: { text: string } }) => Promise<void> | void): Promise<unknown> }
}

export type Deps = { options?: string; store?: string }

// Options come from the user-level file only: a repository's own opencode.json can set plugin options.
export async function setup(ctx: Context, deps: Deps = {}): Promise<void> {
  // The host offers one model call with its own default model and no system field, so the instructions go first.
  const complete: Complete = async (req) => {
    const r = await ctx.generate.text({ prompt: `${req.system}\n\n${promptText(req.prompt)}` })
    return { isAnswered: r.text !== '', text: r.text }
  }

  await ctx.session.hook('prompt', async (e) => {
    try {
      const loaded = loadOptions('skill-pick', deps.options)
      const s: State = { ...parseConfig(loaded.error ? {} : loaded.options), listings: [], last: [], pending: null }
      if (s.mode === 'off') return
      const skills = (await ctx.skill.list()).data.map((k) => ({ name: k.name, description: (k.description ?? '').replace(/\s+/g, ' ').slice(0, 400) }))
      addListing(s, listing(skills))
      const engine = createEngine({ mod: 'skill-pick', cwd: ctx.location.directory, complete, notify: (t) => console.error(t), store: deps.store })
      const next = async (x: { text: string; context?: readonly string[] }) => ({ text: x.text, context: x.context })
      const r = (await choose(engine as never, s, { text: e.prompt.text, wait: false, origin: { kind: 'composer' } } as never, next as never)) as { context?: readonly string[] }
      if (r.context?.length) e.prompt.text = `${e.prompt.text}\n\n${r.context.join('\n')}`
    } catch {
      // advisory: any failure lets the prompt through
    }
  })
}

const plugin = { id: 'skill-pick', setup: (ctx: Context) => setup(ctx) }
export default plugin
export const server = plugin
