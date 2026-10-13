import type { AgentInfo, AgentSpawnInput, CommandRunInput, On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import type { Row } from './board'
import { addSpawn, claimEffort, clean, compact, fit, footer, fmtElapsed, fmtTokens, header, mergeStatus, newRow, noteEffort, parseConfig, parsePrices, sortRows, statusText, type Effort } from './board'

const AGENTS = { plugin: 'delegation-board', key: 'agents' } as const
const PROMPT = 'PRIVATE-PROMPT-TEXT'

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, model: 'claude-sonnet-x' })
const turn = (agentId: string, u = usage(1, 1)) => ({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't', agentId, reason: 'end_turn', usage: u }) as never

const spawnInput = (description: string): AgentSpawnInput => ({
  tool_use_id: '',
  prompt: PROMPT,
  description,
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-sonnet-x',
  background: false,
  fork: false,
})

const commandInput = (args: string): CommandRunInput => ({
  command: 'board',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
})

type Ctl = { status: AgentInfo['status']; list: 'all' | 'none' | 'throw'; delay: number }

// The kit's $.agent.spawn carries no tool_use_id, so the effort claim is covered on the helpers below.
function world(on: On, ctl: Ctl = { status: 'running', list: 'all', delay: 0 }) {
  const clock = mock.clock(on, { now: 10_000 })
  const calls = { list: 0, spawn: 0, open: 0 }
  const placed = { is: true }
  on('agent.spawn', () => ({ model: 'claude-sonnet-x', agentId: `a${++calls.spawn}` }))
  on('agent.list', async () => {
    calls.list++
    if (ctl.list === 'throw') throw new Error('list failed')
    const value = ctl.list === 'none' ? [] : Array.from({ length: calls.spawn }, (_, i) => ({ id: `a${i + 1}`, status: ctl.status, description: 'd', type: 'Explore' }))
    if (ctl.delay) await clock.sleep(ctl.delay)
    return { value } as never
  })
  on('ui.open', () => ((calls.open++, { value: placed.is ? { isPlaced: true } : { isPlaced: false, reason: 'narrow terminal' } }) as never))
  on('ui.panes', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  return { clock, calls, ctl, placed }
}

// The kit's `$` has no state noun, so rows are read back from what the pane draws.
const drawn = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', bodyRows?: number) => {
  const ui = await $.ui.mount({ plugin: 'delegation-board', surface, component: 'Pane', requestId: 'delegation-board', props: (bodyRows ? { scroll: { offset: 0, bodyRows } } : {}) as never, viewport: { columns: 100, rows: 20 } })
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => t.text)
  await ui.unmount()
  return texts
}

test('a spawn, its turns and a poll become one row; a turn of an unlisted agent becomes an unknown row', async ($, on) => {
  const { clock, calls, ctl } = world(on)
  await $.agent.spawn(spawnInput('look around'))
  await $.turn.complete(turn('a1', usage(100, 20, 1000, 30)))
  await $.turn.complete(turn('a1', usage(50, 5)))
  await $.turn.complete(turn('fork-1', usage(7, 3)))
  await clock.advance(2000)
  expect(await drawn($)).toEqual([
    '2 agents: 1 running, 0 waiting, 0 done, 0 failed',
    'running    Explore  claude-sonnet-x  -  2s  1.2k/25  look around',
    'unknown    unknown  claude-sonnet-x  -  2s  7/3',
    'Tokens 1.2k/28',
  ])

  ctl.status = 'completed'
  await clock.advance(1000)
  const listed = calls.list
  await clock.advance(5000)
  expect(calls.list).toBe(listed)
  const after = await drawn($)
  expect(after[0]).toBe('2 agents: 0 running, 0 waiting, 1 done, 0 failed')
  expect(after[2]).toBe('completed  Explore  claude-sonnet-x  -  3s  1.2k/25  look around')
  expect(JSON.stringify(after)).not.toContain(PROMPT)

  await $.agent.spawn(spawnInput('again'))
  await clock.advance(1000)
  expect(calls.list).toBeGreaterThan(listed)
})

test('status merge keeps waiting and the first finished poll; sorting and the 40 row limit', () => {
  const at = (id: string, startedAt: number, state: Row['state'] = 'running') => ({ ...newRow({ id, type: 'Explore', model: 'm', description: id, effort: null, now: startedAt }), state })
  const done = (id: string, endedAt: number) => ({ ...at(id, 0, 'completed'), endedAt })
  const merged = mergeStatus([at('a', 1), at('b', 2), at('c', 3)], [{ id: 'a', status: 'waiting' }, { id: 'b', status: 'failed' }, { id: 'zzz', status: 'running' }], 50)
  expect(merged.map((r) => [r.id, r.state, r.endedAt])).toEqual([['a', 'waiting', null], ['b', 'failed', 50], ['c', 'running', null]])
  expect(mergeStatus(merged, [{ id: 'b', status: 'failed' }], 90)[1]?.endedAt).toBe(50)
  expect(mergeStatus(merged, [{ id: 'a', status: 'bogus' }], 90)[0]?.state).toBe('waiting')

  expect(sortRows([done('old', 10), at('w', 5, 'waiting'), done('new', 20), at('r', 4)]).map((r) => r.id)).toEqual(['r', 'w', 'new', 'old'])

  let rows: Row[] = []
  for (let i = 0; i < 45; i++) rows = addSpawn(rows, at(`x${i}`, i))
  expect(rows).toHaveLength(40)
  expect(rows[0]?.id).toBe('x5')
  rows = addSpawn([done('old', 1), ...rows.slice(1)], at('fresh', 99))
  expect(rows).toHaveLength(40)
  expect(rows.map((r) => r.id)).not.toContain('old')
  expect(rows[0]?.id).toBe('x6')

  const kid = (id: string, parentId: string, startedAt: number) => ({ ...at(id, startedAt), parentId })
  expect(sortRows([at('p', 1), at('q', 2), kid('k', 'p', 3), kid('l', 'q', 4), kid('orphan', 'gone', 5), kid('c1', 'c2', 6), kid('c2', 'c1', 7)]).map((r) => r.id)).toEqual(['p', 'k', 'q', 'l', 'orphan', 'c1', 'c2'])

  const efforts = new Map<string, Effort>()
  noteEffort(efforts, 't1', 'high', 0)
  noteEffort(efforts, 't2', 'low', 0)
  noteEffort(efforts, 't3', 'max', 700_000)
  expect(claimEffort(efforts, 't1', 700_000)).toBeNull()
  expect(claimEffort(efforts, 't3', 700_001)).toBe('max')
  expect(claimEffort(efforts, 't3', 700_002)).toBeNull()
  noteEffort(efforts, 't4', 'low', 1000)
  expect(claimEffort(efforts, 't4', 1000 + 599_999)).toBe('low')
})

test('formatting, header, footer, pricing estimate and bad prices', () => {
  expect([fmtElapsed(12_400), fmtElapsed(184_000), fmtElapsed(-5), fmtTokens(340), fmtTokens(1200), fmtTokens(15_300), fmtTokens(2_500_000)]).toEqual(['12s', '3m04s', '0s', '340', '1.2k', '15k', '2.5M'])
  expect(clean(['a', String.fromCharCode(0x1b), '[31m', String.fromCharCode(10), 'b', String.fromCharCode(0x202e), 'c  d'].join(''), 60)).toBe('a [31m b c d')
  expect(clean('x'.repeat(100), 60)).toHaveLength(60)
  expect(clean(['a', String.fromCharCode(0x200b), 'b', String.fromCharCode(0xfeff), 'c'].join(''), 60)).toBe('a b c')
  expect([fit(10, 50), fit(undefined, 20), fit(undefined, undefined), fit(2, 20), fit(0, 3)]).toEqual([8, 16, 20, 1, 1])

  const base = newRow({ id: 'a', type: 'Explore', model: 'claude-sonnet-x', description: 'd', effort: null, now: 0 })
  const rows: Row[] = [
    { ...base, state: 'completed', input: 1_000_000, output: 500_000 },
    { ...base, id: 'b', state: 'running', input: 500_000, cacheRead: 500_000 },
    { ...base, id: 'c', state: 'killed' },
    { ...base, id: 'd', state: 'waiting', model: 'other', input: 1000 },
  ]
  expect(header(rows)).toBe('4 agents: 1 running, 1 waiting, 1 done, 1 failed')
  const prices = parsePrices('{"SONNET": [3, 15]}')
  expect(footer(rows, prices)).toBe('Tokens 2M/500k, ~$13.50+')
  expect(statusText(rows, [])).toBe('4 agents: 1 running, 1 waiting, 1 done, 1 failed\nTokens 2M/500k')
  expect(statusText([], prices)).toBe('No subagents yet.')
  for (const bad of ['', 'not json', '[1,2]', '{"a": [1]}', '{"a": ["x", 2]}', '{"a": [1, -2]}', '{"a": [3, 15], "b": null}']) expect(parsePrices(bad)).toEqual([])
  expect(parseConfig({ mode: 'off', open: 'never', prices: '{oops' })).toEqual({ mode: 'off', open: 'never', prices: [] })
})

// A plugin above the board's state writes rewrites the rows to a value the host refuses, so every publish rejects.
const refuse = {
  name: 'refuse',
  register(on: On) {
    on('state.set', { plugin: 'delegation-board', key: 'agents' }, ($, e, next) => next({ ...e, value: undefined } as never))
  },
}

test('observers hand the engine its own value back when recording fails', { plugins: [refuse] }, async ($, on) => {
  const { clock, calls } = world(on)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  const spawned = await $.agent.spawn(spawnInput('x'))
  expect(spawned).toEqual({ model: 'claude-sonnet-x', agentId: 'a1' })
  expect(await $.turn.complete(turn('a1'))).toEqual({ text: '' })
  await clock.advance(3000)
  expect(calls.list).toBe(0)
  expect(await $.tool.call({ tool: 'Agent', effort: 'high', prompt: PROMPT, description: 'x', subagent_type: 'Explore' } as never)).toMatchObject({ text: 'ok' })
})

test('the pane draws the header and a row, and /board status prints the text', async ($, on) => {
  const { clock } = world(on)
  await $.agent.spawn(spawnInput('look around'))
  await $.turn.complete(turn('a1', usage(1200, 340)))
  await clock.advance(65_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const texts = await drawn($, surface)
    expect(texts[0]).toBe('1 agents: 1 running, 0 waiting, 0 done, 0 failed')
    expect(texts[1]).toBe('running    Explore  claude-sonnet-x  -  1m05s  1.2k/340  look around')
  }
  await $.agent.spawn(spawnInput('second'))
  expect(await drawn($, 'terminal', 30)).toHaveLength(4)
  expect(await drawn($, 'terminal', 3)).toHaveLength(3)
  expect((await $.command.run(commandInput('status'))).text).toBe('2 agents: 1 running, 0 waiting, 0 done, 0 failed\nTokens 1.2k/340')
  expect((await $.command.run(commandInput('bogus'))).text).toContain('/board toggles the pane')
})

test('a live row the list never names becomes unknown and polling stops; a failed list counts as nothing; a spawn during the last poll keeps polling', async ($, on) => {
  const { clock, calls, ctl } = world(on)
  await $.agent.spawn(spawnInput('ghost'))
  ctl.list = 'throw'
  await clock.advance(5000)
  expect((await drawn($))[1]).toMatch(/^pending /)

  ctl.list = 'none'
  await clock.advance(2000)
  expect((await drawn($))[1]).toMatch(/^pending /)
  await clock.advance(1000)
  expect((await drawn($))[1]).toMatch(/^unknown /)
  const stopped = calls.list
  await clock.advance(5000)
  expect(calls.list).toBe(stopped)

  ctl.list = 'all'
  ctl.status = 'completed'
  await $.agent.spawn(spawnInput('first'))
  ctl.delay = 300
  const before = calls.list
  await clock.advance(1000)
  expect(calls.list).toBe(before + 1)
  await $.agent.spawn(spawnInput('late'))
  await clock.advance(300)
  const during = calls.list
  await clock.advance(3000)
  expect(calls.list).toBeGreaterThan(during)
})

test('an idle teammate that resumes shows running again', async ($, on) => {
  const { clock, ctl } = world(on)
  ctl.status = 'idle'
  await $.agent.spawn({ ...spawnInput('mate'), isTeammate: true } as never)
  await clock.advance(3000)
  expect((await drawn($))[1]).toMatch(/^idle /)
  ctl.status = 'running'
  await clock.advance(1000)
  expect((await drawn($))[1]).toMatch(/^running /)
})

test('/clear empties the board and lets the next first spawn open the pane again', async ($, on) => {
  const { clock, calls } = world(on)
  await $.agent.spawn(spawnInput('before'))
  await $.turn.complete(turn('a1', usage(100, 20)))
  await clock.advance(1000)
  expect(calls.open).toBe(1)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  expect(await drawn($)).toEqual(['No subagents yet.'])
  await $.agent.spawn(spawnInput('after'))
  await clock.advance(1000)
  expect(calls.open).toBe(2)
  expect((await drawn($))[0]).toBe('1 agents: 1 running, 0 waiting, 0 done, 0 failed')
})

test('/board prints the table as text when the pane is not placed', async ($, on) => {
  const { clock, placed } = world(on)
  await $.agent.spawn(spawnInput('look around'))
  await clock.advance(1000)
  placed.is = false
  const text = (await $.command.run(commandInput(''))).text ?? ''
  expect(text).toContain('not placed on this surface (narrow terminal)')
  expect(text).toContain('show above the prompt')
  expect(text).toContain('1 agents: 1 running, 0 waiting, 0 done, 0 failed')
  expect(text).toContain('look around')
})

test('compact rows: live agents only, three at most, cut to the columns, with the rest counted', () => {
  const at = (id: string, startedAt: number, state: Row['state'] = 'running', description = id) => ({ ...newRow({ id, type: 'Explore', model: 'sonnet-x', description, effort: null, now: startedAt }), state, input: 1200, output: 340 })
  expect(compact([], 0, 80)).toEqual({ rows: [], more: 0 })
  expect(compact([{ ...at('a', 0, 'completed'), endedAt: 5 }], 9000, 80)).toEqual({ rows: [], more: 0 })
  const four = ['a', 'b', 'c', 'd'].map((id, i) => at(id, i * 1000))
  const band = compact([...four, { ...at('z', 0, 'failed'), endedAt: 1 }], 65_000, 80)
  expect(band.rows).toEqual(['Explore  sonnet-x  running  1m05s  1.2k/340  a', 'Explore  sonnet-x  running  1m04s  1.2k/340  b', 'Explore  sonnet-x  running  1m03s  1.2k/340  c'])
  expect(band.more).toBe(1)
  expect(compact(four, 65_000, 80, 1).more).toBe(3)
})

test('compact rows fit a narrow band: the description goes first, then the row is cut', () => {
  const row = { ...newRow({ id: 'a', type: 'Explore', model: 'claude-sonnet-x', description: 'look around the repo', effort: null, now: 0 }), state: 'running' as const }
  const base = 'Explore  claude-sonnet-x  running  5s  0/0'
  expect(compact([row], 5000, 80).rows).toEqual([`${base}  look around the repo`])
  expect(compact([row], 5000, 56).rows[0]).toBe(`${base}  look arou...`)
  expect(compact([row], 5000, 50).rows).toEqual([base])
  const tight = compact([row], 5000, 20).rows[0] ?? ''
  expect(tight).toBe('Explore  claude-s...')
  expect(compact([row], 5000, Number.NaN).rows[0]).toBe(`${base}  look around the repo`)
})

const band = async ($: Engine, surface: 'terminal' | 'desktop', hasSurvey = false) => {
  const ui = await $.ui.mount({
    plugin: 'delegation-board',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } as never,
    viewport: { columns: 100, rows: 20 },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => t.text)
  await ui.unmount()
  return texts
}

test('the band above the prompt shows compact rows on desktop only, and yields to a survey', async ($, on) => {
  const { clock } = world(on)
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }))
  expect(await band($, 'desktop')).toEqual([])
  for (const d of ['one', 'two', 'three', 'four']) await $.agent.spawn(spawnInput(d))
  await clock.advance(2000)
  const texts = await band($, 'desktop')
  expect(texts).toHaveLength(4)
  expect(texts[0]).toMatch(/^Explore {2}claude-sonnet-x {2}running {2}\d+s {2}0\/0 {2}one$/)
  expect(texts[3]).toBe('+1 more')
  expect(await band($, 'terminal')).toEqual([])
  expect(await band($, 'desktop', true)).toEqual([])
})
