import { createEngine, pathLimited, type Complete } from '../../../host-lib/engine'
import { openCodeComplete, type ModelContext } from '../../../host-lib/opencode-model'
import { loadOptions } from '../../../host-lib/options'
import { parseConfig, type State } from '../claude/hooks/gate'
import { gate } from '../claude/hooks/register'

// The parts of the OpenCode v2 plugin context this adapter uses, so the bundle needs no host package.
type Context = ModelContext & {
  location: { directory: string }
  session: { hook(name: 'prompt', callback: (e: { prompt: { text: string } }) => Promise<void> | void): Promise<unknown> }
}

export type Deps = { options?: string; store?: string }

// Options come from the user-level file only: a repository's own opencode.json can set plugin options.
// Mode `on` runs as `flag` here: a hook can only stop a prompt by throwing, and OpenCode then shows a bare "500"
// without the question (and its terminal UI sends the prompt again), so the model is given the question instead.
export async function setup(ctx: Context, deps: Deps = {}): Promise<void> {
  const s: State = { ...parseConfig({}), vocab: null, bounced: new Map() }
  // Options are read on each prompt, so the model option is looked up lazily.
  let model = ''
  const complete: Complete = openCodeComplete(ctx, () => model)

  await ctx.session.hook('prompt', async (e) => {
    try {
      const loaded = loadOptions('prompt-gate', deps.options)
      Object.assign(s, parseConfig(loaded.error ? {} : loaded.options))
      if (s.mode === 'off') return
      model = s.model
      const engine = createEngine({ mod: 'prompt-gate', cwd: ctx.location.directory, complete: pathLimited(complete, s.jevPaths, ctx.location.directory), notify: (t) => console.error(t), store: deps.store })
      const next = async (x: { text: string; context?: readonly string[] }) => ({ text: x.text, context: x.context })
      const configured = s.mode
      if (s.mode === 'on') s.mode = 'flag'
      let r: { context?: readonly string[] }
      try {
        r = (await gate(engine as never, s, { text: e.prompt.text, wait: false, origin: { kind: 'composer' } } as never, next as never)) as { context?: readonly string[] }
      } finally {
        s.mode = configured
      }
      if (r.context?.length) e.prompt.text = `${e.prompt.text}\n\n${r.context.join('\n')}`
    } catch {
      // advisory: any failure lets the prompt through
    }
  })
}

const plugin = { id: 'prompt-gate', setup: (ctx: Context) => setup(ctx) }
export default plugin
export const server = plugin
