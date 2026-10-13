import type { DelegationBoardRow as Row, DelegationBoardState as RowState } from '../types/index'

export type { Row, RowState }

export const MAX_ROWS = 40
export const DESC_MAX = 60
export const EFFORT_TTL_MS = 10 * 60 * 1000
export const MAX_MISSES = 3
export const USAGE = 'delegation-board: /board toggles the pane, /board clear drops finished rows, /board status prints the summary as text.'

const STATES: readonly string[] = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed', 'unknown']
const FINISHED: readonly string[] = ['completed', 'failed', 'killed']
const isControl = (c: number): boolean => c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)

export type Config = { mode: 'off' | 'on'; open: 'spawn' | 'never'; prices: Price[] }
export type Price = { key: string; input: number; output: number }
export type Listed = { id: string; status: string }
export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; model?: string }
export type Effort = { effort: string; at: number }
export type Spawned = { id: string; type: string; model: string; description: string; parentId?: string; background?: boolean; isTeammate?: boolean; effort: string | null; now: number }

// Effort rides the Agent tool call; the spawn that follows claims it by tool_use_id. Unclaimed entries expire.
export function noteEffort(map: Map<string, Effort>, id: unknown, effort: unknown, now: number): void {
  for (const [key, one] of map) if (now - one.at > EFFORT_TTL_MS) map.delete(key)
  if (typeof id === 'string' && id && typeof effort === 'string' && effort) map.set(id, { effort, at: now })
}

export function claimEffort(map: Map<string, Effort>, id: unknown, now: number): string | null {
  const one = typeof id === 'string' ? map.get(id) : undefined
  if (typeof id === 'string') map.delete(id)
  return one && now - one.at <= EFFORT_TTL_MS ? one.effort : null
}

export const isFinished = (state: string): boolean => FINISHED.includes(state)

// Unknown rows are never named by a spawn so they do not keep the poll running. An idle teammate does: the list is the
// only place a resumed turn shows, so the poll must still be running when it wakes.
export const needsPoll = (rows: Row[]): boolean => rows.some((r) => !isFinished(r.state) && r.state !== 'unknown')

// Finished, or given up on (unknown with an end time): drawn dimmed and sorted with the finished.
const isSettled = (r: Row): boolean => isFinished(r.state) || r.endedAt !== null

const FORMAT = /\p{Cf}/u

// Control, format (bidi, zero-width) characters never reach the pane; text is cut by code point.
export function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const spaced = Array.from(value, (ch) => (isControl(ch.codePointAt(0) ?? 0) || FORMAT.test(ch) ? ' ' : ch)).join('')
  const points = Array.from(spaced.replace(/\s+/g, ' ').trim())
  return points.slice(0, max).join('')
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

function parseMode(v: unknown): Config['mode'] {
  return v === 'off' ? 'off' : 'on'
}

// Any malformed entry drops the whole table: a half-read price list would price some rows and not others.
export function parsePrices(raw: unknown): Price[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return []
    const out: Price[] = []
    for (const [key, pair] of Object.entries(data)) {
      if (!key.trim() || !Array.isArray(pair) || pair.length !== 2) return []
      const [input, output] = pair as unknown[]
      for (const n of [input, output]) if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return []
      out.push({ key: key.trim().toLowerCase(), input: input as number, output: output as number })
    }
    return out
  } catch {
    return []
  }
}

export function parseConfig(o: Record<string, unknown>): Config {
  return { mode: parseMode(o.mode), open: o.open === 'never' ? 'never' : 'spawn', prices: parsePrices(o.prices) }
}

export function priceFor(model: string, prices: Price[]): Price | null {
  const m = model.toLowerCase()
  let best: Price | null = null
  for (const p of prices) if (m.includes(p.key) && (!best || p.key.length > best.key.length)) best = p
  return best
}

export const inTokens = (r: Row): number => r.input + r.cacheRead + r.cacheWrite

export function estimate(r: Row, prices: Price[]): number | null {
  const p = priceFor(r.model, prices)
  return p ? (inTokens(r) * p.input + r.output * p.output) / 1e6 : null
}

export function fmtCost(usd: number): string {
  return `~$${usd >= 0.1 ? usd.toFixed(2) : usd.toFixed(3)}`
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const k = n / 1000
  if (k < 9.95) return `${k.toFixed(1).replace(/\.0$/, '')}k`
  if (n < 999500) return `${Math.round(k)}k`
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export function newRow(f: Spawned): Row {
  return {
    id: f.id,
    parentId: f.parentId || null,
    type: clean(f.type, 40) || 'unknown',
    model: clean(f.model, 60) || 'unknown',
    effort: f.effort ? clean(f.effort, 10) || null : null,
    state: 'pending',
    description: clean(f.description, DESC_MAX),
    background: f.background === true,
    isTeammate: f.isTeammate === true,
    startedAt: f.now,
    endedAt: null,
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    misses: 0,
  }
}

// Over the cap, finished and unknown rows go first (oldest first); live rows only when nothing else is left.
function keep(rows: Row[]): Row[] {
  let extra = rows.length - MAX_ROWS
  if (extra <= 0) return rows
  const drop = new Set<string>()
  const take = (want: (r: Row) => boolean) => {
    for (const r of rows) {
      if (extra <= 0) return
      if (!drop.has(r.id) && want(r)) {
        drop.add(r.id)
        extra--
      }
    }
  }
  take((r) => isFinished(r.state) || r.state === 'unknown')
  take(() => true)
  return rows.filter((r) => !drop.has(r.id))
}

export const joinRows = (first: Row[], then: Row[]): Row[] => keep([...first, ...then])

// A row already made by an early turn.complete keeps its counts when the spawn arrives late.
export function addSpawn(rows: Row[], row: Row): Row[] {
  const old = rows.find((r) => r.id === row.id)
  if (!old) return keep([...rows, row])
  const merged: Row = { ...row, state: old.state === 'unknown' ? row.state : old.state, turns: old.turns, input: old.input, output: old.output, cacheRead: old.cacheRead, cacheWrite: old.cacheWrite, misses: old.misses }
  return keep(rows.map((r) => (r.id === row.id ? merged : r)))
}

export function addTurn(rows: Row[], agentId: string, usage: Usage | undefined, now: number): Row[] {
  const add = (r: Row): Row => ({
    ...r,
    turns: r.turns + 1,
    input: r.input + count(usage?.input_tokens),
    output: r.output + count(usage?.output_tokens),
    cacheRead: r.cacheRead + count(usage?.cache_read_input_tokens),
    cacheWrite: r.cacheWrite + count(usage?.cache_creation_input_tokens),
  })
  if (rows.some((r) => r.id === agentId)) return rows.map((r) => (r.id === agentId ? add(r) : r))
  const model = clean(usage?.model, 60) || 'unknown'
  const blank: Row = { ...newRow({ id: agentId, type: 'unknown', model, description: '', effort: null, now }), state: 'unknown' }
  return keep([...rows, add(blank)])
}

// Only for a call that succeeded (an empty list included). The engine's status is authoritative and the end
// time is the first poll that sees a finished one. A live row the list does not name MAX_MISSES polls
// running (workflow agents, teammates the engine dropped) is given up on as unknown.
export function mergeStatus(rows: Row[], listed: Listed[], now: number): Row[] {
  const by = new Map(listed.map((a) => [a.id, a.status]))
  return rows.map((r) => {
    const status = by.get(r.id)
    if (status === undefined) {
      if (isFinished(r.state) || r.state === 'unknown') return r
      const misses = r.misses + 1
      return misses >= MAX_MISSES ? { ...r, misses, state: 'unknown', endedAt: r.endedAt ?? now } : { ...r, misses }
    }
    if (typeof status !== 'string' || !STATES.includes(status) || status === 'unknown') return { ...r, misses: 0 }
    const state = status as RowState
    if (isFinished(state)) return { ...r, state, misses: 0, endedAt: r.endedAt ?? now }
    return { ...r, state, misses: 0, endedAt: null }
  })
}

const text = (v: unknown, max: number, fallback: string): string => clean(v, max) || fallback

// Rows read back from state at startup are not trusted to have the shape this code wrote.
export function sanitizeRows(value: unknown): Row[] {
  if (!Array.isArray(value)) return []
  const out: Row[] = []
  for (const x of value as Record<string, unknown>[]) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id) continue
    const state = typeof x.state === 'string' && STATES.includes(x.state) ? (x.state as RowState) : 'unknown'
    out.push({
      id: x.id,
      parentId: typeof x.parentId === 'string' && x.parentId ? x.parentId : null,
      type: text(x.type, 40, 'unknown'),
      model: text(x.model, 60, 'unknown'),
      effort: typeof x.effort === 'string' && x.effort ? clean(x.effort, 10) || null : null,
      state,
      description: clean(x.description, DESC_MAX),
      background: x.background === true,
      isTeammate: x.isTeammate === true,
      startedAt: count(x.startedAt),
      endedAt: typeof x.endedAt === 'number' && Number.isFinite(x.endedAt) ? x.endedAt : null,
      turns: count(x.turns),
      input: count(x.input),
      output: count(x.output),
      cacheRead: count(x.cacheRead),
      cacheWrite: count(x.cacheWrite),
      misses: count(x.misses),
    })
  }
  return keep(out)
}

export const clearFinished = (rows: Row[]): Row[] => rows.filter((r) => !isFinished(r.state))

// Live rows first (oldest start first, so rows stay put), then the newest settled; a child sits directly
// after its parent. Orphans and cycles keep the flat order.
export function sortRows(rows: Row[]): Row[] {
  const live = rows.filter((r) => !isSettled(r)).sort((a, b) => a.startedAt - b.startedAt)
  const done = rows.filter(isSettled).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const flat = [...live, ...done]
  const ids = new Set(flat.map((r) => r.id))
  const kids = new Map<string, Row[]>()
  const roots: Row[] = []
  for (const r of flat) {
    if (r.parentId !== null && r.parentId !== r.id && ids.has(r.parentId)) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r])
    else roots.push(r)
  }
  const out: Row[] = []
  const seen = new Set<string>()
  const walk = (r: Row) => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    out.push(r)
    for (const k of kids.get(r.id) ?? []) walk(k)
  }
  for (const r of roots) walk(r)
  for (const r of flat) walk(r)
  return out
}

export function header(rows: Row[]): string {
  const n = (s: string) => rows.filter((r) => r.state === s).length
  const failed = n('failed') + n('killed')
  return `${rows.length} agents: ${n('running')} running, ${n('waiting')} waiting, ${n('completed')} done, ${failed} failed`
}

export function footer(rows: Row[], prices: Price[]): string {
  const input = rows.reduce((a, r) => a + inTokens(r), 0)
  const output = rows.reduce((a, r) => a + r.output, 0)
  const costs = rows.map((r) => estimate(r, prices)).filter((c): c is number => c !== null)
  const unpriced = rows.some((r) => estimate(r, prices) === null && inTokens(r) + r.output > 0)
  const cost = costs.length ? `, ${fmtCost(costs.reduce((a, c) => a + c, 0))}${unpriced ? '+' : ''}` : ''
  return `Tokens ${fmtTokens(input)}/${fmtTokens(output)}${cost}`
}

export const EMPTY = 'No subagents yet.'

// Rows that fit: the pane's body rows less the header and footer, else the viewport less the frame's rows.
export function fit(bodyRows: unknown, viewportRows: unknown): number {
  const body = typeof bodyRows === 'number' && Number.isFinite(bodyRows) && bodyRows > 0 ? bodyRows - 2 : null
  const view = typeof viewportRows === 'number' && Number.isFinite(viewportRows) ? viewportRows : 24
  return Math.max(1, body ?? view - 4)
}

export const statusText = (rows: Row[], prices: Price[]): string => (rows.length ? `${header(rows)}\n${footer(rows, prices)}` : EMPTY)

export const BAND_ROWS = 3

const cut = (value: string, width: number): string => {
  const points = Array.from(value)
  return points.length <= width ? value : width > 3 ? `${points.slice(0, width - 3).join('')}...` : points.slice(0, Math.max(0, width)).join('')
}

// The band above the prompt on a surface with no pane: at most `max` one-line rows of the live agents
// (type, model, state, elapsed, tokens in/out), each cut to `columns`, and how many live agents are left out.
// The description is added only when at least 8 columns of it fit.
export function compact(rows: Row[], now: number, columns: number, max = BAND_ROWS): { rows: string[]; more: number } {
  const width = Number.isFinite(columns) && columns >= 10 ? Math.floor(columns) : 80
  const live = sortRows(rows).filter((r) => !isSettled(r))
  const shown = live.slice(0, Math.max(1, max)).map((r) => {
    const base = [clean(r.type, 40), clean(r.model, 60), r.state, fmtElapsed(now - r.startedAt), `${fmtTokens(inTokens(r))}/${fmtTokens(r.output)}`].join('  ')
    const room = width - Array.from(base).length - 2
    const description = room >= 8 ? clean(r.description, DESC_MAX) : ''
    return cut(description ? `${base}  ${cut(description, room)}` : base, width)
  })
  return { rows: shown, more: live.length - shown.length }
}

export type Line = { text: string; isDone: boolean }

// One text line per row. The cost column is left out unless some row on the board is priced.
export function lines(rows: Row[], prices: Price[], now: number, room: number): Line[] {
  const shown = sortRows(rows).slice(0, Math.max(1, room))
  const ids = new Set(rows.map((r) => r.id))
  const priced = rows.some((r) => estimate(r, prices) !== null)
  return shown.map((r) => {
    const cost = estimate(r, prices)
    const cols = [
      r.state.padEnd(9),
      clean(r.type, 40),
      clean(r.model, 60),
      clean(r.effort, 10) || '-',
      fmtElapsed((r.endedAt ?? now) - r.startedAt),
      `${fmtTokens(inTokens(r))}/${fmtTokens(r.output)}`,
      ...(priced ? [cost === null ? '-' : fmtCost(cost)] : []),
      clean(r.description, DESC_MAX),
    ]
    const indent = r.parentId !== null && ids.has(r.parentId) ? '  ' : ''
    return { text: `${indent}${cols.join('  ').trimEnd()}`, isDone: isSettled(r) }
  })
}
