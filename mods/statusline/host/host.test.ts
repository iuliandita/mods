import { expect, test } from 'bun:test'

import type { Data, SessionInfo } from '../../../host-lib/tui'
import { bind, duration, ticker, toMs, tokens } from '../../../host-lib/tui'
import { line, setup } from './tui'

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's1',
  cost: 0.4321,
  tokens: { input: 12_000, output: 800, reasoning: 0, cache: { read: 30_000, write: 0 } },
  time: { created: 1_000_000 },
  model: { id: 'deepseek-v4.1-flash' },
  ...over,
})

function ctx(over: { session?: SessionInfo | undefined; branch?: string; status?: 'idle' | 'running' } = {}) {
  const s = 'session' in over ? over.session : session()
  const data: Data = {
    session: { get: () => s, family: () => [], status: () => over.status ?? 'idle', sync: async () => {} },
    location: { vcs: { info: () => (over.branch ? { branch: { current: over.branch } } : undefined), sync: async () => {} } },
  }
  const claims: { render: (i: { readonly sessionID: string }) => unknown }[] = []
  const released: number[] = []
  return {
    value: {
      renderer: {},
      location: { directory: '/srv/code/proj/' },
      data,
      ui: { model: { current: () => ({ modelID: 'fallback-model' }) }, slot: (c: (typeof claims)[number]) => (claims.push(c), () => void released.push(1)) },
    },
    claims,
    released,
  }
}

test('the line shows model, folder, branch, context tokens, cost, elapsed time and the running mark', () => {
  const c = ctx({ branch: 'feat/x', status: 'running' })
  expect(line(c.value, 's1', 1_000_000 + 5 * 60_000)).toBe('◆ deepseek-v4.1-flash  proj  ⎇ feat/x  ctx 42k  $0.43  5m  ●')
})

test('missing data leaves its piece out: no session, no branch, no tokens', () => {
  expect(line(ctx({ session: undefined }).value, 's1', 0)).toBe('◆ fallback-model  proj')
  const empty = session({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 'nonsense' } })
  expect(line(ctx({ session: empty }).value, 's1', 0)).toBe('◆ deepseek-v4.1-flash  proj  $0.43')
})

test('setup claims the slot above the prompt, redraws on a timer, and releases on cleanup', async () => {
  const c = ctx({ branch: 'main' })
  const nodes: { content: string }[] = []
  const cleanup = await setup(c.value, (content) => {
    const n = { content }
    nodes.push(n)
    return n
  })
  expect(c.claims).toHaveLength(1)
  const node = c.claims[0]!.render({ sessionID: 's1' }) as { content: string }
  expect(node.content).toContain('proj')
  node.content = 'stale'
  await Bun.sleep(1200)
  expect(node.content).toContain('⎇ main')
  cleanup()
  expect(c.released).toEqual([1])
})

test('host-supplied names are cleaned before they are drawn', () => {
  const c = ctx({ branch: 'feat/' + String.fromCharCode(0x202e) + 'txt' + String.fromCharCode(0x1b) + ']0;x' })
  const out = line(c.value, 's1', 1_000_000)
  expect(out).not.toContain(String.fromCharCode(0x202e))
  expect(out).not.toContain(String.fromCharCode(0x1b))
})

test('time and number helpers', () => {
  expect(toMs(5)).toBe(5)
  expect(toMs('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'))
  expect(toMs({ epochMillis: 7 })).toBe(7)
  expect(toMs({})).toBeUndefined()
  expect(duration(30_000)).toBe('<1m')
  expect(duration(75 * 60_000)).toBe('1h15m')
  expect(tokens(999)).toBe('999')
  expect(tokens(1_500_000)).toBe('1.5M')
})

test('a redraw stops once the host destroys its node, and a failing draw is dropped', async () => {
  const tick = ticker(10)
  const node = { content: '', isDestroyed: false }
  let draws = 0
  bind(tick, node, () => `n${++draws}`)
  const bad = { content: 'keep' }
  bind(tick, bad, () => {
    throw new Error('boom')
  })
  await Bun.sleep(60)
  expect(node.content).not.toBe('')
  expect(bad.content).toBe('keep')
  node.isDestroyed = true
  await Bun.sleep(40)
  const seen = draws
  await Bun.sleep(60)
  expect(draws).toBe(seen)
  tick.stop()
})
