import { userInfo } from 'node:os'
import { resolve } from 'node:path'

import { checkCommand, checkTool } from './check'
import { loadConfig, nodeEnv } from './env'

// The parts of the OpenCode v2 plugin context this adapter uses, so the bundle needs no host package.
type ToolBefore = { tool: string; input: unknown }
type Context = {
  location: { directory: string }
  tool: { hook(name: 'execute.before', callback: (event: ToolBefore) => Promise<void> | void): Promise<unknown> }
}

const SHELL_TOOLS = new Set(['shell', 'bash'])

// Judged per call from the user-level options file, never from plugin options: a repository's own opencode.json
// can declare plugin options, and it must not be able to loosen what guards it.
export async function setup(ctx: Context, options = { config: undefined as string | undefined }): Promise<void> {
  await ctx.tool.hook('execute.before', async (event) => {
    if (!SHELL_TOOLS.has(event.tool.toLowerCase())) {
      // Any other tool (edit, write, patch, read) is only kept from the guard's own files.
      const result = checkTool(event.input, ctx.location.directory, process.env.HOME || userInfo().homedir)
      if (result.deny) throw new Error(result.deny)
      return
    }
    const input = event.input as { command?: unknown; workdir?: unknown } | null
    if (typeof input?.command !== 'string') throw new Error('guard-rules: a shell call without a command cannot be checked, so it was blocked (fail closed).')
    const cwd = typeof input.workdir === 'string' && input.workdir !== '' ? resolve(ctx.location.directory, input.workdir) : ctx.location.directory
    const result = await checkCommand(input.command, loadConfig(options.config), nodeEnv(cwd))
    if (result.notice) console.error(result.notice)
    if (result.deny) throw new Error(result.deny)
  })
}

const plugin = { id: 'guard-rules', setup: (ctx: Context) => setup(ctx) }
export default plugin
export const server = plugin
