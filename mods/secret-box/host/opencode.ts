import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadOptions } from '../../../host-lib/options'
import { createBox, helperExists, helperMissing, parseMode, placeholderNames, rewrite, scrubValue, type Mode } from './core'

// The parts of the OpenCode v2 plugin context this adapter uses, so the bundle needs no host package.
type ToolBefore = { tool: string; id: string; input: unknown }
type ToolAfter = { tool: string; id: string; status: 'completed' | 'error'; result?: unknown; error?: unknown }
type Context = {
  tool: {
    hook(name: 'execute.before', callback: (e: ToolBefore) => Promise<void> | void): Promise<unknown>
    hook(name: 'execute.after', callback: (e: ToolAfter) => Promise<void> | void): Promise<unknown>
  }
  session: {
    hook(name: 'context', callback: (e: { messages: unknown }) => Promise<void> | void): Promise<unknown>
    hook(name: 'prompt', callback: (e: { prompt: unknown }) => Promise<void> | void): Promise<unknown>
  }
}

const SHELL_TOOLS = new Set(['shell', 'bash'])
const WITHHELD = '[secret-box: this content was withheld because scrubbing failed]'

export type Deps = { helper: string; options?: string }

// Everything is read from the user-level options file per call, never from plugin options: a repository's own
// opencode.json can declare plugin options, and it must not be able to switch the box off.
export async function setup(ctx: Context, deps: Deps): Promise<void> {
  const box = createBox(deps.helper)
  const mode = (): Mode => {
    const loaded = loadOptions('secret-box', deps.options)
    return loaded.error ? 'on' : parseMode(loaded.options.mode)
  }
  const reload = new Set<string>()

  await ctx.tool.hook('execute.before', async (e) => {
    if (!SHELL_TOOLS.has(e.tool.toLowerCase()) || mode() === 'off') return
    const input = e.input as { command?: unknown } | null
    if (typeof input?.command !== 'string') return
    const names = placeholderNames(input.command)
    if (names.length === 0) return
    if (mode() === 'dry') {
      console.error(`secret-box (dry run): would resolve ${names.join(', ')} at execution time`)
      return
    }
    if (!helperExists(deps.helper)) throw new Error(helperMissing(deps.helper))
    input.command = rewrite(deps.helper, input.command)
    reload.add(e.id)
  })

  await ctx.tool.hook('execute.after', async (e) => {
    if (mode() !== 'on') return
    if (reload.delete(e.id)) await box.load()
    const scrub = await box.scrubber()
    if (!scrub) return
    // A failed or aborted call can carry partial output in `result` next to its `error`.
    for (const key of ['result', 'error'] as const) {
      if (e[key] === undefined) continue
      try {
        const r = scrubValue(e[key], scrub)
        if (r.changed) e[key] = r.value
      } catch {
        e[key] = WITHHELD
      }
    }
  })

  // Every row the model sees again, and the prompt as typed.
  await ctx.session.hook('context', async (e) => {
    if (mode() !== 'on') return
    const scrub = await box.scrubber()
    if (!scrub) return
    const r = scrubValue(e.messages, scrub)
    if (r.changed) e.messages = r.value
  })
  await ctx.session.hook('prompt', async (e) => {
    if (mode() !== 'on') return
    const scrub = await box.scrubber()
    if (!scrub) return
    const r = scrubValue(e.prompt, scrub)
    if (r.changed) e.prompt = r.value
  })
}

// The Python helper sits in bin/ next to this bundle.
const helper = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'secret-box')
const plugin = { id: 'secret-box', setup: (ctx: Context) => setup(ctx, { helper }) }
export default plugin
export const server = plugin
