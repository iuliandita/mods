import { defaultMakeText, duration, money, ticker, toMs, tokens, type Data, type MakeText, type SessionInfo } from '../../../host-lib/tui'

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

// Control characters and line breaks in a title must not move the cursor or break the table.
const isControl = (c: number): boolean => c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
const clean = (s: string): string => [...s].map((ch) => (isControl(ch.codePointAt(0) ?? 0) ? ' ' : ch)).join('').replace(/ +/g, ' ').trim().slice(0, TITLE_MAX)

function state(s: SessionInfo, running: boolean): Row['state'] {
  if (running) return 'running'
  if (s.outcome === 'succeeded') return 'done'
  if (s.outcome === 'failed') return 'failed'
  if (s.outcome === 'interrupted') return 'stopped'
  return 'idle'
}

// The sessions below the one on screen: what OpenCode calls a child session is a subagent's run.
export function rows(data: Data, sessionID: string, now: number): Row[] {
  const out: Row[] = []
  for (const id of data.session.family(sessionID)) {
    if (id === sessionID) continue
    const s = data.session.get(id)
    if (!s) continue
    const running = data.session.status(id) === 'running'
    const created = toMs(s.time.created)
    const end = running ? now : (toMs(s.time.idle) ?? toMs(s.time.updated) ?? now)
    out.push({
      id,
      state: state(s, running),
      agent: clean(s.agent ?? 'agent'),
      title: clean(s.title ?? ''),
      cost: s.cost,
      tokens: s.tokens.input + s.tokens.output + s.tokens.cache.read,
      ms: created === undefined ? 0 : end - created,
    })
  }
  return out.slice(-MAX_ROWS)
}

const MARK: Record<Row['state'], string> = { running: '●', idle: '○', done: '✓', failed: '✗', stopped: '■' }

export function table(list: readonly Row[]): string {
  if (list.length === 0) return 'delegation-board: no subagents in this session yet.'
  const running = list.filter((r) => r.state === 'running').length
  const head = `delegation-board: ${list.length} subagent${list.length === 1 ? '' : 's'}, ${running} running, ${money(list.reduce((a, r) => a + r.cost, 0))}`
  const body = list.map((r) => `${MARK[r.state]} ${r.state.padEnd(7)} ${r.agent.padEnd(12).slice(0, 12)} ${duration(r.ms).padStart(6)} ${tokens(r.tokens).padStart(6)} ${money(r.cost).padStart(7)}  ${r.title}`)
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
      tick.add(() => void (node.content = draw()))
      return node
    },
  })
  return () => {
    release()
    tick.stop()
  }
}

export default { id: 'iuliandita.delegation-board', setup: (ctx: Ctx) => setup(ctx) }
