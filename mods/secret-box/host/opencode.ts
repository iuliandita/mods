import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadOptions } from '../../../host-lib/options'
import { scopeDenied } from '../claude/hooks/scopes'
import { helperExists, helperMissing, parseMode, placeholderNames, rewrite, scrubRemote, type Mode } from './core'

// The parts of the OpenCode v2 plugin context this adapter uses, so the bundle needs no host package.
type ToolBefore = { tool: string; id: string; input: unknown }
type ToolAfter = { tool: string; id: string; status: 'completed' | 'error'; result?: unknown; error?: unknown }
type RequestHook = 'context' | 'compaction' | 'generate' | 'title'
type ModelRequest = { messages: unknown; system?: unknown }
type Context = {
  location: { directory: string }
  tool: {
    hook(name: 'execute.before', callback: (e: ToolBefore) => Promise<void> | void): Promise<unknown>
    hook(name: 'execute.after', callback: (e: ToolAfter) => Promise<void> | void): Promise<unknown>
  }
  session: {
    hook(name: RequestHook, callback: (e: ModelRequest) => Promise<void> | void): Promise<unknown>
    hook(name: 'prompt', callback: (e: { prompt: unknown }) => Promise<void> | void): Promise<unknown>
  }
}

const SHELL_TOOLS = new Set(['shell', 'bash'])

export type Deps = { helper: string; options?: string }

// Everything is read from the user-level options file per call, never from plugin options: a repository's own
// opencode.json can declare plugin options, and it must not be able to switch the box off.
export async function setup(ctx: Context, deps: Deps): Promise<void> {
  const mode = (): Mode => {
    const loaded = loadOptions('secret-box', deps.options)
    return loaded.error ? 'on' : parseMode(loaded.options.mode)
  }

  await ctx.tool.hook('execute.before', async (e) => {
    if (!SHELL_TOOLS.has(e.tool.toLowerCase()) || mode() === 'off') return
    const input = e.input as { command?: unknown; workdir?: unknown } | null
    if (typeof input?.command !== 'string') return
    const names = placeholderNames(input.command)
    if (names.length === 0) return
    const loaded = loadOptions('secret-box', deps.options)
    const cwd = typeof input.workdir === 'string' && input.workdir !== '' ? resolve(ctx.location.directory, input.workdir) : ctx.location.directory
    const scope = loaded.error
      ? 'secret-box: error: secretScopes could not be read: the options file is invalid; fix secret-box.json'
      : scopeDenied(loaded.options.secretScopes, names, cwd)
    if (mode() === 'dry') {
      console.error(scope ?? `secret-box (dry run): would resolve ${names.join(', ')} at execution time`)
      return
    }
    if (scope) throw new Error(scope)
    if (!helperExists(deps.helper)) throw new Error(helperMissing(deps.helper))
    input.command = rewrite(deps.helper, input.command)
  })

  await ctx.tool.hook('execute.after', async (e) => {
    if (mode() !== 'on') return
    // A failed or aborted call can carry partial output in `result` next to its `error`.
    if (e.result !== undefined) e.result = await scrubRemote(deps.helper, e.result, 'result')
    if (e.error !== undefined) e.error = await scrubRemote(deps.helper, e.error, 'error')
  })

  // OpenCode 2.2.1 routes each kind of model request through its own hook.
  const scrubRequest = async (e: ModelRequest) => {
    if (mode() !== 'on') return
    e.messages = await scrubRemote(deps.helper, e.messages, 'messages')
    if (e.system !== undefined) e.system = await scrubRemote(deps.helper, e.system, 'system')
  }
  for (const name of ['context', 'compaction', 'generate', 'title'] as const) {
    await ctx.session.hook(name, scrubRequest)
  }
  await ctx.session.hook('prompt', async (e) => {
    if (mode() !== 'on') return
    e.prompt = await scrubRemote(deps.helper, e.prompt, 'prompt')
  })
}

// The Python helper sits in bin/ next to this bundle.
const helper = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'secret-box')
const plugin = { id: 'secret-box', setup: (ctx: Context) => setup(ctx, { helper }) }
export default plugin
export const server = plugin
