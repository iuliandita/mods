// Shared by the OpenCode terminal UI plugins (statusline, delegation-board). The modules @opentui/core and
// @opencode/plugin/tui come from the host at run time, so they are loaded only when a plugin starts.

// A text node the plugin can redraw by setting `content`.
export type TextNode = { content: string; isDestroyed?: boolean }
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
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
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

// Control, format and bidirectional-override characters, tag characters and the like: nothing a host-supplied name may
// carry into the terminal.
const isControl = (c: number): boolean =>
  c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x61c || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff || (c >= 0xe0000 && c <= 0xe007f)

// A host-supplied string made safe to draw: control characters become spaces, runs of spaces collapse, and the cut is on
// code points.
export const clean = (s: string, max: number): string =>
  [...[...s].map((ch) => (isControl(ch.codePointAt(0) ?? 0) ? ' ' : ch)).join('').replace(/ +/g, ' ').trim()].slice(0, max).join('')

const MAX_JOBS = 32

// Redraws nodes on a timer. A job returns false when its node is gone, and is then dropped; one that throws is logged
// once and dropped; past MAX_JOBS the oldest goes. The returned stop function ends the timer.
export function ticker(everyMs: number): { add(redraw: () => boolean | void): () => void; stop(): void } {
  const jobs = new Set<() => boolean | void>()
  const timer = setInterval(() => {
    for (const job of [...jobs]) {
      try {
        if (job() === false) jobs.delete(job)
      } catch (e) {
        console.error(`terminal plugin: a redraw failed and was stopped (${e instanceof Error ? e.message : String(e)})`)
        jobs.delete(job)
      }
    }
  }, everyMs)
  timer.unref?.()
  return {
    add: (job) => {
      jobs.add(job)
      if (jobs.size > MAX_JOBS) jobs.delete(jobs.values().next().value as () => boolean | void)
      return () => void jobs.delete(job)
    },
    stop: () => clearInterval(timer),
  }
}

// Sets `node.content` from `draw` every tick, until the host destroys the node.
export function bind(tick: ReturnType<typeof ticker>, node: TextNode, draw: () => string): void {
  tick.add(() => {
    if (node.isDestroyed === true) return false
    node.content = draw()
  })
}
