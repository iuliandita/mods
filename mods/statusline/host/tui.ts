import { defaultMakeText, duration, money, ticker, toMs, tokens, type Data, type MakeText } from '../../../host-lib/tui'

type Ctx = {
  renderer: unknown
  location?: { directory: string }
  data: Data
  ui: {
    model: { current(): { modelID: string } | undefined }
    slot(claim: { append: 'session.composer.top'; render: (input: { readonly sessionID: string }) => unknown }): () => void
  }
}

const base = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? p

// One line above the prompt: model, folder, branch, context tokens, cost, and how long the session has run. Only what
// OpenCode exposes to a plugin; there are no rate-limit figures.
export function line(ctx: Ctx, sessionID: string, now: number): string {
  const s = ctx.data.session.get(sessionID)
  const parts: string[] = []
  const model = s?.model?.id ?? ctx.ui.model.current()?.modelID
  if (model) parts.push(`◆ ${model}`)
  const dir = ctx.location?.directory
  if (dir) parts.push(base(dir))
  const branch = ctx.data.location.vcs.info()?.branch?.current
  if (branch) parts.push(`⎇ ${branch}`)
  if (s) {
    const ctxTokens = s.tokens.input + s.tokens.cache.read
    if (ctxTokens > 0) parts.push(`ctx ${tokens(ctxTokens)}`)
    parts.push(money(s.cost))
    const created = toMs(s.time.created)
    if (created !== undefined) parts.push(duration(now - created))
  }
  if (ctx.data.session.status(sessionID) === 'running') parts.push('●')
  return parts.join('  ')
}

export async function setup(ctx: Ctx, makeText?: MakeText): Promise<() => void> {
  const make = makeText ?? (await defaultMakeText(ctx.renderer))
  const tick = ticker(1000)
  void ctx.data.location.vcs.sync().catch(() => {})
  const release = ctx.ui.slot({
    append: 'session.composer.top',
    render: (input) => {
      const draw = (): string => line(ctx, input.sessionID, Date.now())
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

export default { id: 'iuliandita.statusline', setup: (ctx: Ctx) => setup(ctx) }
