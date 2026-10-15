// Shared by the OpenCode terminal UI plugins (statusline, delegation-board). The modules @opentui/core and
// @opencode/plugin/tui come from the host at run time, so they are loaded only when a plugin starts.

// A text node the plugin can redraw by setting `content`.
export type TextNode = { content: string }
export type MakeText = (content: string) => TextNode

export async function defaultMakeText(renderer: unknown): Promise<MakeText> {
  const { TextRenderable } = await import('@opentui/core')
  return (content) => new TextRenderable(renderer, { content }) as unknown as TextNode
}

// Session fields both plugins read; the host's own shape is wider.
export type SessionInfo = {
  id: string
  parentID?: string
  title?: string
  agent?: string
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  outcome?: string
  time: { created: unknown; updated?: unknown; idle?: unknown }
  model?: { id?: string }
}

export type Data = {
  session: {
    get(id: string): SessionInfo | undefined
    family(id: string): string[]
    status(id: string): 'idle' | 'running'
    sync(id: string): Promise<void>
  }
  location: { vcs: { info(): { branch?: { current?: string } } | undefined; sync(): Promise<void> } }
}

// The host serializes times as numbers, dates or strings depending on where it read them.
export function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  if (v !== null && typeof v === 'object') {
    const e = (v as { epochMillis?: unknown; epochMilliseconds?: unknown }).epochMillis ?? (v as { epochMilliseconds?: unknown }).epochMilliseconds
    if (typeof e === 'number') return e
  }
  return undefined
}

export function duration(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '<1m'
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export const tokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export const money = (n: number): string => `$${n.toFixed(2)}`

// Redraws a set of nodes on a timer. The returned stop function ends it.
export function ticker(everyMs: number): { add(redraw: () => void): () => void; stop(): void } {
  const jobs = new Set<() => void>()
  const timer = setInterval(() => {
    for (const job of jobs) {
      try {
        job()
      } catch {
        jobs.delete(job)
      }
    }
  }, everyMs)
  timer.unref?.()
  return { add: (job) => (jobs.add(job), () => void jobs.delete(job)), stop: () => clearInterval(timer) }
}
