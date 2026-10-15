import { createEngine, promptText, type Complete } from '../../../host-lib/engine'
import { loadOptions } from '../../../host-lib/options'
import { parseConfig, type State } from '../claude/hooks/gate'
import { gate } from '../claude/hooks/register'

// The parts of the OpenCode v2 plugin context this adapter uses, so the bundle needs no host package.
type Context = {
  location: { directory: string }
  generate: { text(input: { prompt: string }): Promise<{ text: string }> }
  session: { hook(name: 'prompt', callback: (e: { prompt: { text: string } }) => Promise<void> | void): Promise<unknown> }
}

export type Deps = { options?: string; store?: string }

class Blocked extends Error {}

// Options come from the user-level file only: a repository's own opencode.json can set plugin options.
// Mode `on` runs as `flag` here: a hook can only stop a prompt by throwing, and OpenCode then shows a bare "500"
// without the question (and its terminal UI sends the prompt again), so the model is given the question instead.
export async function setup(ctx: Context, deps: Deps = {}): Promise<void> {
  const s: State = { ...parseConfig({}), vocab: null, bounced: new Map() }
  // The host offers one model call with its own default model and no system field, so the instructions go first.
  const complete: Complete = async (req) => {
    const r = await ctx.generate.text({ prompt: `${req.system}\n\n${promptText(req.prompt)}` })
    return { isAnswered: r.text !== '', text: r.text }
  }

  await ctx.session.hook('prompt', async (e) => {
    try {
      const loaded = loadOptions('prompt-gate', deps.options)
      Object.assign(s, parseConfig(loaded.error ? {} : loaded.options))
      if (s.mode === 'off') return
      const run: State = s.mode === 'on' ? { ...s, mode: 'flag' } : s
      const engine = createEngine({ mod: 'prompt-gate', cwd: ctx.location.directory, complete, notify: (t) => console.error(t), store: deps.store })
      const next = async (x: { text: string; context?: readonly string[] }) => ({ text: x.text, context: x.context })
      const r = (await gate(engine as never, run, { text: e.prompt.text, wait: false, origin: { kind: 'composer' } } as never, next as never)) as { context?: readonly string[] }
      if (r.context?.length) e.prompt.text = `${e.prompt.text}\n\n${r.context.join('\n')}`
    } catch {
      // advisory: any failure lets the prompt through
    }
  })
}

const plugin = { id: 'prompt-gate', setup: (ctx: Context) => setup(ctx) }
export default plugin
export const server = plugin
