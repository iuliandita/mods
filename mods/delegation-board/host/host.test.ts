import { expect, test } from 'bun:test'

import type { Data, SessionInfo } from '../../../host-lib/tui'
import { rows, setup, table } from './tui'

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
