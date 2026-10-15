import { promptText, type Complete } from './engine'

export type ModelInfo = { id: string; providerID: string; variants?: readonly { id: string }[] }
export type ModelRef = { id: string; providerID: string; variant?: string }

export type ModelContext = {
  generate: { text(input: { prompt: string; model?: ModelRef }): Promise<{ text: string }> }
  model: { list(): Promise<{ data: ReadonlyArray<ModelInfo> }>; default(): Promise<{ data?: ModelInfo | undefined }> }
}

// "provider/model" names a model outright.
export function parseRef(option: string): ModelRef | undefined {
  const i = option.indexOf('/')
  return i > 0 && i < option.length - 1 ? { providerID: option.slice(0, i), id: option.slice(i + 1) } : undefined
}

const LOW = ['low', 'minimal']
const TRIES = 3
const DEADLINE_MS = 20_000

const key = (m: ModelRef): string => `${m.providerID}/${m.id}`

// DeepSeek Flash models at low effort, best first: the session's default provider, then the others in the host's order,
// the free tier last. Preview, vision and "latest" alias entries are left out.
export function flashCandidates(models: readonly ModelInfo[], preferProvider?: string): ModelRef[] {
  const rank = (m: ModelInfo): number => (m.providerID === preferProvider ? 0 : /-free$/.test(m.id) ? 2 : 1)
  return models
    .filter((m) => /deepseek/i.test(m.id) && /flash/i.test(m.id) && !/vision|exp|latest|~/i.test(m.id))
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => {
      const variant = LOW.find((v) => m.variants?.some((x) => x.id === v))
      return { id: m.id, providerID: m.providerID, ...(variant ? { variant } : {}) }
    })
}

export const pickFlash = (models: readonly ModelInfo[], preferProvider?: string): ModelRef | undefined => flashCandidates(models, preferProvider)[0]

// The model call for OpenCode: the host's `generate.text` with a DeepSeek Flash model at low effort. A provider that
// refuses (no funds, say) is skipped and the next candidate tried; the one that answers is kept. With none listed the
// session's default model answers (the host cannot cap its output, so that is the fallback only).
export function openCodeComplete(ctx: ModelContext, option: () => string): Complete {
  let candidates: Promise<ModelRef[]> | undefined
  const bad = new Set<string>()
  let good: ModelRef | undefined
  const list = (): Promise<ModelRef[]> =>
    (candidates ??= (async () => {
      try {
        const explicit = parseRef(option())
        if (explicit) return [explicit]
        const [models, def] = await Promise.all([ctx.model.list(), ctx.model.default().catch(() => ({ data: undefined }))])
        return flashCandidates(models.data, def.data?.providerID)
      } catch {
        return []
      }
    })())
  const attempt: Complete = async (req) => {
    const prompt = `${req.system}\n\n${promptText(req.prompt)}`
    const tries = good ? [good] : (await list()).filter((m) => !bad.has(key(m))).slice(0, TRIES)
    let last: unknown
    for (const model of tries.length ? tries : [undefined]) {
      try {
        const r = await ctx.generate.text({ prompt, ...(model ? { model } : {}) })
        if (model) good = model
        return { isAnswered: r.text !== '', text: r.text }
      } catch (e) {
        last = e
        if (model) {
          bad.add(key(model))
          if (good && key(good) === key(model)) good = undefined
        }
      }
    }
    throw last
  }
  // The host cannot cancel a request, so past the deadline the answer is simply given up on.
  return (req) =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('the model did not answer in time')), DEADLINE_MS)
      attempt(req).then(
        (r) => (clearTimeout(timer), done(r)),
        (e) => (clearTimeout(timer), fail(e)),
      )
    })
}
