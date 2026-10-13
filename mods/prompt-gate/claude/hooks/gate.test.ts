import type { EngineInterface as Engine, PromptSubmitInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { lastRecords, parseConfig, summary, type Config, type Rec, type State } from './gate'
import { hashText } from './shared/hash'
import { gate } from './register'

// Driven directly with a hand-built `$`; register.test.ts runs the real plugin through the kit.
const submit = (text: string, origin: PromptSubmitInput['origin'] = { kind: 'composer' }): PromptSubmitInput => ({ text, wait: false, origin })

const state = (o: Record<string, unknown> = {}): State => ({ ...parseConfig({ mode: 'dry', ...o }), vocab: null, bounced: new Map() })

// The test's `$` carries only the event calls, so the nouns the gate uses are stood in for here.
function world(first: string, clock?: { sleep: (ms: number) => Promise<void> }) {
  const store = new Map<string, unknown>()
  const seen = {
    calls: 0, reply: first, now: 0, $: null as unknown as Engine,
    fetches: [] as { url: string; init: { headers: Record<string, string>; body: string } }[],
    jev: { status: 200, body: '', hang: false, throws: false },
    vars: {} as Record<string, string>,
    cwd: '/work/proj',
    files: {} as Record<string, string>,
  }
  seen.$ = {
    clock: {
      now: async () => (seen.now += 5),
      // the test's `$` has no timers (a hook's does, but only a plugin's own hooks may call them): ride the mocked clock instead, which the test advances
      after: (ms: number, fn: () => void) => {
        let live = true
        void clock!.sleep(ms).then(() => live && fn())
        return { cancel: () => void (live = false) }
      },
      // like the host: pending until the abort, unless the fetch is meant to hang
      sleep: (_ms: number, o?: { signal?: AbortSignal }) =>
        seen.jev.hang ? Promise.resolve() : new Promise<void>((_, rej) => o?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    },
    env: { get: async (k: string) => seen.vars[k] },
    session: { cwd: async () => seen.cwd },
    http: {
      fetch: (url: string, init: { headers: Record<string, string>; body: string }) => {
        seen.fetches.push({ url, init })
        if (seen.jev.hang) return new Promise(() => {})
        if (seen.jev.throws) return Promise.reject(new Error('net'))
        return Promise.resolve({ status: seen.jev.status, ok: seen.jev.status < 300, headers: {}, text: seen.jev.body })
      },
    },
    fs: { read: async (n: string) => (n in seen.files ? seen.files[n] : Promise.reject(new Error('missing'))) },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) },
    model: {
      complete: async () => {
        seen.calls++
        return seen.reply === 'fail'
          ? { isAnswered: false, reason: 'api-error', status: 500, usage: { input_tokens: 0, output_tokens: 0 } }
          : { isAnswered: true, text: seen.reply, usage: { input_tokens: 40, output_tokens: 10 } }
      },
    },
  } as unknown as Engine
  return seen
}

const entered = () => {
  const log: string[] = []
  const next = async (e: PromptSubmitInput) => {
    log.push(e.text)
    return { text: e.text }
  }
  return Object.assign(next, { log })
}

const reply = (a: Record<string, number>) =>
  JSON.stringify({ model: 'jev-latest', answers: Object.fromEntries(Object.entries(a).map(([k, noul]) => [k, { type: 'noul', noul }])), usage: { input_tokens: 600, output_tokens: 40 } })
// Four answers that all agree on combined P(vague) = p.
const answer = (p: number) => reply({ vague: p, outcome: 1 - p, action: 1 - p, startable: 1 - p })
const KEY = 'sk-test-secret-key'

const records = async ($: Engine) => ((await $.store.get('log')) as Rec[] | undefined) ?? []

test('dry mode lets the prompt in unchanged, asks the model once after, and logs one record', async (_$, on) => {
  const clock = mock.clock(on)
  const seen = world('{"verdict":"vague","ask":"Which file?"}', clock)
  const next = entered()
  const r = await gate(seen.$, state(), submit('fix the thing please'), next)
  expect(r).toEqual({ text: 'fix the thing please' })
  expect(next.log).toEqual(['fix the thing please'])
  expect(seen.calls).toBe(0)
  await clock.advance(0)
  expect(seen.calls).toBe(1)
  const log = await records(seen.$)
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({ hash: hashText('fix the thing please'), len: 20, verdict: 'vague', mode: 'dry', bounced: false, input: 40, output: 10 })
  expect(JSON.stringify(log)).not.toContain('thing')
})

test('on mode bounces a vague prompt with the ask and lets the identical resend through without a model call', async () => {
  const seen = world('Sure: {"verdict":"vague","ask":"Which file?"} done')
  const s = state({ mode: 'on' })
  const next = entered()
  const r = await gate(seen.$, s, submit('fix the thing please'), next)
  expect(r.drop).toContain('Which file?')
  expect(next.log).toEqual([])
  const again = await gate(seen.$, s, submit('fix the thing please'), next)
  expect(again).toEqual({ text: 'fix the thing please' })
  expect(seen.calls).toBe(1)
  expect((await records(seen.$)).map((x) => x.bounced)).toEqual([true])
  await gate(seen.$, s, submit('fix the thing please'), next)
  seen.now += 11 * 60 * 1000
  const late = await gate(seen.$, s, submit('fix the thing please'), next)
  expect(late.drop).toContain('Which file?')
  expect(seen.calls).toBe(3)
})

test('slash commands, short text, other origins, attachments and off mode make no model call', async () => {
  const seen = world('{"verdict":"vague","ask":"?"}')
  const next = entered()
  const on_ = state({ mode: 'on' })
  await gate(seen.$, on_, submit('/compact now please'), next)
  await gate(seen.$, on_, submit('!ls -la /tmp/somewhere'), next)
  await gate(seen.$, on_, submit('fix it'), next)
  await gate(seen.$, on_, submit('fix the thing please', { kind: 'sdk' }), next)
  await gate(seen.$, on_, { ...submit('fix the thing please'), attachments: [{} as never] }, next)
  await gate(seen.$, state({ mode: 'off' }), submit('fix the thing please'), next)
  await gate(seen.$, on_, submit('x'.repeat(4001)), next)
  expect(seen.calls).toBe(0)
  expect(next.log).toHaveLength(7)
})

test('a model failure, empty reply or bad verdict lets the prompt through and logs an error', async () => {
  const seen = world('fail')
  for (const reply of ['fail', '', 'no json here', '{"verdict":"maybe"}', '{"verdict":"vague"']) {
    seen.reply = reply
    const next = entered()
    const r = await gate(seen.$, state({ mode: 'on' }), submit(`fix the thing please ${reply.length}`), next)
    expect(r).toEqual({ text: `fix the thing please ${reply.length}` })
  }
  const log = await records(seen.$)
  expect(log).toHaveLength(5)
  expect(log.every((x) => x.verdict === 'error' && !x.bounced)).toBe(true)
})

test('the summary reports counts, vague rate, median and p90 latency and token sums', () => {
  const c: Config = parseConfig({ mode: 'on', model: 'haiku' })
  const rec = (verdict: Rec['verdict'], ms: number): Rec => ({
    t: 0, hash: 'ab', len: 20, verdict, ms, input: 10, output: 5, mode: 'on', bounced: verdict === 'vague',
    path: ms > 500 ? 'cascade' : 'haiku', jev: 0.5, jevIn: 300, jevOut: 20, jevMs: ms, agree: ms % 200 === 0,
  })
  const log = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms, i) => rec(i < 3 ? 'vague' : i < 9 ? 'clear' : 'error', ms))
  const text = summary(c, log)
  expect(text).toContain('records: 10 (clear 6, vague 3, error 1)')
  expect(text).toContain('vague rate: 33%')
  expect(text).toContain('median 500 ms, p90 900 ms')
  expect(text).toContain('tokens: 100 in, 50 out')
  expect(text).toContain('paths: haiku 5, jev 0, cascade 5, jev-fallback 0')
  expect(text).toContain('jev latency: median 800 ms')
  expect(text).toContain('dry agreement: 50% of 10')
  expect(text).toContain('jev tokens: 3000 in, 200 out')
  expect(lastRecords(log).split('\n')).toHaveLength(5)
})

test('the cascade skips Haiku when Jev is sure, asks it only for the ask when Jev says vague, and lets it decide in between; failures fall back to Haiku', async () => {
  const seen = world('{"verdict":"vague","ask":"Which file?"}')
  seen.vars.TYPESAFE_API_KEY = KEY
  const s = state({ mode: 'on' })
  const run = async (text: string) => gate(seen.$, s, submit(text), entered())

  seen.jev.body = answer(0.1)
  expect(await run('rename the foo function')).toEqual({ text: 'rename the foo function' })
  expect(seen.calls).toBe(0)

  seen.jev.body = answer(0.9)
  expect((await run('fix the thing please')).drop).toContain('Which file?')
  expect(seen.calls).toBe(1)

  seen.jev.body = answer(0.5)
  seen.reply = '{"verdict":"clear","ask":""}'
  expect(await run('improve the build somehow')).toEqual({ text: 'improve the build somehow' })
  expect(seen.calls).toBe(2)
  seen.reply = '{"verdict":"vague","ask":"Which build?"}'
  expect((await run('improve the build somehow now')).drop).toContain('Which build?')

  expect(seen.fetches[0]).toMatchObject({ url: 'https://api.typesafe.ai/v1/systemone', init: { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } } })
  const sent = JSON.parse(seen.fetches[0]!.init.body)
  expect(sent.model).toBe('jev-latest')
  expect(Object.keys(sent.questions)).toEqual(['vague', 'outcome', 'action', 'startable'])

  const before = (await records(seen.$)).length
  const cases: [string, () => void][] = [
    ['http 500', () => Object.assign(seen.jev, { status: 500, body: '{"error":"x"}' })],
    ['garbled', () => Object.assign(seen.jev, { status: 200, body: 'not json' })],
    ['out of range', () => Object.assign(seen.jev, { status: 200, body: answer(1.5) })],
    ['throws', () => Object.assign(seen.jev, { status: 200, throws: true })],
    ['timeout', () => Object.assign(seen.jev, { throws: false, hang: true })],
  ]
  for (const [i, [, setup]] of cases.entries()) {
    setup()
    const r = await run(`fix the thing please ${i}`)
    expect(r.drop).toContain('Which build?')
  }
  const log = (await records(seen.$)).slice(before)
  expect(log.map((x) => x.path)).toEqual(Array(5).fill('jev-fallback'))
  expect(log.every((x) => x.jev === null)).toBe(true)
  expect(seen.calls).toBe(3 + 5)
})

test('the combined Jev score sends a borderline prompt to Haiku where the vague question alone would have settled it, and falls back to that question when the other answers are missing', async () => {
  const seen = world('{"verdict":"clear","ask":""}')
  seen.vars.TYPESAFE_API_KEY = KEY
  const s = state({ mode: 'on' })

  seen.jev.body = reply({ vague: 0.88, outcome: 0.3, action: 0.4, startable: 0.3 })
  expect(await gate(seen.$, s, submit('improve the build somehow'), entered())).toEqual({ text: 'improve the build somehow' })
  expect(seen.calls).toBe(1)
  expect(Math.round(((await records(seen.$)).at(-1)?.jev ?? 0) * 1e6) / 1e6).toBe(0.72)

  seen.jev.body = reply({ vague: 0.88 })
  expect((await gate(seen.$, s, submit('improve the build somehow now'), entered())).drop).toBeDefined()
  expect((await records(seen.$)).at(-1)?.jev).toBe(0.88)
})

test('the path gate and a missing key make no Jev call, flag mode adds a context line and never drops, and no record holds the key or the prompt', async () => {
  const seen = world('{"verdict":"vague","ask":"Which file?"}')
  seen.jev.body = answer(0.9)

  await gate(seen.$, state({ mode: 'flag' }), submit('fix the thing please'), entered())
  expect(seen.fetches).toHaveLength(0)

  seen.vars.TYPESAFE_API_KEY = KEY
  seen.vars.HOME = '/work'
  const outside = state({ mode: 'flag', jevPaths: '/elsewhere, ~/other/' })
  await gate(seen.$, outside, submit('fix the thing please'), entered())
  expect(seen.fetches).toHaveLength(0)
  await gate(seen.$, state({ mode: 'flag', classifier: 'haiku' }), submit('fix the thing please'), entered())
  expect(seen.fetches).toHaveLength(0)

  const seenText: (string | undefined)[][] = []
  const next = async (e: PromptSubmitInput) => (seenText.push([e.text, ...(e.context ?? [])]), { text: e.text })
  const r = await gate(seen.$, state({ mode: 'flag', jevPaths: '~/proj/,/x' }), { ...submit('fix the thing please'), context: ['earlier'] }, next)
  expect(r.drop).toBeUndefined()
  expect(seen.fetches).toHaveLength(1)
  expect(seenText).toEqual([['fix the thing please', 'earlier', 'prompt-gate: this prompt may be too vague to act on. If so, ask the user: Which file?']])

  seen.cwd = '/work/projects'
  await gate(seen.$, state({ mode: 'flag', jevPaths: '~/proj' }), submit('fix the thing please'), entered())
  expect(seen.fetches).toHaveLength(1)

  const log = await records(seen.$)
  expect(log.at(-1)).toMatchObject({ mode: 'flag', verdict: 'vague', path: 'haiku', jev: null })
  expect(log.find((x) => x.path === 'cascade')).toMatchObject({ verdict: 'vague', bounced: false, jev: 0.9, jevIn: 600, jevOut: 40 })
  expect(JSON.stringify(log)).not.toMatch(new RegExp(`${KEY}|thing`))
})

test('dry mode lets the prompt in before any Jev or Haiku call, asks both once, and logs the cascade with agreement; an unreadable HOME or cwd under jevPaths skips Jev', async (_$, on) => {
  const clock = mock.clock(on)
  const seen = world('{"verdict":"vague","ask":"Which file?"}', clock)
  seen.vars.TYPESAFE_API_KEY = KEY
  seen.jev.body = answer(0.9)
  const order: string[] = []
  const fetch = seen.$.http.fetch.bind(seen.$.http)
  const complete = seen.$.model.complete.bind(seen.$.model)
  Object.assign(seen.$.http, { fetch: (...a: Parameters<typeof fetch>) => (order.push('jev'), fetch(...a)) })
  Object.assign(seen.$.model, { complete: (...a: Parameters<typeof complete>) => (order.push('haiku'), complete(...a)) })
  const next = async (e: PromptSubmitInput) => (order.push('next'), { text: e.text })
  const s = state()

  await gate(seen.$, s, submit('fix the thing please'), next)
  expect(order).toEqual(['next'])
  await clock.advance(0)
  expect(order[0]).toBe('next')
  expect(order.slice(1).sort()).toEqual(['haiku', 'jev'])
  expect(seen.fetches).toHaveLength(1)
  expect(seen.calls).toBe(1)

  seen.reply = '{"verdict":"clear","ask":""}'
  await gate(seen.$, s, submit('fix the other thing please'), next)
  await clock.advance(0)
  const log = await records(seen.$)
  expect(log).toMatchObject([
    { path: 'cascade', jev: 0.9, agree: true },
    { path: 'cascade', jev: 0.9, agree: false },
  ])

  for (const broken of ['env', 'cwd'] as const) {
    const w = world('{"verdict":"clear","ask":""}', clock)
    w.vars.TYPESAFE_API_KEY = KEY
    w.jev.body = answer(0.9)
    if (broken === 'env') Object.assign(w.$.env, { get: async (k: string) => (k === 'HOME' ? Promise.reject(new Error('no home')) : w.vars[k]) })
    else Object.assign(w.$.session, { cwd: async () => Promise.reject(new Error('no cwd')) })
    await gate(w.$, state({ jevPaths: '~/proj' }), submit('fix the thing please'), entered())
    await clock.advance(0)
    expect(w.fetches).toHaveLength(0)
    expect(await records(w.$)).toMatchObject([{ path: 'haiku', jev: null }])
  }
})

test('dry mode returns the prompt while the classifier is still pending, and records once it settles', async (_$, on) => {
  const clock = mock.clock(on)
  const seen = world('', clock)
  let finish!: (r: unknown) => void
  Object.assign(seen.$.model, { complete: () => new Promise((res) => (finish = res)) })
  const r = await gate(seen.$, state(), submit('fix the thing please'), entered())
  expect(r).toEqual({ text: 'fix the thing please' })
  await clock.advance(0)
  expect(await records(seen.$)).toHaveLength(0)
  finish({ isAnswered: true, text: '{"verdict":"clear","ask":""}', usage: { input_tokens: 1, output_tokens: 1 } })
  await clock.advance(0)
  expect(await records(seen.$)).toMatchObject([{ verdict: 'clear', mode: 'dry' }])
})

test('vocabulary read in a directory outside jevPaths is not sent to Jev, but still goes to Haiku', async () => {
  const seen = world('{"verdict":"clear","ask":""}')
  seen.vars.TYPESAFE_API_KEY = KEY
  seen.files['AGENTS.md'] = 'SECRETVOCAB'
  seen.jev.body = answer(0.5)
  const s = state({ mode: 'on', jevPaths: '/work' })
  seen.cwd = '/tmp/x'
  await gate(seen.$, s, submit('fix the thing please'), entered())
  expect(seen.fetches).toHaveLength(0)
  seen.cwd = '/work/proj'
  await gate(seen.$, s, submit('fix the other thing please'), entered())
  expect(seen.fetches).toHaveLength(1)
  expect(seen.fetches[0]!.init.body).not.toContain('SECRETVOCAB')
  expect(seen.calls).toBe(2)
})

test('a log write that hangs is given up on at its timer, and the records behind it still land', async () => {
  const seen = world('{"verdict":"clear","ask":""}')
  const get = seen.$.store.get
  let gets = 0
  let sleeps = 0
  Object.assign(seen.$.store, { get: (k: string) => (gets++ === 0 ? new Promise(() => {}) : get(k)) })
  // only the first write's timer runs out; the rest stay pending until aborted
  Object.assign(seen.$.clock, {
    sleep: (_ms: number, o?: { signal?: AbortSignal }) =>
      sleeps++ === 0 ? Promise.resolve() : new Promise<void>((_, rej) => o?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
  })
  const s = state({ mode: 'flag' })
  await gate(seen.$, s, submit('fix the thing please'), entered())
  await gate(seen.$, s, submit('fix the other thing please'), entered())
  expect((await records(seen.$)).map((x) => x.hash)).toEqual([hashText('fix the other thing please')])
})

test('dry mode records the length of the text it judged, after the hooks beneath', async (_$, on) => {
  const clock = mock.clock(on)
  const seen = world('{"verdict":"clear","ask":""}', clock)
  await gate(seen.$, state(), submit('fix the thing please'), async (e) => ({ text: `${e.text} in src/app.ts` }))
  await clock.advance(0)
  expect(await records(seen.$)).toMatchObject([{ len: 'fix the thing please in src/app.ts'.length }])
})
