import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Data, SessionInfo } from '../../../host-lib/tui'
import { OFF_TEXT, rows, setup, table } from './tui'

const info = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  parentID: 'root',
  agent: 'explorer',
  title: 'Find the config',
  cost: 0.02,
  tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 3000, write: 0 } },
  time: { created: 0, idle: 120_000 },
  ...over,
})

function data(sessions: SessionInfo[], running: string[] = []): Data {
  const all = [{ id: 'root' } as SessionInfo, ...sessions]
  return {
    session: {
      get: (id) => all.find((s) => s.id === id),
      family: () => all.map((s) => s.id),
      status: (id) => (running.includes(id) ? 'running' : 'idle'),
      sync: async () => {},
    },
    location: { vcs: { info: () => undefined, sync: async () => {} } },
  }
}

test('rows are the child sessions with a state from their outcome and status', () => {
  const d = data([info('a', { outcome: 'succeeded' }), info('b', { outcome: 'failed' }), info('c'), info('d', { outcome: 'interrupted' }), info('e', { time: { created: 60_000 } })], ['e'])
  const r = rows(d, 'root', 180_000)
  expect(r.map((x) => x.state)).toEqual(['done', 'failed', 'idle', 'stopped', 'running'])
  expect(r[4]?.ms).toBe(120_000)
  expect(r[0]?.ms).toBe(120_000)
})

test('inside a child session only its own descendants are listed, never the root or siblings', () => {
  const d = data([info('a'), info('b'), info('a1', { parentID: 'a' }), info('x', { parentID: 'nobody' })])
  expect(rows(d, 'a', 0).map((r) => r.id)).toEqual(['a1'])
  expect(rows(d, 'root', 0).map((r) => r.id)).toEqual(['a', 'b', 'a1'])
})

test('a finished session without an end time shows 0, and the header counts every subagent past the row limit', () => {
  const d = data([info('a', { time: { created: 0 }, outcome: 'succeeded' })])
  expect(rows(d, 'root', 999_999)[0]?.ms).toBe(0)
  const many = data(Array.from({ length: 45 }, (_, i) => info(`c${i}`, { outcome: 'succeeded' })))
  const t = table(rows(many, 'root', 0))
  expect(t.split('\n')[0]).toContain('45 subagents')
  expect(t.split('\n')[0]).toContain('5 older not shown')
  expect(t.split('\n')).toHaveLength(41)
})

test('names with escape, bidi or tag characters are cleaned; the cut is on code points', () => {
  const evil = 'a\u001b]0;pwn\u0007b\u202etxt\u061cc\u{e0041}d'
  const [r] = rows(data([info('a', { title: evil, agent: 'x'.repeat(5) + '😀'.repeat(20) })]), 'root', 0)
  expect(r?.title).toBe('a ]0;pwn b txt c d')
  expect([...(r?.agent ?? '')]).toHaveLength(12)
  expect(r?.agent.includes('\ud83d') && !r?.agent.endsWith('😀')).toBe(false)
})

test('the table has a header with counts and one line per subagent; titles cannot break it', () => {
  const t = table(rows(data([info('a', { outcome: 'succeeded', title: 'line1\nline2‮evil' })]), 'root', 0))
  const lines = t.split('\n')
  expect(lines[0]).toBe('delegation-board: 1 subagent, 0 running, $0.02')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain('✓ done')
  expect(lines[1]).toContain('explorer')
  expect(lines[1]).toContain('4k')
  expect(lines[1]).not.toContain('‮')
  expect(table([])).toContain('no subagents')
})

test('setup claims the panel slot, draws only its own panel, and adds the /board command', async () => {
  const claims: { render: (i: { name: string; sessionID: string }) => { content: string } }[] = []
  const layers: (() => { commands: readonly { slash: { name: string }; run: () => void }[] })[] = []
  const calls: string[] = []
  let current: { name: string } | undefined
  const cleanup = await setup(
    {
      renderer: {},
      data: data([info('a', { outcome: 'succeeded' })]),
      keymap: { layer: (f) => void layers.push(f as never) },
      ui: {
        panel: { open: (n) => (calls.push(`open ${n}`), (current = { name: n }), true), close: () => (calls.push('close'), (current = undefined)), current: () => current },
        slot: (c) => (claims.push(c as never), () => void calls.push('release')),
      },
    },
    (content) => ({ content }),
  )
  expect(claims[0]!.render({ name: 'other', sessionID: 'root' }).content).toBe('')
  expect(claims[0]!.render({ name: 'iuliandita.delegation-board', sessionID: 'root' }).content).toContain('1 subagent')
  const cmd = layers[0]!().commands[0]!
  expect(cmd.slash.name).toBe('board')
  cmd.run()
  cmd.run()
  expect(calls).toEqual(['open iuliandita.delegation-board', 'close'])
  cleanup()
  expect(calls.at(-1)).toBe('release')
})

test('mode off in the user options file draws a notice and does not read the sessions; anything else stays on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delegation-board-'))
  const file = join(dir, 'delegation-board.json')
  try {
    const panel = async () => {
      const claims: { render: (i: { name: string; sessionID: string }) => { content: string } }[] = []
      let family = 0
      const d = data([info('a', { outcome: 'succeeded' })])
      d.session.family = () => (family++, ['root', 'a'])
      await setup(
        { renderer: {}, data: d, keymap: { layer: () => {} }, ui: { panel: { open: () => true, close: () => {}, current: () => undefined }, slot: (c) => (claims.push(c as never), () => {}) } },
        (content) => ({ content }),
        file,
      )
      const out = claims[0]!.render({ name: 'iuliandita.delegation-board', sessionID: 'root' }).content
      return { out, family }
    }
    for (const body of [undefined, '{}', '{"mode":"on"}', '{"mode":"nope"}', '{ broken']) {
      if (body !== undefined) writeFileSync(file, body)
      expect((await panel()).out).toContain('1 subagent')
    }
    writeFileSync(file, '{"mode":"off"}')
    const off = await panel()
    expect(off.out).toBe(OFF_TEXT)
    expect(off.family).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
