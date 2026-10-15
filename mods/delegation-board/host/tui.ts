import { bind, clean, defaultMakeText, duration, money, ticker, toMs, tokens, type Data, type MakeText, type SessionInfo } from '../../../host-lib/tui'

const PANEL = 'iuliandita.delegation-board'
const MAX_ROWS = 40
const TITLE_MAX = 60

type Ctx = {
  renderer: unknown
  data: Data
  keymap: { layer(factory: () => { mode: 'global'; commands: readonly { id: string; title: string; palette: true; slash: { name: string }; run: () => void }[] }): void }
  ui: {
    panel: { open(name: string): boolean; close(): void; current(): { name: string } | undefined }
    slot(claim: { append: 'session.panel'; render: (input: { readonly name: string; readonly sessionID: string }) => unknown }): () => void
  }
}

export type Row = { id: string; state: 'running' | 'idle' | 'done' | 'failed' | 'stopped'; agent: string; title: string; cost: number; tokens: number; ms: number }

function state(s: SessionInfo, running: boolean): Row['state'] {
  if (running) return 'running'
  if (s.outcome === 'succeeded') return 'done'
  if (s.outcome === 'failed') return 'failed'
  if (s.outcome === 'interrupted') return 'stopped'
  return 'idle'
}

// Whether `id` sits below `root` in the session tree: what OpenCode calls a child session is a subagent's run.
function below(data: Data, id: string, root: string): boolean {
  let cur = data.session.get(id)?.parentID
  for (let depth = 0; cur !== undefined && depth < 20; depth++) {
    if (cur === root) return true
    cur = data.session.get(cur)?.parentID
  }
  return false
}

export function rows(data: Data, sessionID: string, now: number): Row[] {
  const out: Row[] = []
  for (const id of data.session.family(sessionID)) {
    if (id === sessionID || !below(data, id, sessionID)) continue
    const s = data.session.get(id)
    if (!s) continue
    const running = data.session.status(id) === 'running'
    const created = toMs(s.time?.created)
    const stopped = toMs(s.time?.idle) ?? toMs(s.time?.updated)
    const end = running ? now : stopped
    out.push({
      id,
      state: state(s, running),
      agent: clean(s.agent ?? 'agent', 12),
      title: clean(s.title ?? '', TITLE_MAX),
      cost: s.cost ?? 0,
      tokens: (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0) + (s.tokens?.cache?.read ?? 0),
      ms: created === undefined || end === undefined ? 0 : end - created,
    })
  }
  return out
}

const MARK: Record<Row['state'], string> = { running: '●', idle: '○', done: '✓', failed: '✗', stopped: '■' }

export function table(all: readonly Row[]): string {
  if (all.length === 0) return 'delegation-board: no subagents in this session yet.'
  const list = all.slice(-MAX_ROWS)
  const running = all.filter((r) => r.state === 'running').length
  const hidden = all.length - list.length
  const head = `delegation-board: ${all.length} subagent${all.length === 1 ? '' : 's'}, ${running} running, ${money(all.reduce((a, r) => a + r.cost, 0))}${hidden ? ` (${hidden} older not shown)` : ''}`
  const body = list.map((r) => `${MARK[r.state]} ${r.state.padEnd(7)} ${r.agent.padEnd(12)} ${duration(r.ms).padStart(6)} ${tokens(r.tokens).padStart(6)} ${money(r.cost).padStart(7)}  ${r.title}`)
  return [head, ...body].join('\n')
}

export async function setup(ctx: Ctx, makeText?: MakeText): Promise<() => void> {
  // The layer is made before the first await: the host ties it to the plugin's setup call.
  ctx.keymap.layer(() => ({
    mode: 'global',
    commands: [
      {
        id: `${PANEL}.toggle`,
        title: 'Delegation board',
        palette: true,
        slash: { name: 'board' },
        run: () => (ctx.ui.panel.current()?.name === PANEL ? ctx.ui.panel.close() : void ctx.ui.panel.open(PANEL)),
      },
    ],
  }))
  const make = makeText ?? (await defaultMakeText(ctx.renderer))
  const tick = ticker(1000)
  const release = ctx.ui.slot({
    append: 'session.panel',
    render: (input) => {
      if (input.name !== PANEL) return make('')
      const draw = (): string => table(rows(ctx.data, input.sessionID, Date.now()))
      const node = make(draw())
      void ctx.data.session.sync(input.sessionID).catch(() => {})
      bind(tick, node, draw)
      return node
    },
  })
  return () => {
    release()
    tick.stop()
  }
}

export default { id: 'iuliandita.delegation-board', setup: (ctx: Ctx) => setup(ctx) }
