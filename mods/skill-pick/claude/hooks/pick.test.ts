import type { EngineInterface as Engine, PromptSubmitInput } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { addListing, jevBody, jevNames, jevSaysNone, lastRecords, mergeNames, parseConfig, parseJev, summary, type Config, type PickRec, type Rec, type State, type UseRec } from './pick'
import { hashText } from './shared/hash'
import { pathAllowed } from './shared/paths'
import { choose, register, used } from './register'

// Driven directly with a hand-built `$`; register.test.ts runs the real plugin through the kit.
const submit = (text: string, origin: PromptSubmitInput['origin'] = { kind: 'composer' }): PromptSubmitInput => ({ text, wait: false, origin })

const LISTING = '- commit: Write a commit message\n- review: Review a diff\n- deploy: Ship it'

const state = (o: Record<string, unknown> = {}, listing: string | null = LISTING): State => {
  const s: State = { ...parseConfig({ mode: 'dry', ...o }), listings: [], last: [], pending: null }
  if (listing) addListing(s, listing)
  return s
}

// The test's `$` carries only the event calls, so the nouns the hook uses are stood in for here.
function world(first: string) {
  const store = new Map<string, unknown>()
  const seen = {
    calls: 0, reply: first, timers: [] as (() => void)[], now: 0, prompt: undefined as unknown, $: null as unknown as Engine,
    key: undefined as string | undefined, cwd: '/w/proj', http: [] as { url: string; init: { headers: Record<string, string>; body: string } }[],
    scores: {} as Record<string, number>, choice: {} as Record<string, number>, jev: 'ok' as 'ok' | 'throw' | 'http500' | 'garbled' | 'missing' | 'range' | 'hang',
  }
  seen.$ = {
    clock: {
      now: async () => (seen.now += 5),
      after: (_ms: number, fn: () => void) => (seen.timers.push(fn), { cancel: () => {} }),
      sleep: (_ms: number, o?: { signal?: AbortSignal }) =>
        seen.jev === 'hang' ? Promise.resolve() : new Promise<void>((_, rej) => o?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    },
    env: { get: async (n: string) => (n === 'TYPESAFE_API_KEY' ? seen.key : n === 'HOME' ? '/h' : undefined) },
    session: { cwd: async () => seen.cwd },
    http: {
      fetch: (url: string, init: { headers: Record<string, string>; body: string }) => {
        seen.http.push({ url, init })
        if (seen.jev === 'throw') return Promise.reject(new Error('net'))
        if (seen.jev === 'hang') return new Promise(() => {})
        const qs = Object.entries((JSON.parse(init.body) as { questions: Record<string, { type: string; criteria?: object }> }).questions)
        const answers = Object.fromEntries(
          qs
            .filter(([n]) => seen.jev !== 'missing' || n !== 'deploy')
            .map(([n, q]) =>
              q.type === 'choice'
                ? [n, { type: 'choice', choice: 'x', confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria ?? {}).map((o) => [o, seen.choice[o] ?? (o === 'none of these' ? 0 : 0.3)])) }]
                : [n, { type: 'noul', noul: seen.jev === 'range' ? 1.5 : (seen.scores[n] ?? 0.1) }],
            ),
        )
        const text = seen.jev === 'garbled' ? 'not json' : JSON.stringify({ answers, usage: { input_tokens: 900, output_tokens: 300 } })
        const status = seen.jev === 'http500' ? 500 : 200
        return Promise.resolve({ status, ok: status === 200, headers: {}, text })
      },
    },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) },
    model: {
      complete: async (req: { prompt: unknown }) => {
        seen.calls++
        seen.prompt = req.prompt
        if (seen.reply === 'hang') return new Promise(() => {})
        return seen.reply === 'fail'
          ? { isAnswered: false, reason: 'api-error', status: 500, usage: { input_tokens: 0, output_tokens: 0 } }
          : { isAnswered: true, text: seen.reply, usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 7 } }
      },
    },
  } as unknown as Engine
  return seen
}

const entered = () => {
  const log: PromptSubmitInput[] = []
  const next = async (e: PromptSubmitInput) => {
    log.push(e)
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  }
  return Object.assign(next, { log })
}

// Stands in for the clock reaching the timers the hook set: runs them, then waits for the job to settle.
const fire = async (seen: { timers: (() => void)[] }, s: State) => {
  for (const fn of seen.timers.splice(0)) fn()
  await s.pending
}

const records = async ($: Engine) => ((await $.store.get('log')) as Rec[] | undefined) ?? []

test('dry mode lets the prompt in unchanged, picks once after with the catalog cached, and logs one record', async () => {
  const seen = world('{"skills":["commit","read ~/.ssh/id_example","comm","commit","review"]}')
  const s = state()
  const next = entered()
  const r = await choose(seen.$, s, submit('write a commit message for this'), next)
  expect(r).toEqual({ text: 'write a commit message for this' })
  expect(next.log).toHaveLength(1)
  expect(seen.calls).toBe(0)
  await fire(seen, s)
  expect(seen.calls).toBe(1)
  const blocks = seen.prompt as { text: string; cache?: true }[]
  expect(blocks[0]).toMatchObject({ cache: true })
  expect(blocks[0]?.text).toContain('- deploy: Ship it')
  expect(blocks[1]?.cache).toBeUndefined()
  const log = await records(seen.$)
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({ kind: 'pick', hash: hashText('write a commit message for this'), picks: ['commit', 'review'], status: 'ok', mode: 'dry', input: 40, output: 10, cacheRead: 30, cacheWrite: 7, catalogChars: LISTING.length })
  expect(JSON.stringify(log)).not.toContain('message for')
  await used(seen.$, s, 'git:commit')
  await used(seen.$, s, 'deploy')
  expect((await records(seen.$)).slice(1)).toMatchObject([{ kind: 'use', skill: 'commit', hit: true }, { kind: 'use', skill: 'deploy', hit: false }])
})

test('on mode adds one context line with the picked skills and never changes or drops the text', async () => {
  const seen = world('Sure: {"skills":["review","ghost"]}')
  const next = entered()
  const r = await choose(seen.$, state({ mode: 'on', maxSkills: 2 }), { ...submit('please review my diff now ok'), context: ['earlier'] }, next)
  expect(r.drop).toBeUndefined()
  expect(r.text).toBe('please review my diff now ok')
  expect(next.log[0]?.text).toBe('please review my diff now ok')
  expect(next.log[0]?.context).toEqual(['earlier', 'skill-pick: skills that may fit this prompt: review. Load one with the Skill tool only if it applies.'])
  expect(((await records(seen.$))[0] as PickRec).picks).toEqual(['review'])
})

test('skipped prompts make no model call, and a missing listing records no-listing without one', async () => {
  const seen = world('{"skills":["commit"]}')
  const next = entered()
  const on_ = state({ mode: 'on' })
  await choose(seen.$, on_, submit('/compact now please, thanks a lot'), next)
  await choose(seen.$, on_, submit('!ls -la /tmp/somewhere really'), next)
  await choose(seen.$, on_, submit('fix it'), next)
  await choose(seen.$, on_, submit('write a commit message for this', { kind: 'sdk' }), next)
  await choose(seen.$, on_, { ...submit('write a commit message for this'), attachments: [{} as never] }, next)
  await choose(seen.$, state({ mode: 'off' }), submit('write a commit message for this'), next)
  await choose(seen.$, on_, submit('x'.repeat(4001)), next)
  expect(seen.calls).toBe(0)
  expect(next.log).toHaveLength(7)
  expect(await records(seen.$)).toEqual([])
  const r = await choose(seen.$, state({ mode: 'on' }, null), submit('write a commit message for this'), next)
  expect(r).toEqual({ text: 'write a commit message for this' })
  expect(seen.calls).toBe(0)
  expect(await records(seen.$)).toMatchObject([{ kind: 'pick', status: 'no-listing', picks: [], catalogChars: 0 }])
})

test('a model failure, empty reply or bad reply passes the prompt unchanged and logs an error', async () => {
  const seen = world('fail')
  for (const reply of ['fail', '', 'no json here', '{"skills":"commit"}', '{"skills":["commit"]']) {
    seen.reply = reply
    const next = entered()
    const r = await choose(seen.$, state({ mode: 'on' }), submit(`write a commit message now ${reply.length}`), next)
    expect(r).toEqual({ text: `write a commit message now ${reply.length}` })
    expect(next.log[0]?.context).toBeUndefined()
  }
  const log = (await records(seen.$)) as PickRec[]
  expect(log).toHaveLength(5)
  expect(log.every((x) => x.status === 'error' && x.picks.length === 0)).toBe(true)
})

test('the summary reports status counts, picks, top skills, latency, tokens and agreement', () => {
  const c: Config = parseConfig({ mode: 'on', model: 'haiku' })
  const pick = (status: PickRec['status'], ms: number, picks: string[]): PickRec => ({ kind: 'pick', t: 0, hash: 'ab', len: 30, picks, ms, input: 10, output: 5, cacheRead: 8, cacheWrite: 2, mode: 'on', catalogChars: 100, status })
  const use = (skill: string, hit: boolean): UseRec => ({ kind: 'use', t: 0, skill, hit })
  const log: Rec[] = [
    pick('ok', 100, ['commit', 'review']), pick('ok', 200, ['commit']), pick('ok', 300, ['deploy']), pick('none', 400, []),
    pick('error', 500, []), pick('no-listing', 0, []),
    use('commit', true), use('deploy', true), use('lint', false), use('review', true),
  ]
  const text = summary(c, log)
  expect(text).toContain('picks: 6 (ok 3, none 1, error 1, no-listing 1)')
  expect(text).toContain('average picks per ok prompt: 1.3')
  expect(text).toContain('top picked: commit (2), deploy (1), review (1)')
  expect(text).toContain('median 200 ms, p90 400 ms')
  expect(text).toContain('tokens: 60 in, 30 out, 48 cache read, 12 cache write')
  expect(text).toContain('agreement: main model loaded 4 skills, 3 of 4 (75%) were picked')
  expect(lastRecords(log).split('\n')).toHaveLength(5)
})

test('the Jev cascade merges confirmed and Haiku-with-half names by score, caps them, skips Haiku when Jev says none, and stores no key or prompt', async () => {
  const sc = new Map([['a', 0.9], ['b', 0.6], ['c', 0.45], ['d', 0.88], ['e', 0.2]])
  const j = { scores: sc, choice: null }
  expect(mergeNames(j, ['b', 'c', 'e'], 5)).toEqual(['a', 'd', 'b'])
  expect(mergeNames(j, [], 5)).toEqual(['a', 'd'])
  expect(mergeNames(j, ['b'], 2)).toEqual(['a', 'd'])
  expect(pathAllowed('/h/personal/code', '~/personal, /x/', '/h')).toBe(true)
  expect(pathAllowed('/h/personally', '~/personal', '/h')).toBe(false)
  expect(pathAllowed('/x', '/x/', '/h')).toBe(true)
  const seen = world('{"skills":["review","deploy"]}')
  seen.key = 'sk-secret-key'
  seen.scores = { commit: 0.95, review: 0.6, deploy: 0.4 }
  const next = entered()
  const prompt = 'write a commit message for this'
  await choose(seen.$, state({ mode: 'on' }), submit(prompt), next)
  expect(seen.http).toHaveLength(1)
  expect(seen.http[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(seen.http[0]?.init.headers.Authorization).toBe('Bearer sk-secret-key')
  expect(seen.http[0]?.init.body).toContain('Would the skill \'commit\' help with this prompt? The skill: Write a commit message')
  expect(next.log[0]?.context?.[0]).toContain('commit, review.')
  expect(seen.calls).toBe(1)
  seen.scores = { commit: 0.2 }
  await choose(seen.$, state({ mode: 'on' }), submit(prompt), next)
  expect(seen.calls).toBe(1)
  const dry = state({ mode: 'dry' })
  await choose(seen.$, dry, submit(prompt), next)
  await fire(seen, dry)
  expect(seen.calls).toBe(2)
  const log = (await records(seen.$)) as PickRec[]
  expect(log).toMatchObject([
    { picks: ['commit', 'review'], status: 'ok', path: 'cascade', jevIn: 900, jevOut: 300 },
    { picks: [], status: 'none', path: 'cascade' },
    { picks: [], status: 'none', path: 'cascade', jevNames: [], haikuNames: ['review', 'deploy'], agree: false },
  ])
  expect(dry.last).toEqual([])
  expect(JSON.stringify(log)).not.toContain('sk-secret-key')
  expect(JSON.stringify(log)).not.toContain('message for')
})

test('pathAllowed denies when a non-blank list has no usable entry, and allows anywhere when it is blank', () => {
  expect(pathAllowed('/x', '', '/h')).toBe(true)
  expect(pathAllowed('/x', '  ', '/h')).toBe(true)
  expect(pathAllowed('/h/personal', ',', '/h')).toBe(false)
  expect(pathAllowed('/h/personal', ' , ', '/h')).toBe(false)
  expect(pathAllowed('/h/personal', 'personal, ~', undefined)).toBe(false)
})

test('pathAllowed resolves . and .. in the cwd before matching on a segment boundary', () => {
  expect(pathAllowed('/h/personal/../office', '~/personal', '/h')).toBe(false)
  expect(pathAllowed('/h/personal/../../etc', '~', '/h')).toBe(false)
  expect(pathAllowed('/h/personal/./code//x/..', '~/personal', '/h')).toBe(true)
  expect(pathAllowed('/h/office/../personal/code', '~/personal/', '/h')).toBe(true)
  expect(pathAllowed('/a/bc', '/a/b', '/h')).toBe(false)
  expect(pathAllowed('/a/b/x', '/a/b', '/h')).toBe(true)
  expect(pathAllowed('/anything', '/', '/h')).toBe(true)
})

test('pathAllowed treats ~ and ~/ as the home directory and everything below it', () => {
  expect(pathAllowed('/h', '~', '/h')).toBe(true)
  expect(pathAllowed('/h/a/b', '~/', '/h/')).toBe(true)
  expect(pathAllowed('/home2', '~', '/h')).toBe(false)
  expect(pathAllowed('/h/a', '~/a/../b', '/h')).toBe(false)
})

test('a Jev failure falls back to Haiku alone, and the gate, a missing key or one entry make no request', async () => {
  const seen = world('{"skills":["review"]}')
  seen.key = 'sk-secret-key'
  for (const jev of ['throw', 'http500', 'garbled', 'missing', 'range', 'hang'] as const) {
    seen.jev = jev
    const next = entered()
    await choose(seen.$, state({ mode: 'on' }), submit(`write a commit message now ${jev}`), next)
    expect(next.log[0]?.context?.[0]).toContain('may fit this prompt: review.')
  }
  expect(((await records(seen.$)) as PickRec[]).every((r) => r.path === 'jev-fallback' && r.picks[0] === 'review')).toBe(true)
  const quiet = world('{"skills":["review"]}')
  quiet.key = 'sk-secret-key'
  await choose(quiet.$, state({ mode: 'on', jevPaths: '~/personal,/srv' }), submit('write a commit message for this'), entered())
  quiet.key = undefined
  await choose(quiet.$, state({ mode: 'on' }), submit('write a commit message for this'), entered())
  await choose(quiet.$, state({ mode: 'on' }, '- commit: Write a commit message'), submit('write a commit message for this'), entered())
  await choose(quiet.$, state({ mode: 'on', picker: 'haiku' }), submit('write a commit message for this'), entered())
  expect(quiet.http).toHaveLength(0)
  expect(quiet.calls).toBe(4)
  expect(((await records(quiet.$)) as PickRec[]).every((r) => r.path === 'haiku')).toBe(true)
})

test('dry mode lets the prompt in before Jev and Haiku are asked once each and logs both lists; the jev picker skips Haiku; an unreadable HOME or cwd under jevPaths skips Jev', async () => {
  const prompt = 'write a commit message for this'
  const seen = world('{"skills":["commit","review"]}')
  seen.key = 'sk-secret-key'
  seen.scores = { commit: 0.95, review: 0.75, deploy: 0.4 }
  const order: string[] = []
  const fetch = seen.$.http.fetch.bind(seen.$.http)
  const complete = seen.$.model.complete.bind(seen.$.model)
  Object.assign(seen.$.http, { fetch: (...a: Parameters<typeof fetch>) => (order.push('jev'), fetch(...a)) })
  Object.assign(seen.$.model, { complete: (...a: Parameters<typeof complete>) => (order.push('haiku'), complete(...a)) })
  const next = async (e: PromptSubmitInput) => (order.push('next'), { text: e.text })
  const s = state({ maxSkills: 2 })

  await choose(seen.$, s, submit(prompt), next)
  await fire(seen, s)
  expect(order[0]).toBe('next')
  expect(order.slice(1).sort()).toEqual(['haiku', 'jev'])
  expect(seen.http).toHaveLength(1)
  expect(seen.calls).toBe(1)

  seen.reply = '{"skills":["deploy"]}'
  await choose(seen.$, s, submit(prompt), next)
  await fire(seen, s)
  expect(await records(seen.$)).toMatchObject([
    { path: 'cascade', jevNames: ['commit', 'review'], haikuNames: ['commit', 'review'], picks: ['commit', 'review'], agree: true },
    { path: 'cascade', jevNames: ['commit', 'review'], haikuNames: ['deploy'], picks: ['commit', 'review'], agree: false },
  ])

  const only = world('{"skills":["deploy"]}')
  only.key = 'sk-secret-key'
  only.scores = { commit: 0.8, review: 0.95, deploy: 0.6 }
  const n = entered()
  await choose(only.$, state({ mode: 'on', picker: 'jev', maxSkills: 2 }), submit(prompt), n)
  expect(only.calls).toBe(0)
  expect(only.http).toHaveLength(1)
  expect(n.log[0]?.context?.[0]).toContain('review, commit.')
  expect(((await records(only.$)) as PickRec[])[0]).toMatchObject({ path: 'jev', picks: ['review', 'commit'] })

  for (const broken of ['env', 'cwd'] as const) {
    const w = world('{"skills":["review"]}')
    w.key = 'sk-secret-key'
    if (broken === 'env') Object.assign(w.$.env, { get: async (k: string) => (k === 'HOME' ? Promise.reject(new Error('no home')) : k === 'TYPESAFE_API_KEY' ? w.key : undefined) })
    else Object.assign(w.$.session, { cwd: async () => Promise.reject(new Error('no cwd')) })
    await choose(w.$, state({ mode: 'on', jevPaths: '~/personal' }), submit(prompt), entered())
    expect(w.http).toHaveLength(0)
    expect(w.calls).toBe(1)
    expect(((await records(w.$)) as PickRec[]).map((r) => r.path)).toEqual(['haiku'])
  }
})

test('a Noul 0.9 entry with Choice 0 is dropped unless Haiku picked it, and a Noul 0.8 entry with Choice 0.3 is kept', () => {
  const j = { scores: new Map([['x', 0.9], ['y', 0.8], ['z', 0.9]]), choice: new Map([['x', 0], ['y', 0.3], ['z', 0.3], ['none of these', 0.1]]) }
  expect(jevNames(j, 5)).toEqual(['z', 'y'])
  expect(mergeNames(j, [], 5)).toEqual(['z', 'y'])
  expect(mergeNames(j, ['x'], 5)).toEqual(['x', 'z', 'y'])
})

test('Jev says none when the none option wins even if the best Noul is high, or when the best Noul is below 0.5', () => {
  const scores = new Map([['a', 0.95], ['b', 0.9]])
  expect(jevSaysNone({ scores, choice: new Map([['a', 0.1], ['b', 0.2], ['none of these', 0.6]]) })).toBe(true)
  expect(jevSaysNone({ scores, choice: new Map([['a', 0.5], ['b', 0.2], ['none of these', 0.3]]) })).toBe(false)
  expect(jevSaysNone({ scores, choice: null })).toBe(false)
  expect(jevSaysNone({ scores: new Map([['a', 0.4]]), choice: null })).toBe(true)
})

test('parseJev without Choice answers gives choice null and the 0.85 rule; Choice answers are averaged and bad ones are ignored', () => {
  const entries = [{ name: 'a', description: '' }, { name: 'b', description: '' }]
  const noul = { a: { noul: 0.9 }, b: { noul: 0.8 } }
  const bare = parseJev(200, JSON.stringify({ answers: noul }), entries)
  expect(bare?.choice).toBeNull()
  expect(jevNames(bare as NonNullable<typeof bare>, 5)).toEqual(['a'])
  const answers = {
    ...noul,
    _choice1: { probabilities: { a: 0.25, 'none of these': 0.5 } },
    _choice2: { probabilities: { a: 0.75 } },
    _choice3: { probabilities: { a: 2 } },
  }
  const both = parseJev(200, JSON.stringify({ answers }), entries)
  expect(both?.choice).toEqual(new Map([['a', 0.5], ['none of these', 0.25]]))
  expect(parseJev(200, JSON.stringify({ answers: { a: { noul: 0.9 } } }), entries)).toBeNull()
})

test('each Choice question lists every entry once plus the none option, the shuffles differ, and the order is stable per prompt', () => {
  const names = Array.from({ length: 12 }, (_, i) => `skill${i}`)
  const entries = names.map((name) => ({ name, description: 'd'.repeat(200) }))
  const questions = (text: string, es = entries) => (JSON.parse(jevBody(text, es)) as { questions: Record<string, { type: string; criteria: Record<string, string> }> }).questions
  const q = questions('write a commit message')
  const orders = ['_choice1', '_choice2', '_choice3'].map((id) => Object.keys(q[id]?.criteria ?? {}))
  for (const o of orders) {
    expect(o.at(-1)).toBe('none of these')
    expect([...o.slice(0, -1)].sort()).toEqual([...names].sort())
  }
  expect(new Set(orders.map((o) => o.join())).size).toBe(3)
  expect(q._choice1?.criteria.skill0).toHaveLength(150)
  expect(jevBody('write a commit message', entries)).toBe(jevBody('write a commit message', entries))
  const many = Array.from({ length: 121 }, (_, i) => ({ name: `s${i}`, description: 'd' }))
  expect(Object.keys(questions('p', many)).filter((k) => k.startsWith('_choice'))).toEqual(['_choice1'])
})

test('a Choice-only none yields status none and no picks in on, dry and jev modes', async () => {
  for (const o of [{ mode: 'on' }, { mode: 'dry' }, { mode: 'on', picker: 'jev' }]) {
    const seen = world('{"skills":["commit"]}')
    seen.key = 'sk-secret-key'
    seen.scores = { commit: 0.95, review: 0.1, deploy: 0.1 }
    seen.choice = { commit: 0.3, 'none of these': 0.4 }
    const next = entered()
    const s = state(o)
    await choose(seen.$, s, submit('write a commit message for this'), next)
    await fire(seen, s)
    expect(next.log[0]?.context).toBeUndefined()
    expect(await records(seen.$)).toMatchObject([{ status: 'none', picks: [] }])
  }
})

test('a Choice answer of all zeros is not usable, so it neither wins as none nor hides the yes/no matches', async () => {
  const entries = [{ name: 'a', description: '' }, { name: 'b', description: '' }]
  const zero = parseJev(200, JSON.stringify({ answers: { a: { noul: 0.9 }, b: { noul: 0.2 }, _choice1: { probabilities: { a: 0, b: 0 } } } }), entries)
  expect(zero?.choice).toBeNull()
  const seen = world('{"skills":["commit"]}')
  seen.key = 'sk-secret-key'
  seen.scores = { commit: 0.95, review: 0.1, deploy: 0.1 }
  seen.choice = { commit: 0, review: 0, deploy: 0, 'none of these': 0 }
  const next = entered()
  await choose(seen.$, state({ mode: 'on' }), submit('write a commit message for this'), next)
  expect(next.log[0]?.context?.[0]).toContain('may fit this prompt: commit.')
  expect(await records(seen.$)).toMatchObject([{ status: 'ok', picks: ['commit'], path: 'cascade' }])
})

test('a skill named choice1 keeps its Noul answer, and a Choice answer with only unknown keys leaves choice null', () => {
  const entries = [{ name: 'choice1', description: '' }, { name: 'b', description: '' }]
  const noul = { choice1: { noul: 0.9 }, b: { noul: 0.8 } }
  const ok = parseJev(200, JSON.stringify({ answers: { ...noul, _choice1: { probabilities: { choice1: 0.6, ghost: 0.4 } } } }), entries)
  expect(ok?.scores.get('choice1')).toBe(0.9)
  expect(ok?.choice).toEqual(new Map([['choice1', 0.6]]))
  const bad = parseJev(200, JSON.stringify({ answers: { ...noul, _choice1: { probabilities: { ghost: 1 } } } }), entries)
  expect(bad?.choice).toBeNull()
})

test('dry mode returns the prompt before a classifier that never answers; pending stays open only while the job runs', async () => {
  const seen = world('hang')
  const s = state()
  const r = await choose(seen.$, s, submit('write a commit message for this'), entered())
  expect(r).toEqual({ text: 'write a commit message for this' })
  expect(seen.calls).toBe(0)
  expect(seen.timers).toHaveLength(1)
  let ended = false
  void s.pending?.then(() => (ended = true))
  for (const fn of seen.timers.splice(0)) fn()
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(seen.calls).toBe(1)
  expect(ended).toBe(false)
  expect(await records(seen.$)).toEqual([])
})

test('mode off records no use and captures no listing', async () => {
  const hooks: Record<string, (...a: never[]) => unknown> = {}
  const on = ((ev: string, a: unknown, b?: unknown) => {
    hooks[typeof a === 'function' ? ev : `${ev}:${JSON.stringify(a)}`] = (typeof a === 'function' ? a : b) as (...x: never[]) => unknown
    return { catch: () => undefined }
  }) as never
  register(on, { mode: 'off' })
  const seen = world('{"skills":["commit"]}')
  const next = async (e: unknown) => e
  const listing = hooks['prompt.attachment:{"type":"skill_listing"}'] as unknown as (...a: unknown[]) => unknown
  const skill = hooks['tool.call:{"tool":"Skill"}'] as unknown as (...a: unknown[]) => unknown
  await listing(seen.$, { text: LISTING }, next)
  await skill(seen.$, { skill: 'commit' }, next)
  expect(seen.timers).toEqual([])
  await Promise.resolve()
  expect(await records(seen.$)).toEqual([])
})

test('a Jev none over a catalog cut to 200 entries does not hide a skill outside the scored subset', async () => {
  const listing = Array.from({ length: 201 }, (_, i) => `- s${i}: skill number ${i}`).join('\n')
  const seen = world('{"skills":["s200","s3"]}')
  seen.key = 'sk-secret-key'
  const next = entered()
  await choose(seen.$, state({ mode: 'on' }, listing), submit('write a commit message for this'), next)
  expect(seen.calls).toBe(1)
  expect(next.log[0]?.context?.[0]).toContain('may fit this prompt: s200.')
})

test('dry mode records the length of the text it judged, after the hooks beneath', async () => {
  const seen = world('{"skills":["commit"]}')
  const s = state()
  await choose(seen.$, s, submit('write a commit message for this'), async (e) => ({ text: `${e.text} in src/app.ts` }))
  await fire(seen, s)
  expect(await records(seen.$)).toMatchObject([{ kind: 'pick', len: 'write a commit message for this in src/app.ts'.length }])
})
