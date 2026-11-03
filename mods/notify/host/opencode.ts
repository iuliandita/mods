import { deliver, opencodeNotice, wanted, withContext, type Fs, type Runner } from '../claude/hooks/notify'
import { home, nodeFs, nodeRunner, readConfig } from './run'

// The parts of the OpenCode v2 plugin context this adapter uses, so the bundle needs no host package.
type Event = { type: string; data?: { sessionID?: string; parentID?: string; form?: { sessionID?: string }; status?: { type?: string } } }
type Context = {
  location: { directory: string }
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<Event> }
}

export type Deps = { run?: Runner; platform?: string; options?: string; fs?: Fs; home?: string | null; warn?: (s: string) => void }

// Reads the event stream until the plugin is cleaned up. Subagent sessions are those created with a parent; a
// session that already existed when the plugin loaded is not known, so its subagents are not told apart.
export async function setup(ctx: Context, deps: Deps = {}): Promise<() => void> {
  const run = deps.run ?? nodeRunner
  const platform = deps.platform ?? process.platform
  const warn = deps.warn ?? ((s: string) => console.error(s))
  const children = new Set<string>()
  const finished = new Set<string>()
  const stop = new AbortController()
  const said = new Set<string>()
  const say = (line: string): void => {
    if (!said.has(line)) {
      said.add(line)
      warn(line)
    }
  }

  const handle = async (e: Event): Promise<void> => {
    if (e.type === 'session.created' && e.data?.parentID && e.data.sessionID) {
      children.add(e.data.sessionID)
      return
    }
    const session = e.data?.sessionID ?? e.data?.form?.sessionID
    if (session && e.type === 'session.deleted') {
      children.delete(session)
      finished.delete(session)
      return
    }
    if (session && (e.type === 'session.execution.started' || (e.type === 'session.status' && e.data?.status?.type === 'busy'))) {
      finished.delete(session)
      return
    }
    if (session && children.has(session)) return
    const pending = opencodeNotice(e.type, ctx.location.directory)
    if (!pending) return
    // Both completion names can describe the same turn; a new execution resets it.
    if (pending.kind === 'finish') {
      if (!session || finished.has(session)) return
      finished.add(session)
    }
    // Read per event, so a change to the options file needs no restart.
    const { config, warning } = readConfig(deps.options)
    if (warning) say(warning)
    if (!wanted(config, pending)) return
    const notice = await withContext(pending, deps.home === undefined ? home() : deps.home, deps.fs ?? nodeFs)
    const result = await deliver(run, platform, notice, config.sound)
    if (!result.ok) say(result.warning)
  }

  void (async () => {
    try {
      for await (const e of ctx.event.subscribe({ signal: stop.signal })) await handle(e).catch(() => {})
    } catch {
      // the stream ended or was aborted: nothing left to notify about
    }
  })()
  return () => stop.abort()
}

const plugin = { id: 'notify', setup: (ctx: Context) => setup(ctx) }
export default plugin
export const server = plugin
