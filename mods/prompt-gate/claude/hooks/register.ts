import type { EngineInterface as Engine, PromptSubmitInput, PromptSubmitResult, Register } from 'claude-code'

import { buildPrompt, flagLine, jevBody, jevStep, JEV_MS, JEV_URL, lastRecords, LOG_KEY, LOG_MAX, parseConfig, parseJev, parseReply, RESEND_MS, settle, skipReason, SYSTEM, summary, USAGE, VOCAB_MAX, type Path, type Rec, type State, type Verdict } from './gate'
import { hashText } from './shared/hash'
import { pathAllowed } from './shared/paths'

type Next = (e: PromptSubmitInput) => Promise<PromptSubmitResult>

// Named in the first-use notice that the injected Jev client shows.
const JEV_NOTICE = { mod: 'prompt-gate', what: 'prompts', off: 'classifier=haiku' }

// @inject jev-client begin (generated from shared/jev-client.inject.ts; do not edit)
async function nowMs($: Engine): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

// The key is read once per session and only ever goes into the Authorization header.
function loadKey($: Engine, s: State): Promise<string | undefined> {
  s.key ??= (async () => {
    try {
      return (await $.env.get('TYPESAFE_API_KEY')) || undefined
    } catch {
      return undefined
    }
  })()
  return s.key
}

// The notice shows once per install (the store remembers it), and at most once per activation.
const NOTICE_KEY = 'jevNotice'
const announced = new WeakSet<State>()

// Fire and forget: the toast and the store write never block, delay or fail a prompt. JEV_NOTICE comes from the mod.
function announceJev($: Engine, s: State): void {
  if (announced.has(s)) return
  announced.add(s)
  void (async () => {
    try {
      let seen = false
      try {
        seen = (await $.store.get(NOTICE_KEY)) === true
      } catch {
        // unreadable: shown once for this activation
      }
      if (seen) return
      const scope = s.jevPaths.trim() || 'every directory'
      $.ui.toast(`${JEV_NOTICE.mod}: ${JEV_NOTICE.what} are sent to api.typesafe.ai (Jev) from ${scope}. Restrict with the jevPaths option, or set ${JEV_NOTICE.off}. See the README Privacy section.`, { timeoutMs: 15000 })
      await $.store.set(NOTICE_KEY, true)
    } catch {
      // a notice must never matter
    }
  })()
}

// Jev is a third party: only with a key and a working directory the path gate allows.
async function jevKey($: Engine, s: State): Promise<string | undefined> {
  try {
    if (s.jevPaths.trim()) {
      const home = await $.env.get('HOME')
      if (!pathAllowed(await $.session.cwd(), s.jevPaths, home)) return undefined
    }
  } catch {
    return undefined
  }
  const key = await loadKey($, s)
  if (key) announceJev($, s)
  return key
}

// Rejects on any failure and after JEV_MS.
async function postJev($: Engine, key: string, body: string): ReturnType<Engine['http']['fetch']> {
  const ac = new AbortController()
  try {
    const req = $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
    })
    req.catch(() => {}) // an abandoned request must not surface later
    const late = $.clock.sleep(JEV_MS, { signal: ac.signal }).then(() => {
      throw new Error('timeout')
    })
    late.catch(() => {}) // the losing side of the race must not surface later
    return await Promise.race([req, late])
  } finally {
    ac.abort()
  }
}

// A store call that hangs must not hold the records queued behind it, or a clear, forever.
const WRITE_MS = 5000

// Writes of one activation run one after another; a record from another session can still be lost.
let writes: Promise<void> = Promise.resolve()

// Past WRITE_MS a step is given up on (it may still land later) and the chain moves on.
function enqueue($: Engine, step: () => Promise<void>): Promise<void> {
  writes = writes.then(async () => {
    const ac = new AbortController()
    try {
      const work = step()
      work.catch(() => {})
      let late: Promise<void> = new Promise(() => {}) // no timer: unbounded, as before
      try {
        late = $.clock.sleep(WRITE_MS, { signal: ac.signal })
        late.catch(() => {})
      } catch {
        // no timer
      }
      await Promise.race([work, late])
    } catch {
      // the log is a measurement; losing a record must not touch the prompt
    } finally {
      ac.abort()
    }
  })
  return writes
}

function record($: Engine, rec: Rec): Promise<void> {
  return enqueue($, async () => {
    const old = await $.store.get(LOG_KEY)
    const log = Array.isArray(old) ? (old as Rec[]) : []
    await $.store.set(LOG_KEY, [...log, rec].slice(-LOG_MAX))
  })
}

function clearLog($: Engine): Promise<void> {
  return enqueue($, () => $.store.set(LOG_KEY, []))
}
// @inject jev-client end

function loadVocab($: Engine, s: State): Promise<string> {
  s.vocab ??= (async () => {
    if (!s.projectTerms) return ''
    try {
      s.vocabCwd = await $.session.cwd()
    } catch {
      // unknown origin: kept from Jev when jevPaths is set
    }
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      try {
        const r = await $.fs.read(name)
        if (typeof r === 'string' && r.trim()) return r.slice(0, VOCAB_MAX)
      } catch {
        // unreadable: try the next, else no vocabulary
      }
    }
    return ''
  })()
  return s.vocab
}

async function classify($: Engine, s: State, text: string): Promise<{ verdict: Verdict; ask: string; ms: number; input: number; output: number }> {
  const t0 = await nowMs($)
  let verdict: Verdict = 'error'
  let ask = ''
  let input = 0
  let output = 0
  try {
    const vocab = await loadVocab($, s)
    const prompt = buildPrompt(vocab, text)
    const r = await $.model.complete({ model: s.model, prompt, system: SYSTEM, maxTokens: 200, effort: 'low', timeoutMs: 8000 })
    input = r.usage?.input_tokens ?? 0
    output = r.usage?.output_tokens ?? 0
    if (r.isAnswered) {
      const p = parseReply(r.text)
      if (p) ({ verdict, ask } = p)
    }
  } catch {
    // fail open: counted as an error below
  }
  return { verdict, ask, ms: Math.max(0, (await nowMs($)) - t0), input, output }
}

type Jev = { p: number | null; input: number; output: number; ms: number }

// Jev is a third party: only with a key, a classifier that allows it, and a working directory the path gate allows.
async function jevAllowed($: Engine, s: State): Promise<string | undefined> {
  if (s.classifier === 'haiku') return undefined
  return jevKey($, s)
}

// The cached vocabulary may come from another directory: Jev gets it only when that one and the current one pass the path gate.
async function jevVocab($: Engine, s: State, vocab: string): Promise<string> {
  if (!vocab || !s.jevPaths.trim()) return vocab
  try {
    const home = await $.env.get('HOME')
    if (s.vocabCwd !== undefined && pathAllowed(s.vocabCwd, s.jevPaths, home) && pathAllowed(await $.session.cwd(), s.jevPaths, home)) return vocab
  } catch {
    // unreadable: treated as not allowed
  }
  return ''
}

// Any failure, timeout or unusable answer is p null: the caller falls back to Haiku alone.
async function askJev($: Engine, s: State, key: string, text: string): Promise<Jev> {
  const t0 = await nowMs($)
  let p: number | null = null
  let input = 0
  let output = 0
  try {
    const vocab = await jevVocab($, s, await loadVocab($, s))
    const r = await postJev($, key, jevBody(text, vocab))
    const j = parseJev(r.status, r.text)
    if (j) ({ p, input, output } = j)
  } catch {
    // unavailable for this prompt
  }
  return { p, input, output, ms: Math.max(0, (await nowMs($)) - t0) }
}

type Judged = { verdict: Verdict; ask: string; ms: number; input: number; output: number; path: Path; jev: number | null; jevIn: number; jevOut: number; jevMs: number; agree?: boolean }

// Dry runs Jev and Haiku side by side so both answers can be compared; the other modes skip Haiku when Jev settles it.
async function judge($: Engine, s: State, text: string): Promise<Judged> {
  const t0 = await nowMs($)
  const key = await jevAllowed($, s)
  const dry = s.mode === 'dry'
  const forced = s.classifier === 'jev'
  let j: Jev | null = null
  let h: Awaited<ReturnType<typeof classify>> | null = null
  if (key && dry) [j, h] = await Promise.all([askJev($, s, key, text), classify($, s, text)])
  else if (key) j = await askJev($, s, key, text)
  const step = j?.p == null ? 'haiku' : jevStep(j.p, forced)
  if (!h && step !== 'clear') h = await classify($, s, text)
  const f = settle(step, h ?? { verdict: 'error', ask: '' })
  const path: Path = !key ? 'haiku' : j?.p == null ? 'jev-fallback' : forced ? 'jev' : 'cascade'
  const out: Judged = {
    verdict: f.verdict, ask: f.ask, ms: Math.max(0, (await nowMs($)) - t0), input: h?.input ?? 0, output: h?.output ?? 0,
    path, jev: j?.p ?? null, jevIn: j?.input ?? 0, jevOut: j?.output ?? 0, jevMs: j?.ms ?? 0,
  }
  if (dry && j?.p != null && h && h.verdict !== 'error') out.agree = j.p >= 0.5 === (h.verdict === 'vague')
  return out
}

// Exported so a test can drive it with a hand-built `$`.
export async function gate($: Engine, s: State, e: PromptSubmitInput, next: Next): Promise<PromptSubmitResult> {
  if (skipReason(e, s)) return next(e)
  const hash = hashText(e.text.trim())
  const now = await nowMs($)
  for (const [h, t] of s.bounced) if (now - t >= RESEND_MS) s.bounced.delete(h)
  if (s.bounced.delete(hash)) return next(e)
  const done = (c: Judged, bounced: boolean, len = e.text.length): Rec => ({
    t: now, hash, len, verdict: c.verdict, ms: c.ms, input: c.input, output: c.output, mode: s.mode, bounced,
    path: c.path, jev: c.jev, jevIn: c.jevIn, jevOut: c.jevOut, jevMs: c.jevMs, ...(c.agree === undefined ? {} : { agree: c.agree }),
  })
  if (s.mode === 'dry') {
    const out = await next(e)
    if (out.drop === undefined) {
      const text = out.text
      // Measurement only: it runs after the prompt has gone on, and its errors are dropped.
      try {
        $.clock.after(0, async () => {
          try {
            await record($, done(await judge($, s, text), false, text.length))
          } catch {
            // the prompt is long gone
          }
        })
      } catch {
        // no timer: no measurement
      }
    }
    return out
  }
  const c = await judge($, s, e.text)
  if (s.mode === 'flag') {
    await record($, done(c, false))
    return c.verdict === 'vague' ? next({ ...e, context: [...(e.context ?? []), flagLine(c.ask)] }) : next(e)
  }
  const bounced = c.verdict === 'vague'
  await record($, done(c, bounced))
  if (!bounced) return next(e)
  s.bounced.set(hash, now)
  return { drop: `prompt-gate: ${c.ask || 'This prompt looks vague.'} Send it again unchanged to run it anyway.` }
}


export const register: Register = (on, options) => {
  const s: State = { ...parseConfig(options), vocab: null, bounced: new Map() }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompt-gate',
      description: 'Show prompt-gate counts and latency, the last records, or clear the log.',
      argumentHint: '[last|clear]',
    })
    return next(e)
  })

  on('command.run', { command: 'prompt-gate' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg !== '' && arg !== 'last' && arg !== 'clear') return { text: USAGE }
    if (arg === 'clear') {
      await clearLog($)
      return { text: 'prompt-gate: log cleared.' }
    }
    const old = await $.store.get(LOG_KEY)
    const log = Array.isArray(old) ? (old as Rec[]) : []
    return { text: arg === 'last' ? lastRecords(log) : summary(s, log) }
  }).catch(() => ({ text: 'prompt-gate: the command failed. Check the debug log.' }))

  // Advisory gate: any failure lets the prompt through.
  on('prompt.submit', ($, e, next) => gate($, s, e, next)).catch(($, e, next) => next(e))
}
