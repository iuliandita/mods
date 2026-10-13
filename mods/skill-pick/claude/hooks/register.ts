import type { EngineInterface as Engine, PromptSubmitInput, PromptSubmitResult, Register } from 'claude-code'

import { addListing, bareName, buildPrompt, catalog, contextLine, entriesOf, JEV_MS, JEV_URL, jevBody, jevEntries, jevNames, jevSaysNone, lastRecords, LOG_KEY, LOG_MAX, mergeNames, parseConfig, parseJev, parseReply, skipReason, SYSTEM, summary, USAGE, type JevEntry, type JevScores, type Path, type PickRec, type Rec, type State, type Status } from './pick'
import { hashText } from './shared/hash'
import { pathAllowed } from './shared/paths'

// Longer than Jev (6 s) plus the small model (8 s).
const PENDING_MS = 20000

type Next = (e: PromptSubmitInput) => Promise<PromptSubmitResult>

// Named in the first-use notice that the injected Jev client shows.
const JEV_NOTICE = { mod: 'skill-pick', what: 'prompts and skill descriptions', off: 'picker=haiku' }

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

type Picked = { status: Status; names: string[]; ms: number; input: number; output: number; cacheRead: number; cacheWrite: number }

async function pick($: Engine, s: State, text: string): Promise<Picked> {
  const t0 = await nowMs($)
  const out: Picked = { status: 'error', names: [], ms: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  try {
    const cat = catalog(s)
    const r = await $.model.complete({ model: s.model, prompt: buildPrompt(cat, text), system: SYSTEM(s.maxSkills), maxTokens: 200, effort: 'low', timeoutMs: 8000 })
    out.input = r.usage?.input_tokens ?? 0
    out.output = r.usage?.output_tokens ?? 0
    out.cacheRead = r.usage?.cache_read_input_tokens ?? 0
    out.cacheWrite = r.usage?.cache_creation_input_tokens ?? 0
    if (r.isAnswered) {
      const names = parseReply(r.text, cat, s.maxSkills)
      if (names) {
        out.names = names
        out.status = names.length ? 'ok' : 'none'
      }
    }
  } catch {
    // fail open: counted as an error below
  }
  out.ms = Math.max(0, (await nowMs($)) - t0)
  return out
}

// Jev is a third party: only with a key, a picker that allows it, a working directory the path gate allows and 2 or more entries.
async function jevAllowed($: Engine, s: State, entries: JevEntry[]): Promise<string | undefined> {
  if (s.picker === 'haiku' || entries.length < 2) return undefined
  return jevKey($, s)
}

type Jev = { scores: JevScores | null; ms: number }

// Any failure, timeout or unusable answer is null scores: the caller falls back to Haiku alone.
async function askJev($: Engine, key: string, text: string, entries: JevEntry[]): Promise<Jev> {
  const t0 = await nowMs($)
  let scores: JevScores | null = null
  try {
    const r = await postJev($, key, jevBody(text, entries))
    scores = parseJev(r.status, r.text, entries)
  } catch {
    // unavailable for this prompt
  }
  return { scores, ms: Math.max(0, (await nowMs($)) - t0) }
}

type Judged = Picked & { path: Path; jevIn: number; jevOut: number; jevMs: number; jevNames?: string[]; haikuNames?: string[]; agree?: boolean }

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x))

// Dry runs Jev and Haiku side by side so both answers can be compared; the other modes skip Haiku when Jev settles it.
async function judge($: Engine, s: State, text: string): Promise<Judged> {
  const t0 = await nowMs($)
  const entries = jevEntries(catalog(s))
  const key = await jevAllowed($, s, entries)
  const dry = s.mode === 'dry'
  // Entries Jev was not sent (past the cap, or digit-only names): its "none" says nothing about them.
  const partial = entriesOf(catalog(s)).size > entries.length
  let j: Jev | null = null
  let h: Picked | null = null
  if (key && dry) [j, h] = await Promise.all([askJev($, key, text, entries), pick($, s, text)])
  else if (key) j = await askJev($, key, text, entries)
  const sc = j?.scores ?? null
  if (!h && (!sc || (s.picker !== 'jev' && (partial || !jevSaysNone(sc))))) h = await pick($, s, text)
  const out: Judged = {
    status: 'error', names: [], ms: 0, input: h?.input ?? 0, output: h?.output ?? 0, cacheRead: h?.cacheRead ?? 0, cacheWrite: h?.cacheWrite ?? 0,
    path: !key ? 'haiku' : !sc ? 'jev-fallback' : s.picker === 'jev' ? 'jev' : 'cascade', jevIn: sc?.input ?? 0, jevOut: sc?.output ?? 0, jevMs: j?.ms ?? 0,
  }
  if (!sc) {
    if (h) ({ status: out.status, names: out.names } = h)
  } else {
    const nothing = jevSaysNone(sc) && !(partial && s.picker !== 'jev')
    const jn = nothing ? [] : jevNames(sc, s.maxSkills)
    const hDone = h !== null && h.status !== 'error' ? h : null
    out.names = nothing ? [] : hDone && s.picker !== 'jev' ? mergeNames(sc, hDone.names, s.maxSkills) : jn
    out.status = out.names.length ? 'ok' : 'none'
    if (dry) {
      out.jevNames = nothing ? [] : jevNames(sc, Infinity)
      if (h) out.haikuNames = h.names
      if (hDone) out.agree = sameSet(jn, hDone.names)
    }
  }
  out.ms = Math.max(0, (await nowMs($)) - t0)
  return out
}

// Exported so a test can drive it with a hand-built `$`.
export async function choose($: Engine, s: State, e: PromptSubmitInput, next: Next): Promise<PromptSubmitResult> {
  s.last = []
  s.pending = null
  if (skipReason(e, s)) return next(e)
  const hash = hashText(e.text.trim())
  const now = await nowMs($)
  const cat = catalog(s)
  const done = (p: Picked & Partial<Judged>, len: number): PickRec => ({
    kind: 'pick', t: now, hash, len, picks: p.names, ms: p.ms, input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite, mode: s.mode, catalogChars: cat.length, status: p.status,
    ...(p.path ? { path: p.path, jevIn: p.jevIn, jevOut: p.jevOut, jevMs: p.jevMs } : {}),
    ...(p.jevNames ? { jevNames: p.jevNames } : {}),
    ...(p.haikuNames ? { haikuNames: p.haikuNames } : {}),
    ...(p.agree !== undefined ? { agree: p.agree } : {}),
  })
  const none: Picked = { status: 'no-listing', names: [], ms: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  if (s.mode === 'dry') {
    let settle = () => {}
    const mine = (s.pending = new Promise<void>((r) => (settle = r)))
    let scheduled = false
    try {
      const out = await next(e)
      if (out.drop === undefined) {
        // Judged from a timer so the prompt is not held for it; the timer outlives this dispatch.
        $.clock.after(0, () => {
          void (async () => {
            try {
              const p = cat ? await judge($, s, out.text) : none
              if (s.pending === mine) s.last = p.names
              await record($, done(p, out.text.length))
            } catch {
              // the measurement is lost, the prompt is not
            } finally {
              settle()
            }
          })()
        })
        scheduled = true
      }
      return out
    } finally {
      if (!scheduled) settle()
    }
  }
  const p = cat ? await judge($, s, e.text) : none
  s.last = p.names
  await record($, done(p, e.text.length))
  return next(p.names.length ? { ...e, context: [...(e.context ?? []), contextLine(p.names)] } : e)
}

export async function used($: Engine, s: State, skill: unknown): Promise<void> {
  if (typeof skill !== 'string' || !skill) return
  const name = bareName(skill)
  if (s.pending) {
    // A timer that never fires must not hold the agreement check forever.
    const ac = new AbortController()
    await Promise.race([s.pending, $.clock.sleep(PENDING_MS, { signal: ac.signal }).catch(() => {})])
    ac.abort()
  }
  await record($, { kind: 'use', t: await nowMs($), skill: name, hit: s.last.some((n) => bareName(n) === name) })
}

export const register: Register = (on, options) => {
  const s: State = { ...parseConfig(options), listings: [], last: [], pending: null }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skill-pick',
      description: 'Show skill-pick counts, latency and agreement, the last records, or clear the log.',
      argumentHint: '[last|clear]',
    })
    return next(e)
  })

  on('command.run', { command: 'skill-pick' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg !== '' && arg !== 'last' && arg !== 'clear') return { text: USAGE }
    if (arg === 'clear') {
      await clearLog($)
      return { text: 'skill-pick: log cleared.' }
    }
    const old = await $.store.get(LOG_KEY)
    const log = Array.isArray(old) ? (old as Rec[]) : []
    return { text: arg === 'last' ? lastRecords(log) : summary(s, log) }
  }).catch(() => ({ text: 'skill-pick: the command failed. Check the debug log.' }))

  // Read-only: the listing text goes on exactly as the engine made it.
  on('prompt.attachment', { type: 'skill_listing' }, ($, e, next) => {
    if (s.mode !== 'off') addListing(s, e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Advisory: any failure lets the prompt through.
  on('prompt.submit', ($, e, next) => choose($, s, e, next)).catch(($, e, next) => next(e))

  // Measures only: the call is never changed or held back.
  on('tool.call', { tool: 'Skill' }, ($, e, next) => {
    if (s.mode !== 'off' && !e.agentId) {
      const skill = (e as { skill?: unknown }).skill
      // From a timer: the wait for the pick and the log write outlive this dispatch.
      try {
        $.clock.after(0, () => void used($, s, skill).catch(() => {}))
      } catch {
        // no timer: no use record
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
