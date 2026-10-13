import { atom, read } from 'claude-code'
import type { AgentInfo, EngineInterface as Engine, Register, Timer } from 'claude-code'

import type { Config, Effort, Row } from './board'
import { MAX_ROWS, addSpawn, compact, addTurn, claimEffort, clearFinished, EMPTY, fit, footer, header, joinRows, lines, mergeStatus, needsPoll, newRow, noteEffort, parseConfig, sanitizeRows, statusText, USAGE } from './board'

const PANE = 'delegation-board'
const TITLE = 'Delegation'
const LIST_MS = 1000
const STALE_MS = 3000

const AGENTS = { plugin: 'delegation-board', key: 'agents' } as const
const TICK = { plugin: 'delegation-board', key: 'tick' } as const
const OPENED = { plugin: 'delegation-board', key: 'opened' } as const
const agents = atom(AGENTS, [] as Row[])
const tick = atom(TICK, 0)

async function nowMs($: Engine): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

// The rows live here and every hook changes them in one synchronous step; state only mirrors them for the
// pane. A timer or a hook never reads state back: one dispatch reads one moment, and parallel hooks would lose updates.
type Ctx = {
  cfg: Config
  efforts: Map<string, Effort>
  rows: Row[]
  tick: number
  opened: boolean
  timer: Timer | null
  lastTick: number
  isPolling: boolean
}

async function publish($: Engine, s: Ctx): Promise<void> {
  await $.state.set(AGENTS, s.rows)
  await $.state.set(TICK, s.tick)
  // The pane redraws from state; the band above the prompt draws from memory, so it is asked to.
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // fail open: the band redraws on the next change
  }
}

async function markOpened($: Engine, s: Ctx): Promise<void> {
  s.opened = true
  await $.state.set(OPENED, true)
}

// A failed or hung call is no information: null leaves every status as it was.
async function listAgents($: Engine): Promise<AgentInfo[] | null> {
  const stop = new AbortController()
  try {
    const wait = $.clock.sleep(LIST_MS, { signal: stop.signal }).then(() => null, () => null)
    return await Promise.race([$.agent.list(), wait])
  } catch {
    return null
  } finally {
    stop.abort()
  }
}

function halt(s: Ctx): void {
  s.timer?.cancel()
  s.timer = null
}

async function poll($: Engine, s: Ctx): Promise<void> {
  if (s.isPolling) return
  s.isPolling = true
  try {
    const listed = await listAgents($)
    const now = await nowMs($)
    if (listed) s.rows = mergeStatus(s.rows, listed, now)
    s.tick++
    s.lastTick = now
    // Decided in the same step as the merge, so a spawn that lands while the write is in flight finds no timer and starts one.
    if (!needsPoll(s.rows)) halt(s)
    await publish($, s)
  } finally {
    s.isPolling = false
  }
}

// One timer while a row needs polling; one that stopped ticking is replaced.
async function start($: Engine, s: Ctx): Promise<void> {
  const now = await nowMs($)
  if (s.timer && (now - s.lastTick <= STALE_MS || !needsPoll(s.rows))) return
  s.timer?.cancel()
  s.lastTick = now
  s.timer = $.clock.every(1000, () => void poll($, s).catch(() => {}))
}

// A /clear (or a resume) starts the board from empty; session.start does not fire for it, session.end does.
async function reset($: Engine, s: Ctx): Promise<void> {
  halt(s)
  s.rows = []
  s.efforts.clear()
  s.opened = false
  await publish($, s)
  await $.state.set(OPENED, false)
}

async function hydrate($: Engine, s: Ctx): Promise<void> {
  const loaded = sanitizeRows((await $.state.get(AGENTS)).value)
  const have = new Set(s.rows.map((r) => r.id))
  s.rows = joinRows(loaded.filter((r) => !have.has(r.id)), s.rows)
  s.opened = s.opened || (await $.state.get(OPENED)).value === true
  if (needsPoll(s.rows)) await start($, s)
}

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  const s: Ctx = { cfg, efforts: new Map(), rows: [], tick: 0, opened: false, timer: null, lastTick: 0, isPolling: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'board',
      description: 'Toggle the delegation pane, clear its finished rows, or print its summary.',
      argumentHint: '[clear|status]',
    })
    // A reload starts a fresh module: take the rows back from state and resume polling.
    if (cfg.mode !== 'off') {
      try {
        await hydrate($, s)
      } catch {
        // fail open: the board starts empty
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      try {
        await reset($, s)
      } catch {
        // fail open: the rows were dropped from memory
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'board' }, async ($, e) => {
    if (cfg.mode === 'off') return { text: 'delegation-board: mode is off.' }
    const arg = e.args.trim()
    if (arg === 'status') return { text: statusText(s.rows, cfg.prices) }
    if (arg === 'clear') {
      s.rows = clearFinished(s.rows)
      await publish($, s)
      return { text: 'delegation-board: finished rows cleared; the totals now cover the rows left.' }
    }
    if (arg !== '') return { text: USAGE }
    const pane = (await $.ui.panes()).find((p) => p.id === PANE)
    if (pane && pane.isPlaced && pane.isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'delegation-board: pane closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    await markOpened($, s)
    if (opened.isPlaced) return { text: 'delegation-board: pane opened.' }
    const table = s.rows.length ? [header(s.rows), ...lines(s.rows, cfg.prices, await nowMs($), MAX_ROWS).map((l) => l.text), footer(s.rows, cfg.prices)].join('\n') : EMPTY
    return { text: `delegation-board: the pane was not placed on this surface (${opened.reason}). On Desktop, compact rows of the running subagents show above the prompt. The table as text:\n${table}` }
  }).catch(() => ({ text: 'delegation-board: the command failed. Check the debug log.' }))

  if (cfg.mode === 'off') return

  // The hooks below only observe: the engine's value goes on untouched and a recording failure is swallowed.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.agentId) {
        const now = await nowMs($)
        const row = newRow({
          id: result.agentId,
          type: e.subagentType,
          model: result.model,
          description: e.description,
          parentId: e.parentAgentId,
          background: e.background,
          isTeammate: e.isTeammate,
          effort: claimEffort(s.efforts, e.tool_use_id, now),
          now,
        })
        s.rows = addSpawn(s.rows, row)
        const first = cfg.open === 'spawn' && !s.opened
        if (first) s.opened = true
        await publish($, s)
        await start($, s)
        if (first) {
          void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
          void markOpened($, s).catch(() => {})
        }
      }
    } catch {
      // fail open: the spawn already happened
    }
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    try {
      noteEffort(s.efforts, e.tool_use_id, (e as { effort?: unknown }).effort, await nowMs($))
    } catch {
      // fail open
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId) {
        s.rows = addTurn(s.rows, e.agentId, e.usage, await nowMs($))
        await publish($, s)
        await start($, s)
      }
    } catch {
      // fail open
    }
    return result
  }).catch(($, e, next) => next(e))

  // Desktop does not place the pane, so it gets the band above the prompt; the terminal keeps the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const band = compact(s.rows, await nowMs($), e.props.bodyColumns)
    if (band.rows.length === 0) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        {band.rows.map((text) => (
          <Text wrap="truncate-end">{text}</Text>
        ))}
        {band.more > 0 ? <Text dimColor>{`+${band.more} more`}</Text> : null}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = await read($, agents)
    await read($, tick)
    const now = await nowMs($)
    const room = fit((e.props as { scroll?: { bodyRows?: unknown } }).scroll?.bodyRows, e.viewport?.rows)
    return (
      <Box flexDirection="column">
        {rows.length === 0 ? <Text dimColor>{EMPTY}</Text> : <Text>{header(rows)}</Text>}
        {lines(rows, cfg.prices, now, room).map((l) => (
          <Text dimColor={l.isDone}>{l.text}</Text>
        ))}
        {rows.length === 0 ? null : <Text>{footer(rows, cfg.prices)}</Text>}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
