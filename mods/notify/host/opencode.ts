import { deliver, finishReason, opencodeNotice, optedOut, wanted, withContext, type Env, type Fs, type Runner } from '../claude/hooks/notify'
import { home, nodeFs, nodeRunner, readConfig } from './run'
import { t3Child } from './session'

// The parts of the OpenCode v2 plugin context this adapter uses, so the bundle needs no host package.
type Event = { type: string; created?: number; data?: { sessionID?: string; parentID?: string; title?: string; form?: { sessionID?: string }; status?: { type?: string } } }
type Session = { parentID?: string; title?: string }
type Message = { type: string; time?: { created: number }; content?: { type: string; text?: string }[] }
const childInfo = (info: Session): boolean => Boolean(info.parentID) || (typeof info.title === 'string' && info.title.startsWith('T3 Code '))
type Context = {
  location: { directory: string }
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<Event> }
  session?: {
    get?(input: { sessionID: string }, options?: { signal: AbortSignal }): Promise<Session>
    context?(input: { sessionID: string }, options?: { signal: AbortSignal }): Promise<Message[]>
  }
}

export type Deps = { run?: Runner; platform?: string; options?: string; fs?: Fs; home?: string | null; env?: Env; warn?: (s: string) => void }

async function quick<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => read(abort.signal)).catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 150) }),
    ])
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}

// Reads the event stream until cleanup; optional host queries are bounded and always fail open.
export async function setup(ctx: Context, deps: Deps = {}): Promise<() => void> {
  const env = deps.env ?? process.env
  if (optedOut(env) || env.OPENCODE_SESSION_ID !== undefined) return () => {}
  const run = deps.run ?? nodeRunner
  const platform = deps.platform ?? process.platform
  const warn = deps.warn ?? ((s: string) => console.error(s))
  const children = new Set<string>()
  const finished = new Set<string>()
  const known = new Set<string>()
  const questions = new Set<string>()
  const started = new Map<string, number>()
  const stop = new AbortController()
  const said = new Set<string>()
  let stalled = false
  const say = (line: string): void => {
    if (!said.has(line)) {
      said.add(line)
      warn(line)
    }
  }

  const handle = async (e: Event): Promise<void> => {
    if (e.type === 'session.created' && e.data?.sessionID) {
      known.add(e.data.sessionID)
      if (childInfo(e.data)) children.add(e.data.sessionID)
      return
    }
    const session = e.data?.sessionID ?? e.data?.form?.sessionID
    if (session && e.type === 'session.deleted') {
      children.delete(session)
      finished.delete(session)
      known.delete(session)
      questions.delete(session)
      started.delete(session)
      return
    }
    if (session && (e.type === 'session.execution.started' || (e.type === 'session.status' && e.data?.status?.type === 'busy'))) {
      finished.delete(session)
      if (e.type === 'session.execution.started' || !started.has(session)) started.set(session, e.created ?? Date.now())
      questions.delete(session)
      return
    }
    if (session && (e.type === 'session.execution.failed' || e.type === 'session.execution.interrupted')) {
      started.delete(session)
      questions.delete(session)
      return
    }
    if (session && ['form.replied', 'form.cancelled', 'question.replied', 'question.rejected'].includes(e.type)) {
      questions.delete(session)
      return
    }
    const pending = opencodeNotice(e.type, ctx.location.directory)
    // A notifier that hung once would hold the event loop for the full timeout on every later event.
    if (!pending || stalled) return
    // Read per event, so a change to the options file needs no restart.
    const { config, warning } = readConfig(deps.options)
    if (warning) say(warning)
    if (!wanted(config, pending)) return
    if (session && !known.has(session) && ctx.session?.get) {
      const info = await quick((signal) => ctx.session!.get!({ sessionID: session }, { signal }))
      if (info) {
        known.add(session)
        if (childInfo(info)) children.add(session)
      }
    }
    if (session && (children.has(session) || await t3Child(session, config, env, deps.home === undefined ? home() : deps.home))) return
    if (session && questions.has(session)) return
    // Both completion names can describe the same turn; a new execution resets it.
    if (pending.kind === 'finish') {
      if (!session || finished.has(session)) return
      finished.add(session)
      const since = started.get(session)
      if (config.state && since !== undefined && ctx.session?.context) {
        const messages = await quick((signal) => ctx.session!.context!({ sessionID: session }, { signal }))
        const last = Array.isArray(messages) ? messages.findLast((m) => m?.type === 'assistant' || m?.type === 'user') : undefined
        if (last?.type === 'assistant' && typeof last.time?.created === 'number' && last.time.created >= since && Array.isArray(last.content)) {
          pending.reason = finishReason(last.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join(''))
        }
      }
      started.delete(session)
    } else if (session && (e.type === 'form.created' || e.type === 'question.asked')) {
      questions.add(session)
    }
    const notice = await withContext(pending, deps.home === undefined ? home() : deps.home, deps.fs ?? nodeFs)
    const result = await deliver(run, platform, notice, config.sound)
    if (!result.ok) say(result.warning)
    if (!result.ok && result.timedOut) stalled = true
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
