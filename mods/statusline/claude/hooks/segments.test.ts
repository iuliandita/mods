import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import type { Part, Style, View } from './segments'
import {
  absorbChunk, bar, buildRows, cacheFrom, clean, effectiveWindow, emptyTranscript, fmtTokens, humanize, ICONS, kubeFromTexts, levelColor, modelName,
  noctaliaPalette, PALETTES, parseConfig, parseGhCounts, parseGhPr, parseGlabMr, parseKubectl, parseNumstat, parsePorcelain,
  parseRemote, parseWorktree, partWidth, pickTheme, plain, providerFor, roundEven, systemDark,
} from './segments'

const NOW = Date.parse('2026-01-01T00:00:00Z')
const H = 3600_000
const neutral = (tick = '┃'): Style => ({ P: PALETTES.neutral, glyph: ICONS.unicode, tick, noColor: false })

test('config: defaults (forge on), every option, and out-of-range refresh', () => {
  expect(parseConfig({})).toEqual({ mode: 'on', rows: 2, forge: true, forgeHosts: {}, icons: 'unicode', theme: 'auto', refreshMs: 30_000, ctxWindow: 'auto' })
  expect(parseConfig({ mode: 'off', rows: '1', forge: 'off', forgeHosts: 'git.example.com=gitlab, x=bogus', icons: 'nerd', theme: 'dark', refreshSeconds: 1, ctxWindow: 'full' })).toEqual({ mode: 'off', rows: 1, forge: false, forgeHosts: { 'git.example.com': 'gitlab' }, icons: 'nerd', theme: 'dark', refreshMs: 5_000, ctxWindow: 'full' })
  for (const [secs, ms] of [['x', 30_000], [99_999, 3_600_000], [45, 45_000]] as const) expect(parseConfig({ refreshSeconds: secs }).refreshMs).toBe(ms)
})

test('numbers and text as the script prints them', () => {
  for (const [s, out] of [[0, '0m'], [-5, '0m'], [190, '3m'], [4980, '1h23m'], [432_030, '5d0h']] as const) expect(humanize(s)).toBe(out)
  for (const [n, out] of [[999, '999'], [2500, '2k'], [3500, '4k'], [126_000, '126k'], [1_000_000, '1.0M']] as const) expect(fmtTokens(n)).toBe(out)
  expect([roundEven(2.5), roundEven(3.5), roundEven(-4.5), roundEven(8.82)]).toEqual([2, 4, -4, 9])
  for (const [id, out] of [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'], ['claude-opus-4-6[1m]', 'Opus 4.6'], ['Opus 5.5', 'Opus 5.5']] as const) expect(modelName(id)).toBe(out)
  expect(clean(['a', String.fromCharCode(0x1b), '[31mb', String.fromCharCode(0x202e), 'c'].join(''))).toBe('a[31mbc')
})

test('git: porcelain v2, numstat and the linked worktree', () => {
  const out = ['# branch.oid 1234567890abcdef', '# branch.head feat/x', '# branch.ab +1 -2', '1 M. N... 100644 100644 100644 a b f1', '1 .M N... 100644 100644 100644 a b f2', '2 RM N... 100644 100644 100644 a b R100 f3\tf0', 'u UU N... 1 2 3 4 a b c f4', '? new.txt'].join('\n')
  expect(parsePorcelain(out, false)).toEqual({ branch: 'feat/x', oid: '1234567', ahead: 1, behind: 2, staged: 2, modified: 2, untracked: 1, conflicts: 1 })
  expect(parsePorcelain(out, true).untracked).toBeNull()
  expect(parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n10\t0\tb.ts\n')).toEqual({ added: 13, removed: 1 })
  expect(parseWorktree('/w/feature\n/r/.git/worktrees/feature\n/r/.git\n')).toBe('feature')
  expect(parseWorktree('/r\n/r/.git\n.git\n')).toBeNull()
})

test('forge: remotes, trusted hosts, and gh and glab output', () => {
  expect(parseRemote('github.com:owner/repo.git')).toEqual({ host: 'github.com', path: 'owner/repo' })
  expect(parseRemote('https://gitlab.com/group/sub/proj')).toEqual({ host: 'gitlab.com', path: 'group/sub/proj' })
  expect(parseRemote('ssh://git@host.example:2222/a/b.git')).toEqual({ host: 'host.example', path: 'a/b' })
  for (const bad of ['/srv/repo.git', './x', 'github.com:../x', '-oProxy=x:a/b']) expect(parseRemote(bad)).toBeNull()
  expect([providerFor('github.com', {}), providerFor('git.example.com', {}), providerFor('git.example.com', { 'git.example.com': 'gitlab' })]).toEqual(['github', null, 'gitlab'])
  expect(parseGhCounts('{"data":{"repository":{"pullRequests":{"totalCount":0},"issues":{"totalCount":12}}}}')).toEqual({ prs: 0, issues: 12 })
  expect(() => parseGhCounts('{"data":{"repository":null}}')).toThrow()
  expect(parseGhPr('[{"number":12,"isDraft":false,"reviewDecision":"APPROVED"}]')).toEqual({ number: 12, kind: 'pr', state: 'approved' })
  expect(parseGhPr('[{"number":3,"isDraft":true}]')?.state).toBe('draft')
  expect(parseGhPr('[]')).toBeNull()
  expect(parseGlabMr('[{"iid":87,"draft":false}]')).toEqual({ number: 87, kind: 'mr', state: 'pending' })
})

test('kube: kubectl output and the kubeconfig text fallback', () => {
  expect(parseKubectl('{"contexts":[{"name":"lab","context":{"namespace":"apps"}}]}')).toEqual({ ctx: 'lab', ns: 'apps' })
  const cfg = ['apiVersion: v1', 'contexts:', '- context:', '    cluster: c1', '    namespace: web', '  name: prod-eu', '- name: lab', '  context:', '    cluster: c2', 'current-context: "prod-eu"', 'kind: Config'].join('\n')
  expect(kubeFromTexts([cfg])).toEqual({ ctx: 'prod-eu', ns: 'web' })
  expect(kubeFromTexts([cfg.replace('"prod-eu"', 'lab')])).toEqual({ ctx: 'lab', ns: '' })
  expect(kubeFromTexts(['kind: Config'])).toEqual({ ctx: '', ns: '' })
})

test('transcript: folded incrementally into effort, title, fast mode, cache and lines', () => {
  const s = emptyTranscript()
  const usage = (read: number, create: number, extra: object = {}) => ({ input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: create, ...extra })
  const lines = [
    { type: 'ai-title', aiTitle: 'first' },
    { type: 'assistant', effort: 'high', timestamp: '2026-01-01T00:00:00Z', message: { id: 'm1', usage: usage(0, 1000, { cache_creation: { ephemeral_1h_input_tokens: 1000 } }) } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { id: 'm1', usage: usage(0, 1000) } },
    { type: 'assistant', timestamp: '2026-01-01T00:01:00Z', message: { id: 'm2', usage: usage(0, 500, { speed: 'fast' }) } },
    { type: 'custom-title', customTitle: 'refactor auth' },
    { type: 'user', toolUseResult: { structuredPatch: [{ lines: ['+a', '+b', '-c', ' d'] }] } },
    { type: 'user', toolUseResult: { type: 'create', content: 'x\ny\nz\n' } },
  ].map((l) => JSON.stringify(l))
  const chunk = `${lines.join('\n')}\nnot json\n{"type":"assistant","half`
  const used = absorbChunk(s, chunk)
  expect(used).toBe(chunk.length - '{"type":"assistant","half'.length)
  expect(absorbChunk(emptyTranscript(), 'é\n')).toBe(3)
  expect(s).toMatchObject({ title: 'refactor auth', effort: 'high', fast: true, ttl: 3600, requests: 2, read: 0, create: 1500, input: 20, misses: 1, added: 5, removed: 1 })
  expect(cacheFrom(s, Date.parse('2026-01-01T00:30:00Z'))).toEqual({ observed: true, warm: true, expiresAt: Date.parse('2026-01-01T01:01:00Z'), requests: 2, misses: 1, hit: 0 })
  expect(cacheFrom(emptyTranscript(), NOW)).toBeNull()
})

test('theme: the script picks explicit, COLORFGBG, the Desktop app, then neutral; palettes and ramps', () => {
  const h = { env: null, terminalEnv: null, colorFgBg: null, desktopMode: null, systemDark: null }
  const ok = (t: string) => ['dark', 'light', 'neutral'].includes(t)
  expect(pickTheme('terminal', h, ok)).toBe('neutral')
  expect(pickTheme('terminal', { ...h, terminalEnv: 'dark' }, ok)).toBe('dark')
  expect(pickTheme('desktop', { ...h, terminalEnv: 'dark' }, ok)).toBe('neutral')
  expect(pickTheme('terminal', { ...h, colorFgBg: '0;15' }, ok)).toBe('light')
  expect(pickTheme('desktop', { ...h, desktopMode: 'system', systemDark: true }, ok)).toBe('dark')
  expect([systemDark("'prefer-dark'"), systemDark('(<<uint32 2>>,)'), systemDark('')]).toEqual([true, false, null])
  const ghostty = ['background = #101020', 'palette = 1=#ff0000', 'palette = 2=#00ff00', 'palette = 3=#ffff00', 'palette = 4=#8080ff'].join('\n')
  expect(noctaliaPalette(ghostty)).toMatchObject({ PINK: [255, 0, 0], MINT: [0, 255, 0], INK: [16, 16, 32], DIM: [100, 100, 199] })
  expect(noctaliaPalette('background = #000000')).toBeNull()
  expect([levelColor(PALETTES.dark, 40), levelColor(PALETTES.dark, 75), levelColor(PALETTES.dark, 100)]).toEqual([PALETTES.dark.MINT, PALETTES.dark.YELLOW, PALETTES.dark.PINK])
  const b = bar({ ...neutral(), P: PALETTES.dark }, 50, 4, 1, null)
  expect(b.map((x) => [x.t, x.fg ?? null, !!x.bold])).toEqual([['━', '#9bfece', false], ['┃', null, true], ['─', '#6466ac', false], ['─', '#6466ac', false]])
  expect(bar(neutral(), 50, 2).map((x) => x.faint ?? false)).toEqual([false, true])
})

// ---- parity with the reference script ----
// Expected rows: the script run with the same data (COLUMNS set, STATUSLINE_ICONS=unicode, STATUSLINE_FORGE=0,
// no kubeconfig), its ANSI stripped. The script lays lines out in row 2; the mod's linesRow 2 reproduces that.

const fullRepo: View = {
  now: NOW,
  model: 'Opus 5.5',
  effort: 'high',
  fast: true,
  cwd: '/work/repo',
  worktree: null,
  git: { branch: 'feat/x', oid: 'abc1234', ahead: 0, behind: 0, staged: 1, modified: 2, untracked: 3, conflicts: 0 },
  kube: null,
  pr: null,
  agent: 'reviewer',
  sessionName: 'refactor auth',
  outputStyle: 'Explanatory',
  vim: null,
  forge: null,
  context: { tokens: 126_000, window: 200_000, percent: 63 },
  limits: [{ kind: 'five_hour', percentUsed: 36, resetsAt: new Date(NOW + 3 * H + 30_000).toISOString() }, { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + 120 * H + 30_000).toISOString() }],
  costUsd: 3.42,
  durationMs: 4_980_000,
  apiMs: 1_620_000,
  cache: { observed: true, hit: 0.94, requests: 10, misses: 2, warm: true, expiresAt: NOW + 190_000 },
  lines: { added: 412, removed: 87, session: true },
  failed: [],
}
const fullPlain: View = { ...fullRepo, cwd: '/work/plain', git: null }
const leanPlain: View = {
  ...fullPlain, model: 'Sonnet 4.5', effort: null, fast: false, agent: null, sessionName: null, outputStyle: null,
  context: { tokens: 184_000, window: 200_000, percent: 92 }, limits: [{ kind: 'five_hour', percentUsed: 60, resetsAt: new Date(NOW + 3 * H + 30_000).toISOString() }],
  costUsd: 0.5, durationMs: 30_000, apiMs: 0, cache: null, lines: null,
}

const SCRIPT: [string, View, number, string, string[]][] = [
  ['full-repo', fullRepo, 200, '┃', ['◆ Opus 5.5  ▰▰▰▱▱ │ ⚡ │ repo │  feat/x  +1 ~2 ?3 │ @reviewer │ refactor auth │ ✎ Explanatory', 'ctx ━━━━━━━━━───── 63% 126k/200k │ 5h ━━━┃────── 36% (-4) ↻3h00m │ 7d ━─┃─────── 12% (-17) ↻5d0h │ cache 94% 3m ⊘2 │ $3.42 │ 1h23m/27m │ +412 -87']],
  ['full-repo', fullRepo, 124, '┃', ['◆ Opus 5.5  ▰▰▰▱▱ │ ⚡ │ repo │  feat/x  +1 ~2 ?3 │ @reviewer │ refactor auth │ ✎ Explanatory', 'ctx ━━━━━━──── 63% 126k/200k │ 5h ━━┃─── 36% (-4) │ 7d ━┃──── 12% (-17) │ cache 94% 3m ⊘2 │ $3.42 │ 1h23m/27m │ +412 -87']],
  ['desktop-full-repo', fullRepo, 124, '●', ['◆ Opus 5.5  ▰▰▰▱▱ │ ⚡ │ repo │  feat/x  +1 ~2 ?3 │ @reviewer │ refactor auth │ ✎ Explanatory', 'ctx ━━━━━━──── 63% 126k/200k │ 5h ━━●─── 36% (-4) │ 7d ━●──── 12% (-17) │ cache 94% 3m ⊘2 │ $3.42 │ 1h23m/27m │ +412 -87']],
  ['full-repo', fullRepo, 84, '┃', ['◆ Opus 5.5  ▰▰▰▱▱ │ ⚡ │ repo │  feat/x  +1 ~2 ?3 │ @reviewer │ ✎ Explanatory', 'ctx 63% │ 5h ━┃── 36% │ 7d ━┃── 12% │ cache 94% 3m ⊘2 │ $3.42 │ 1h23m │ +412 -87']],
  ['full-repo', fullRepo, 60, '┃', ['◆ Opus 5.5  ▰▰▰▱▱ │ ⚡ │ repo │  feat/x  │ @reviewer', 'ctx 63% │ 5h ━┃── 36% │ 7d ━┃── 12% │ cache 94% 3m ⊘2']],
  ['full-plain', fullPlain, 200, '┃', ['◆ Opus 5.5  ▰▰▰▱▱ │ ⚡ │ plain │ @reviewer │ refactor auth │ ✎ Explanatory', 'ctx ━━━━━━━━━───── 63% 126k/200k │ 5h ━━━┃────── 36% (-4) ↻3h00m │ 7d ━─┃─────── 12% (-17) ↻5d0h │ cache 94% 3m ⊘2 │ $3.42 │ 1h23m/27m │ +412 -87']],
  ['full-plain', fullPlain, 84, '┃', ['◆ Opus 5.5  ▰▰▰▱▱ │ ⚡ │ plain │ @reviewer │ refactor auth │ ✎ Explanatory', 'ctx 63% │ 5h ━┃── 36% │ 7d ━┃── 12% │ cache 94% 3m ⊘2 │ $3.42 │ 1h23m │ +412 -87']],
  ['full-plain', fullPlain, 60, '┃', ['◆ Opus 5.5  ▰▰▰▱▱ │ ⚡ │ plain │ @reviewer', 'ctx 63% │ 5h ━┃── 36% │ 7d ━┃── 12% │ cache 94% 3m ⊘2']],
  ['lean-plain', leanPlain, 124, '┃', ['◆ Sonnet 4.5 │ plain', 'ctx ━━━━━━━━━━━━━─ 92% 184k/200k │ 5h ━━━┃━━──── 60% (+20) ↻3h00m ▲1h19m │ $0.50']],
  ['lean-plain', leanPlain, 60, '┃', ['◆ Sonnet 4.5 │ plain', 'ctx ━━━━━━ 92% │ 5h ━━━┃━─── 60% (+20) ▲1h19m │ $0.50']],
]

// The owner's symbol changes, the only intended differences from the script's text: a ⎇ before the branch,
// ◔ for the word cache, and w (warm) or c (cold) after its percentage in place of the word cold.
const symbolize = (row: string): string => row.replace(' feat/x ', ' ⎇ feat/x ').replace('cache 94% 3m', '◔ 94% w 3m')
// `◔ 94% w` is two cells narrower than `cache 94%`; the same fitting then hands the freed cells on: at 124
// columns the 5h bar takes its next richer form, and at 60 the cost fits. Only these rows move.
const WIDTH_EFFECT: Record<string, string> = {
  'full-repo@124 row 2': 'ctx ━━━━━━──── 63% 126k/200k │ 5h ━━━┃──── 36% (-4) │ 7d ━┃──── 12% (-17) │ ◔ 94% w 3m ⊘2 │ $3.42 │ 1h23m/27m │ +412 -87',
  'desktop-full-repo@124 row 2': 'ctx ━━━━━━──── 63% 126k/200k │ 5h ━━━●──── 36% (-4) │ 7d ━●──── 12% (-17) │ ◔ 94% w 3m ⊘2 │ $3.42 │ 1h23m/27m │ +412 -87',
  'full-repo@60 row 2': 'ctx 63% │ 5h ━┃── 36% │ 7d ━┃── 12% │ ◔ 94% w ⊘2 │ $3.42',
  'full-plain@60 row 2': 'ctx 63% │ 5h ━┃── 36% │ 7d ━┃── 12% │ ◔ 94% w ⊘2 │ $3.42',
}

test('parity: the script layout gives the script text, row for row, at every width', () => {
  const diffs: string[] = []
  for (const [name, v, cols, tick, rows] of SCRIPT) {
    const got = buildRows(neutral(tick), v, cols, 2, 2).map(plain)
    rows.map(symbolize).forEach((want, i) => {
      const key = `${name}@${cols} row ${i + 1}`
      if (got[i] !== (WIDTH_EFFECT[key] ?? want)) diffs.push(`${key}: ${got[i]}`)
    })
  }
  expect(diffs).toEqual([])
})

// The same shape as a person's settings with a reduced window: a top-level value and per-model overrides.
const WINDOWS_SET = {
  autoCompactWindow: 512_000,
  modelSettings: {
    'claude-opus-5-5': { effortLevel: 'medium', autoCompactWindow: 512_000 },
    'claude-haiku-5-5': { autoCompactWindow: 256_000 },
    'claude-fable-5-1': { autoCompactWindow: 768_000 },
    'claude-opus-5': { effortLevel: 'high' },
    'claude-tiny-1': { autoCompactWindow: 'auto' },
  },
}

test('the auto-compact window: env, per-model (exact, [1m], dated), top-level, auto, capped, unset, full', () => {
  const win = (model: string | null, settings: Record<string, unknown> = WINDOWS_SET, engineWindow = 1_000_000, env: string | null = null, mode: 'auto' | 'full' = 'auto') => effectiveWindow({ mode, engineWindow, model, settings, env })
  const cases: [string, number, number][] = [
    ['top-level only', win('claude-other-1', { autoCompactWindow: 512_000 }), 512_000],
    ['per-model override', win('claude-haiku-5-5'), 256_000],
    ['bracket suffix', win('claude-fable-5-1[1m]'), 768_000],
    ['dated id, longest key', win('claude-opus-5-5-20260901'), 512_000],
    ['entry without a window', win('claude-opus-5'), 512_000],
    ['per-model auto', win('claude-tiny-1'), 1_000_000],
    ['unset', win('claude-other-1', {}), 1_000_000],
    ['out of range ignored', win('claude-other-1', { autoCompactWindow: 50 }), 1_000_000],
    ['larger than the model', win('claude-fable-5-1', WINDOWS_SET, 200_000), 200_000],
    ['env first', win('claude-haiku-5-5', WINDOWS_SET, 1_000_000, '300000'), 300_000],
    ['option full', win('claude-haiku-5-5', WINDOWS_SET, 1_000_000, '300000', 'full'), 1_000_000],
  ]
  for (const [name, got, want] of cases) expect([name, got]).toEqual([name, want])
})

test('ctx against a reduced window: share and denominator, >200k kept, over 100% in the error colour', () => {
  const st = { ...neutral(), P: PALETTES.dark }
  const ctxRow = (context: View['context']) => buildRows(st, { ...leanPlain, context }, 200)[1] ?? []
  expect(plain(ctxRow({ tokens: 340_000, window: 1_000_000, percent: 34 }))).toContain('34% 340k/1.0M >200k')
  const reduced = ctxRow({ tokens: 340_000, window: 1_000_000, percent: 34, limit: 512_000 })
  expect(plain(reduced)).toContain('ctx ━━━━━━━━━───── 66% 340k/512k >200k')
  // Coloured by the reduced figure: 66% is already on the way to yellow, where 34% would be plain green.
  expect(reduced.find((sp) => sp.t === '66%')?.fg).toBe('#ddf8ad')
  expect(ctxRow({ tokens: 340_000, window: 1_000_000, percent: 34 }).find((sp) => sp.t === '34%')?.fg).toBe('#9bfece')
  const over = ctxRow({ tokens: 532_480, window: 1_000_000, percent: 53, limit: 512_000 })
  expect(plain(over)).toContain('ctx ━━━━━━━━━━━━━━ 104% 532k/512k >200k')
  expect(over.find((sp) => sp.t === '104%')).toEqual({ t: '104%', fg: '#fd4663', bold: true })
})

// The script's rows with a 150k window in place of the 200k model window: only the ctx segment changes, and it
// keeps its width, so the rest of each row is the script's.
test('parity with a reduced window: the script rows with the ctx segment against 150k', () => {
  const v: View = { ...fullRepo, context: { ...(fullRepo.context ?? { window: 0 }), limit: 150_000 } }
  const cases: [number, string, string][] = [
    [200, 'ctx ━━━━━━━━━───── 63% 126k/200k', 'ctx ━━━━━━━━━━━━── 84% 126k/150k'],
    [124, 'ctx ━━━━━━──── 63% 126k/200k', 'ctx ━━━━━━━━── 84% 126k/150k'],
    [84, 'ctx 63%', 'ctx 84%'],
  ]
  for (const [cols, script, mod] of cases) {
    const row = SCRIPT.find(([name, , c]) => name === 'full-repo' && c === cols)?.[4][1] ?? ''
    const want = (WIDTH_EFFECT[`full-repo@${cols} row 2`] ?? symbolize(row)).replace(script, mod)
    expect(plain(buildRows(neutral(), v, cols, 2, 2)[1] ?? [])).toBe(want)
  }
})

test("the owner's layout: lines beside git in row 1, dropped after the forge counts and before git", () => {
  const v: View = { ...fullRepo, forge: { provider: 'github', prs: 0, issues: 12, capped: false, stale: false }, pr: { number: 12, kind: 'pr', state: 'approved' } }
  const [one = '', two = ''] = buildRows(neutral(), v, 200).map(plain)
  expect(one).toBe('◆ Opus 5.5  ▰▰▰▱▱ │ ⚡ │ repo │  ⎇ feat/x  +1 ~2 ?3 │ +412 -87 │ #12 ✓ │ @reviewer │ refactor auth │ ✎ Explanatory │ ⑂ 0 ⊙ 12')
  expect(two).toBe('ctx ━━━━━━━━━───── 63% 126k/200k │ 5h ━━━┃────── 36% (-4) ↻3h00m │ 7d ━─┃─────── 12% (-17) ↻5d0h │ ◔ 94% w 3m ⊘2 │ $3.42 │ 1h23m/27m')
  const gone = (needle: string) => {
    for (let cols = 200; cols > 20; cols--) if (!plain(buildRows(neutral(), v, cols)[0] ?? []).includes(needle)) return cols
    return 0
  }
  expect(gone('⑂')).toBeGreaterThan(gone('+412'))
  expect(gone('+412')).toBeGreaterThan(gone('feat/x'))
  for (const cols of [30, 50, 80, 120]) for (const r of buildRows(neutral(), v, cols)) expect(partWidth(r)).toBeLessThanOrEqual(cols - 4)
})

test('symbols instead of words, in both icon sets, for worktree, branch, kube, PR and issue counts and cache', () => {
  const v: View = { ...fullRepo, worktree: 'wt1', kube: { ctx: 'lab', ns: '' }, forge: { provider: 'gitlab', prs: 3, issues: 4, capped: false, stale: false } }
  const text = (glyph: typeof ICONS.nerd) => buildRows({ ...neutral(), glyph }, v, 260).map(plain).join('\n')
  const nerd = text(ICONS.nerd)
  for (const part of ['  wt1 ', '  feat/x ', '\u{f10fe} lab', ' 3  4', ' 94% w 3m']) expect(nerd).toContain(part)
  const uni = text(ICONS.unicode)
  for (const part of [' ⌥ wt1 ', ' ⎇ feat/x ', 'k8s lab', '⑂ 3 ⊙ 4', '◔ 94% w 3m']) expect(uni).toContain(part)
  for (const word of ['wt:', 'PRs', 'MRs', 'cache']) {
    expect(nerd).not.toContain(word)
    expect(uni).not.toContain(word)
  }
})

test('cache state: w in green while warm with the time left, c in blue once cold', () => {
  const st = { ...neutral(), P: PALETTES.dark }
  const cache = (pc: View['cache']) => (buildRows(st, { ...leanPlain, cache: pc }, 200)[1] ?? []).filter((sp) => sp.t === 'w' || sp.t === 'c')
  const row = (pc: View['cache']) => plain(buildRows(st, { ...leanPlain, cache: pc }, 200)[1] ?? [])
  const warm = { observed: true, hit: 0.99, requests: 9, misses: 0, warm: true, expiresAt: NOW + 59 * 60_000 + 5_000 }
  expect(row(warm)).toContain('◔ 99% w 59m')
  expect(cache(warm)).toEqual([{ t: 'w', fg: '#9bfece' }])
  for (const cold of [{ ...warm, warm: false }, { ...warm, expiresAt: NOW - 1000 }]) {
    expect(row(cold)).toContain('◔ 99% c')
    expect(row(cold)).not.toContain('59m')
    expect(cache(cold)).toEqual([{ t: 'c', fg: '#a9aefe' }])
  }
})

test('a segment that throws is left out; every failure is a dim ✗name at the end of row 1', () => {
  const broken = { window: 1, get percent(): number { throw new Error('boom') } }
  const [first = [], secondRow = []] = buildRows(neutral(), { ...fullRepo, context: broken, failed: ['kube', 'transcript'] }, 240)
  const second = plain(secondRow)
  expect(second.startsWith('5h ')).toBe(true)
  expect(plain(first).endsWith(' │ ✗kube ✗transcript ✗ctx')).toBe(true)
  expect(first.at(-1)).toEqual({ t: '✗kube ✗transcript ✗ctx', faint: true })
  expect(second).not.toContain('✗')
  const empty: View = { ...leanPlain, model: null, cwd: null, context: null, limits: [], costUsd: null, durationMs: null }
  expect(buildRows(neutral(), empty, 80).map(plain)).toEqual(['◆ Claude'])
  const dark = { ...neutral(), P: PALETTES.dark }
  const branch = (buildRows(dark, fullRepo, 200)[0] ?? []).find((sp: Part[number]) => sp.t === ' ⎇ feat/x ')
  expect(branch).toEqual({ t: ' ⎇ feat/x ', bg: '#9bfece', fg: '#070722', bold: true })
  const mono = buildRows({ ...dark, noColor: true }, fullRepo, 200)[0] ?? []
  expect(plain(mono)).toContain('[⎇ feat/x]')
  expect(mono.some((sp) => sp.fg || sp.bg)).toBe(false)
})

// ---- the hooks, through the test kit ----

type Ctl = { kube: 'ok' | 'fail' }
const ok = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }) as never

// The engine beneath the mod: session figures, a git repo on develop, a kubeconfig with context lab, a session
// style from /config, and a stand-in band of its own so stacking shows.
function engine(on: On, ctl: Ctl = { kube: 'ok' }) {
  const clock = mock.clock(on, { now: NOW })
  const runs: string[][] = []
  on('session.start', () => ({ cwd: '/work/repo' }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.root', () => ({ value: '/work/repo' }))
  on('session.id', () => ({ value: 'sid' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [] } }) as never)
  on('settings.read', () => ({ value: {} }))
  on('config.list', () => ({ value: [{ key: 'outputStyle', label: 'Output style', kind: 'enum', value: 'Explanatory', provider: { plugin: 'engine', tier: 'core' } }] }) as never)
  on('env.get', (_$, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/u' : undefined }) as never)
  on('fs.stat', (_$, e) => ((e as { path: string }).path === '/u/.kube/config' ? { value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } } : { deny: 'no such file' }) as never)
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'no such file' }) as never)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['engine'] }) as never)
  on('process.run', (_$, e) => {
    const argv = [...(e as { argv: string[] }).argv]
    runs.push(argv)
    if (argv[0] === 'kubectl') return ctl.kube === 'ok' ? ok('{"contexts":[{"name":"lab","context":{}}]}') : ok('', 1, 'boom')
    if (argv[0] === 'git' && argv.includes('status')) return ok('# branch.oid 1234567\n# branch.head develop\n')
    return ok('', 1)
  })
  return { clock, runs, ctl }
}

const mount = async ($: Engine, surface: 'terminal' | 'desktop') => {
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } }
  const ui = await $.ui.mount({ plugin: 'statusline', surface, component: 'AbovePrompt', props: props as never, viewport: { columns: 125, rows: 30 } })
  const text = (await ui.findAll({ type: 'Text' })).map((t) => t.text).join('')
  const rows = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('row-')).map((b) => b.text)
  await ui.unmount()
  return { text, rows }
}
const band = async ($: Engine, surface: 'terminal' | 'desktop') => (await mount($, surface)).text

async function started($: Engine, clock: ReturnType<typeof mock.clock>) {
  await $.session.start({ cwd: '/work/repo', source: 'startup' } as never)
  await clock.advance(10)
}

test('mode on draws a rule, then two rows and no blank row, on both surfaces; other bands stack above', async ($, on) => {
  const { clock } = engine(on)
  await started($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const { text, rows } = await mount($, surface)
    expect(text.startsWith('engine')).toBe(true)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toBe('─'.repeat(120))
    expect(rows[1]).toContain('◆ Opus 5.5')
    expect(rows[1]).toContain('✎ Explanatory')
    expect(rows[1]).toContain(' ⎇ develop ')
    expect(rows[1]).toContain('k8s lab')
    expect(rows[2]).toContain('ctx')
    for (const r of rows) expect(r.trim()).not.toBe('')
  }
})

test('plugin options reach the mod: nerd icons and one row', { options: { icons: 'nerd', rows: '1', forge: 'off' } }, async ($, on) => {
  const { clock, runs } = engine(on)
  await started($, clock)
  const { rows } = await mount($, 'terminal')
  expect(rows).toHaveLength(2)
  expect(rows[1]).toContain('  develop ')
  expect(rows[1]).toContain('\u{f10fe} lab')
  expect(rows[1]).toContain('ctx')
  expect(runs.some((a) => a[0] === 'gh' || a[0] === 'glab')).toBe(false)
})

test('a failing source shows as a dim ✗name at the end of row 1', async ($, on) => {
  const { clock } = engine(on, { kube: 'fail' })
  await started($, clock)
  const { rows } = await mount($, 'terminal')
  expect(rows[1]).toMatch(/│ ✗kube$/)
  expect(rows[1]).not.toContain('k8s')
})

test('mode off draws nothing and runs nothing', { options: { mode: 'off' } }, async ($, on) => {
  const { clock, runs } = engine(on)
  await started($, clock)
  await clock.advance(60_000)
  for (const surface of ['terminal', 'desktop'] as const) expect(await band($, surface)).toBe('engine')
  expect(runs).toEqual([])
})
