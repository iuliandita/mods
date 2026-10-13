// Pure formatting for the status line, ported from the reference statusline script: no `$`, so every piece here
// is unit-tested in segments.test.ts. A segment is a list of forms, richest first; `place` keeps the most
// important that fit the width, then widens them.

export type Rgb = readonly [number, number, number]
export type Paint = Rgb | 'faint' | null
export type Span = { t: string; fg?: string; bg?: string; bold?: boolean; italic?: boolean; faint?: boolean }
export type Part = Span[]
export type Seg = { name: string; prio: number; forms: Part[]; keep?: boolean; optional?: boolean }

export type ThemeName = 'dark' | 'light' | 'neutral' | 'noctalia'
export type Palette = { MINT: Rgb; PINK: Rgb; YELLOW: Rgb; LAV: Rgb; DIM: Paint; TRACK: Paint; INK: Rgb; BAR: readonly [Rgb, Rgb, Rgb] }

export const PALETTES: Record<'dark' | 'light' | 'neutral', Palette> = {
  dark: { MINT: [155, 254, 206], PINK: [253, 70, 99], YELLOW: [255, 245, 155], LAV: [169, 174, 254], DIM: [138, 140, 188], TRACK: [100, 102, 172], INK: [7, 7, 34], BAR: [[155, 254, 206], [255, 245, 155], [253, 70, 99]] },
  light: { MINT: [0, 122, 82], PINK: [196, 24, 66], YELLOW: [138, 92, 0], LAV: [77, 66, 214], DIM: [98, 102, 140], TRACK: [140, 147, 194], INK: [255, 255, 255], BAR: [[0, 160, 110], [184, 110, 0], [214, 40, 80]] },
  neutral: { MINT: [17, 151, 71], PINK: [245, 66, 88], YELLOW: [179, 120, 5], LAV: [105, 119, 247], DIM: 'faint', TRACK: 'faint', INK: [7, 7, 34], BAR: [[13, 160, 72], [189, 126, 5], [246, 76, 96]] },
}

// Symbols, not words: the worktree, branch, PR and issue counts and the cache each get a glyph in both sets.
export type Icons = { branch: string; folder: string; tree: string; kube: string; pr: string; issue: string; cache: string }
export type IconSet = 'nerd' | 'unicode' | 'ascii'
export const ICONS: Record<IconSet, Icons> = {
  nerd: { branch: ' ', folder: ' ', tree: ' ', kube: '\u{f10fe} ', pr: ' ', issue: ' ', cache: ' ' },
  // Standard Unicode symbols only, no private-use code points: they render without a patched font, in a terminal
  // and in Claude Desktop's web view alike.
  // Monochrome text symbols, none a colour emoji: U+1F5BF BLACK FOLDER (flat, like the Nerd folder) has no emoji
  // property; ☸ has one with text presentation by default, and U+FE0E asks for text explicitly.
  unicode: { branch: '⎇ ', folder: '\u{1f5bf} ', tree: '⌥ ', kube: '☸︎ ', pr: '⑂ ', issue: '⊙ ', cache: '◔ ' },
  ascii: { branch: '', folder: '', tree: 'wt:', kube: 'k8s ', pr: 'pr ', issue: 'iss ', cache: 'cache ' },
}

// The `icons` option, the same on every surface: auto is unicode, safe where no Nerd Font is installed; nerd is
// Nerd Font glyphs in the terminal and in Desktop alike.
export const iconSet = (option: Config['icons']): IconSet => (option === 'auto' ? 'unicode' : option)

// The pace tick in the limit bars, on both surfaces: a dot, which a taller Desktop line cannot turn into a cursor.
export const PACE_TICK = '●'

// How a row is painted: the palette, the icon set, the pace tick and NO_COLOR, which keeps bold, italic and faint
// only. `desktop`: the row is laid out in a web view, where the forge counts are not held back to 120 columns.
export type Style = { P: Palette; glyph: Icons; tick: string; noColor: boolean; desktop?: boolean }

export type Config = {
  mode: 'off' | 'on'
  rows: 1 | 2
  forge: boolean
  forgeHosts: Record<string, 'github' | 'gitlab'>
  icons: 'auto' | 'nerd' | 'unicode' | 'ascii'
  theme: 'auto' | ThemeName
  refreshMs: number
  ctxWindow: 'auto' | 'full'
  placeholders: boolean
}

export function parseHosts(text: unknown): Record<string, 'github' | 'gitlab'> {
  const out: Record<string, 'github' | 'gitlab'> = {}
  for (const pair of String(text ?? '').split(',')) {
    const [k, v] = pair.split('=', 2).map((s) => s.trim().toLowerCase())
    if (k && (v === 'github' || v === 'gitlab')) out[k] = v
  }
  return out
}

export function parseConfig(o: Record<string, unknown>): Config {
  const secs = typeof o.refreshSeconds === 'number' ? o.refreshSeconds : Number(o.refreshSeconds)
  const theme = String(o.theme ?? 'auto')
  return {
    mode: o.mode === 'off' ? 'off' : 'on',
    rows: String(o.rows) === '1' ? 1 : 2,
    forge: o.forge !== 'off',
    forgeHosts: parseHosts(o.forgeHosts),
    icons: o.icons === 'nerd' || o.icons === 'unicode' || o.icons === 'ascii' ? o.icons : 'auto',
    theme: theme === 'dark' || theme === 'light' || theme === 'neutral' || theme === 'noctalia' ? theme : 'auto',
    refreshMs: Number.isFinite(secs) && secs > 0 ? Math.min(3600, Math.max(5, Math.round(secs))) * 1000 : 30_000,
    ctxWindow: o.ctxWindow === 'full' ? 'full' : 'auto',
    placeholders: o.placeholders !== 'off',
  }
}

// This plugin's options as settings.json stores them (`pluginConfigs["<name>@<marketplace>"].options`), when
// exactly one entry is this plugin's; with none or several there is nothing certain to fall back on.
export function storedOptions(pluginConfigs: unknown, name: string): Record<string, unknown> | null {
  if (!pluginConfigs || typeof pluginConfigs !== 'object') return null
  const mine = Object.entries(pluginConfigs as Record<string, unknown>).filter(([k]) => k === name || k.startsWith(`${name}@`))
  const opts = mine.length === 1 ? (mine[0]?.[1] as { options?: unknown } | null)?.options : null
  return opts && typeof opts === 'object' && !Array.isArray(opts) ? (opts as Record<string, unknown>) : null
}

// ---- numbers and text as Python prints them ----

// Python's round() and format(".0f"): halves go to the even neighbour.
export function roundEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}
const fixed0 = (x: number): string => String(roundEven(x))
const signed0 = (x: number): string => `${x < 0 || Object.is(x, -0) ? '-' : '+'}${roundEven(Math.abs(x))}`

const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g
export const clean = (v: unknown): string => String(v ?? '').replace(CONTROL, '')
export const clip = (s: string, n: number): string => ([...s].length <= n ? s : [...s].slice(0, n - 1).join('') + '…')

export function humanize(seconds: number): string {
  const s = Math.floor(Math.max(0, seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d${h}h`
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${roundEven(n / 1000)}k`
  return String(Math.trunc(n))
}

function cellWidth(cp: number): number {
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) || cp === 0x26a1
  return wide ? 2 : 1
}
export const textWidth = (s: string): number => [...s].reduce((w, ch) => w + cellWidth(ch.codePointAt(0) ?? 0), 0)
export const partWidth = (p: Part): number => p.reduce((w, s) => w + textWidth(s.t), 0)
export const plain = (p: Part): string => p.map((s) => s.t).join('')

// ---- colour ----

const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
const lerp = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => roundEven((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * t)) as unknown as Rgb

// Green to yellow to red as t goes 0 to 1, through the three anchor colours.
export function ramp(t: number, anchors: readonly [Rgb, Rgb, Rgb]): Rgb {
  const x = Math.max(0, Math.min(1, t))
  return x < 0.5 ? lerp(anchors[0], anchors[1], x * 2) : lerp(anchors[1], anchors[2], (x - 0.5) * 2)
}

// Green up to 50%, then through yellow (75%) to red (100%): a healthy value must not look like a warning.
export const levelColor = (P: Palette, pct: number): Rgb => ramp(Math.max(0, (pct - 50) / 50), [P.MINT, P.YELLOW, P.PINK])

export function c(st: Style, paint: Paint, text: string, bold = false, italic = false): Part {
  const s: Span = { t: text }
  if (bold) s.bold = true
  if (italic) s.italic = true
  if (paint === 'faint') s.faint = true
  else if (paint && !st.noColor) s.fg = hex(paint)
  return [s]
}

export function badge(st: Style, bg: Rgb, text: string): Part {
  if (st.noColor) return c(st, null, `[${text}]`, true)
  return [{ t: ` ${text} `, bg: hex(bg), fg: hex(st.P.INK), bold: true }]
}

const cat = (...parts: Part[]): Part => parts.flat()
// " ".join(p for p in parts if p)
export function join(...parts: (Part | null | undefined)[]): Part {
  const out: Span[] = []
  for (const p of parts) {
    if (!p || p.length === 0) continue
    if (out.length) out.push({ t: ' ' })
    out.push(...p)
  }
  return out
}

// ---- layout ----

const sep = (st: Style): Part => c(st, st.P.TRACK, ' │ ')

function seg(name: string, prio: number, forms: Part[], extra: Partial<Seg> = {}): Seg {
  const keys = forms.map((f) => JSON.stringify(f))
  return { name, prio, forms: forms.filter((f, i) => f.length && keys.indexOf(keys[i] ?? '') === i), ...extra }
}
const none = (name: string): Seg => ({ name, prio: 0, forms: [] })

// Every core segment starts at its leanest form and the least important are dropped until that fits. The width
// left over goes to richer forms one step at a time, most important first, and last to optional garnish.
export function place(segs: Seg[], cols: number, sepWidth = 3): Part[] {
  const live = segs.filter((s) => s.forms.length)
  const at = new Map(live.map((s) => [s, s.forms.length - 1]))
  const on = new Set(live.filter((s) => !s.optional))
  const form = (s: Seg): Part => s.forms[at.get(s) ?? 0] ?? []
  const width = (): number => {
    const shown = live.filter((s) => on.has(s))
    return shown.reduce((w, s) => w + partWidth(form(s)), 0) + Math.max(0, shown.length - 1) * sepWidth
  }
  while (width() > cols) {
    const droppable = live.filter((s) => on.has(s) && !s.keep)
    if (!droppable.length) break
    on.delete(droppable.reduce((a, b) => (b.prio < a.prio ? b : a)))
  }
  const core = live.filter((s) => on.has(s)).sort((a, b) => b.prio - a.prio)
  for (let advanced = true; advanced; ) {
    advanced = false
    for (const s of core) {
      const i = at.get(s) ?? 0
      if (i === 0) continue
      at.set(s, i - 1)
      if (width() <= cols) advanced = true
      else at.set(s, i)
    }
  }
  for (const s of live.filter((x) => x.optional).sort((a, b) => b.prio - a.prio)) {
    on.add(s)
    let fits = false
    for (let i = 0; i < s.forms.length && !fits; i++) {
      at.set(s, i)
      fits = width() <= cols
    }
    if (!fits) on.delete(s)
  }
  return live.filter((s) => on.has(s)).map(form)
}

// Hard guarantee: the visible text is cut to cols, the last cell an ellipsis.
export function truncate(p: Part, cols: number): Part {
  if (partWidth(p) <= cols) return p
  const out: Span[] = []
  let used = 0
  for (const s of p) {
    let t = ''
    for (const ch of s.t) {
      const w = cellWidth(ch.codePointAt(0) ?? 0)
      if (used + w > cols - 1) {
        out.push({ ...s, t: t + '…' })
        return out
      }
      t += ch
      used += w
    }
    out.push(s)
  }
  return out
}

export function fit(st: Style, segs: Seg[], cols: number): Part {
  const row: Span[] = []
  place(segs, cols).forEach((f, i) => {
    if (i) row.push(...sep(st))
    row.push(...f)
  })
  return truncate(row, cols)
}

// ---- the data a row is drawn from ----

export type GitInfo = { branch: string; oid: string; ahead: number; behind: number; staged: number; modified: number; untracked: number | null; conflicts: number }
export type Pr = { number: number; kind: 'pr' | 'mr'; state: 'approved' | 'changes_requested' | 'draft' | 'pending' | '' }
export type Forge = { provider: 'github' | 'gitlab'; prs: number; issues: number; capped: boolean; stale: boolean }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type PromptCache = { observed: boolean; hit: number | null; requests: number; misses: number; warm: boolean; expiresAt: number | null }

export type View = {
  now: number // ms
  model: string | null // display name
  effort: string | null
  fast: boolean
  cwd: string | null
  worktree: string | null
  git: GitInfo | null
  kube: { ctx: string; ns: string } | null
  pr: Pr | null
  agent: string | null
  sessionName: string | null
  outputStyle: string | null
  vim: string | null
  forge: Forge | null
  // `limit`: the auto-compact window when it is smaller than the model's `window` (see effectiveWindow).
  context: { tokens?: number; window: number; percent?: number; limit?: number } | null
  limits: Limit[]
  costUsd: number | null
  durationMs: number | null
  // null: not known (a resumed session whose transcript holds no saved total yet); never drawn as 0.
  apiMs: number | null
  cache: PromptCache | null
  lines: { added: number; removed: number; session: boolean } | null
  failed: string[]
  // Segments whose data has not arrived yet; each draws a dim placeholder of its usual width (see pendingFor).
  pending?: string[]
}

// ---- segments, as the script builds them ----

const EFFORT: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }
const PROTECTED = /^(main|master|develop|release[/-].*)$/
const PROD = /(?<![a-z])prod(?:uction)?(?![a-z])/i
const REVIEW: Record<string, string> = { approved: '✓', changes_requested: '✗', draft: '◌', pending: '●' }
const WINDOWS: [string, string, number, number][] = [['5h', 'five_hour', 5 * 3600, 8], ['7d', 'seven_day', 7 * 86400, 6]]
export const FORGE_MIN_COLS = 120

export function bar(st: Style, pct: number, width: number, mark: number | null = null, markRgb: Rgb | null = null): Part {
  const filled = Math.max(pct >= 1 ? 1 : 0, Math.min(width, roundEven((pct / 100) * width)))
  const cells: Part = []
  for (let i = 0; i < width; i++) {
    if (i === mark) cells.push(...c(st, markRgb, st.tick, markRgb === null))
    else if (i < filled) cells.push(...c(st, ramp(i / Math.max(1, width - 1), st.P.BAR), '━'))
    else cells.push(...c(st, st.P.TRACK, '─'))
  }
  return cells
}

export function modelSeg(st: Style, model: string | null, effort: string | null): Seg {
  const name = clean(model || 'Claude')
  const head = (n: number) => c(st, st.P.LAV, `◆ ${clip(name, n)}`, true)
  const level = clean(effort ?? '')
  const steps = EFFORT[level]
  if (!steps) return seg('model', 10, [level ? join(head(40), c(st, st.P.DIM, clip(level, 10))) : head(40), head(12)], { keep: true })
  const pips = cat(c(st, steps >= 4 ? st.P.YELLOW : st.P.LAV, '▰'.repeat(steps)), c(st, st.P.DIM, '▱'.repeat(5 - steps)))
  return seg('model', 10, [cat(head(40), [{ t: '  ' }], pips), cat(head(12), [{ t: '  ' }], pips)], { keep: true })
}

export function gitSeg(st: Style, g: GitInfo | null, wt: string | null): Seg {
  if (!g || !g.branch) return none('git')
  const P = st.P
  const branch = clean(g.branch)
  const worktree = wt ? clean(wt) : null
  const lead = (n: number): Part => {
    let text: Part = worktree ? badge(st, P.LAV, `${st.glyph.tree}${clip(worktree, n)}`) : []
    if (branch === '(detached)') return join(text, badge(st, P.YELLOW, `detached @${clean(g.oid)}`))
    if (branch !== worktree) text = join(text, badge(st, PROTECTED.test(branch) ? P.PINK : P.MINT, `${st.glyph.branch}${clip(branch, n)}`))
    return text
  }
  const sync = cat(g.ahead ? c(st, P.LAV, ` ↑${g.ahead}`) : [], g.behind ? c(st, P.PINK, ` ↓${g.behind}`) : [])
  const conflicts = g.conflicts ? c(st, P.PINK, ` =${g.conflicts}`, true) : []
  const counts = cat(
    g.staged ? c(st, P.MINT, ` +${g.staged}`) : [],
    g.modified ? c(st, P.YELLOW, ` ~${g.modified}`) : [],
    g.untracked ? c(st, P.DIM, ` ?${g.untracked}`) : g.untracked === null ? c(st, P.DIM, ' ?…') : [],
  )
  return seg('git', conflicts.length ? 11 : 9, [
    cat(lead(40), counts, conflicts, sync),
    cat(lead(40), counts, conflicts),
    cat(lead(24), counts, conflicts),
    cat(lead(24), conflicts),
    cat(lead(14), conflicts),
  ])
}

export function kubeSeg(st: Style, kube: View['kube']): Seg {
  if (!kube || !kube.ctx) return none('kube')
  const name = clean(kube.ctx)
  const ns = clean(kube.ns)
  const label = (n: number) => `${st.glyph.kube}${clip(name, n)}${ns ? `/${clip(ns, n)}` : ''}`
  if (PROD.test(name)) return seg('kube', 10, [badge(st, st.P.PINK, label(30)), badge(st, st.P.PINK, label(12))])
  return seg('kube', 6, [c(st, st.P.LAV, label(30)), c(st, st.P.LAV, label(12))])
}

export function prSeg(st: Style, pr: Pr | null): Seg {
  if (!pr || !pr.number) return none('pr')
  const ref = `${pr.kind === 'mr' ? '!' : '#'}${pr.number}`
  const tint = { approved: st.P.MINT, changes_requested: st.P.PINK, pending: st.P.YELLOW }[pr.state as string] ?? st.P.DIM
  const mark = REVIEW[pr.state] ? c(st, tint, REVIEW[pr.state] ?? '') : null
  return seg('pr', 5, [join(c(st, st.P.LAV, ref), mark), c(st, st.P.LAV, ref)])
}

export function forgeSeg(st: Style, f: Forge | null): Seg {
  if (!f) return none('forge')
  const mark = f.stale ? '≈' : ''
  const prs = `${mark}${f.prs}${f.capped ? '+' : ''}`
  const issues = `${mark}${f.issues}`
  return seg('forge', 8, [join(c(st, st.P.DIM, st.glyph.pr.trim()), c(st, null, prs), c(st, st.P.DIM, st.glyph.issue.trim()), c(st, null, issues))])
}

export function limitSeg(st: Style, label: string, lim: Limit | undefined, window: number, basePrio: number, nowS: number): Seg {
  if (!lim || typeof lim.percentUsed !== 'number') return none(label)
  const P = st.P
  const pct = lim.percentUsed
  const resets = lim.resetsAt ? Date.parse(lim.resetsAt) / 1000 : NaN
  const left = Number.isFinite(resets) ? resets - nowS : null
  const frac = left !== null && left > 0 && left <= window ? 1 - left / window : null
  const delta = frac !== null ? pct - frac * 100 : 0
  const tick = delta <= -5 ? P.MINT : delta <= 5 ? null : delta <= 15 ? P.YELLOW : P.PINK
  const reached = pct >= 100 && (left === null || left > 0)
  let warn: Part = []
  if (reached) warn = c(st, P.PINK, '■', true)
  else if (frac !== null && frac >= 0.1 && pct / frac >= 110) warn = c(st, P.PINK, `▲${humanize((100 - pct) / (pct / (frac * window)))}`)
  const flag = warn.length ? c(st, P.PINK, reached ? '■' : '▲', true) : null
  const head = c(st, P.DIM, label)
  const value = c(st, levelColor(P, pct), `${fixed0(pct)}%`, pct >= 90)
  const reset = left !== null && left > 0 ? c(st, P.DIM, `↻${humanize(left)}`) : null
  const gap = frac !== null ? c(st, tick ?? P.DIM, `(${signed0(delta)})`) : null
  const meter = (w: number) => bar(st, pct, w, frac !== null ? Math.min(w - 1, Math.floor(frac * w)) : null, frac !== null ? tick : null)
  const prio = warn.length ? 11 : pct >= 90 ? 10 : basePrio
  return seg(label, prio, [
    join(head, meter(10), value, gap, reset, warn),
    join(head, meter(8), value, gap, warn),
    join(head, meter(6), value, gap, warn),
    join(head, meter(4), value, flag),
  ])
}

// The engine reports a spend limit's percentage and reset only, not its dollar amounts.
export function spendSeg(st: Style, lim: Limit | undefined, nowS: number): Seg {
  if (!lim || typeof lim.percentUsed !== 'number') return none('spend')
  const pct = lim.percentUsed
  const head = c(st, st.P.DIM, 'spend')
  const value = c(st, levelColor(st.P, pct), `${fixed0(pct)}%`)
  const left = lim.resetsAt ? Date.parse(lim.resetsAt) / 1000 - nowS : 0
  const reset = left > 0 ? c(st, st.P.DIM, `↻${humanize(left)}`) : null
  const flag = pct >= 100 ? c(st, st.P.PINK, '■', true) : null
  return seg('spend', flag ? 11 : 7, [join(head, bar(st, pct, 8), value, reset, flag), join(head, bar(st, pct, 6), value, flag), join(head, value, flag)])
}

export function ctxSeg(st: Style, ctx: View['context']): Seg {
  if (!ctx) return none('ctx')
  const P = st.P
  const head = c(st, P.DIM, 'ctx')
  const over = (ctx.tokens ?? 0) > 200_000 ? c(st, P.YELLOW, '>200k') : null
  // Against a smaller auto-compact window the share is recomputed from the tokens, and may pass 100%.
  const size = ctx.limit && ctx.limit < ctx.window ? ctx.limit : ctx.window
  const reduced = size !== ctx.window
  const pct = !reduced ? ctx.percent : ctx.tokens !== undefined ? (ctx.tokens / size) * 100 : ctx.percent !== undefined ? (ctx.percent * ctx.window) / size : undefined
  if (pct === undefined || pct === null) return seg('ctx', 9, [join(head, bar(st, 0, 14), c(st, P.DIM, '--'), over), join(head, c(st, P.DIM, '--'), over)])
  const value = c(st, levelColor(P, pct), `${fixed0(pct)}%`, pct >= 90)
  const used = (pct / 100) * size
  const amount = used && size ? c(st, P.DIM, `${fmtTokens(used)}/${fmtTokens(size)}`) : null
  return seg('ctx', pct >= 90 ? 10 : 9, [
    join(head, bar(st, pct, 14), value, amount, over),
    join(head, bar(st, pct, 10), value, amount, over),
    join(head, bar(st, pct, 6), value, over),
    join(head, value, over),
  ])
}

// A window value as Claude Code takes it: a token count from 100K to 1M. "auto" (the model's tuned window)
// or anything else is no value.
const windowValue = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN
  return Number.isFinite(n) && n >= 100_000 && n <= 1_000_000 ? n : null
}

// The auto-compact window (how full the context may get before Claude Code compacts it), resolved as Claude
// Code does: CLAUDE_CODE_AUTO_COMPACT_WINDOW, then modelSettings[<model>].autoCompactWindow, then the
// top-level autoCompactWindow; capped at the model's own window, which is also the answer when none is set.
// The model's key is matched by its exact id, then without a bracket suffix (`[1m]`), then by the longest
// key the id starts with (a dated id such as claude-x-4-5-20250929).
export function effectiveWindow(o: { mode: 'auto' | 'full'; engineWindow: number; model: string | null; settings: Record<string, unknown>; env: string | null }): number {
  if (o.mode === 'full' || !(o.engineWindow > 0)) return o.engineWindow
  const fromEnv = windowValue(o.env)
  let chosen = fromEnv
  if (chosen === null && o.model) {
    const all = o.settings.modelSettings && typeof o.settings.modelSettings === 'object' ? (o.settings.modelSettings as Record<string, unknown>) : {}
    const bare = o.model.replace(/\[[^\]]*\]$/, '')
    const key =
      [o.model, bare].find((k) => k in all) ??
      Object.keys(all).filter((k) => bare.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0]
    const entry = key !== undefined ? all[key] : undefined
    const value = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).autoCompactWindow : undefined
    // "auto" for the model returns it to its own tuned window, whatever the top-level key says.
    if (value === 'auto') return o.engineWindow
    chosen = windowValue(value)
  }
  if (chosen === null) chosen = windowValue(o.settings.autoCompactWindow)
  return chosen === null ? o.engineWindow : Math.min(chosen, o.engineWindow)
}

export function cacheSeg(st: Style, pc: PromptCache | null, nowS: number): Seg {
  if (!pc || !pc.observed) return none('cache')
  const P = st.P
  const ratio = pc.hit
  const left = pc.expiresAt !== null ? pc.expiresAt / 1000 - nowS : 0
  const tint = pc.requests < 3 ? P.DIM : ratio !== null && ratio >= 0.8 ? P.MINT : ratio !== null && ratio >= 0.5 ? P.YELLOW : P.PINK
  const hit = ratio !== null ? c(st, tint, `${fixed0(ratio * 100)}%`) : null
  const isCold = !pc.warm || (pc.expiresAt !== null && left <= 0)
  // w (green) while the cache is warm, c (blue) once it has gone cold; the script wrote `cold`.
  const state = c(st, isCold ? P.LAV : P.MINT, isCold ? 'c' : 'w')
  const timeLeft = !isCold && pc.expiresAt !== null && left > 0 ? c(st, P.DIM, left >= 60 ? humanize(left) : '<1m') : null
  const miss = pc.misses ? c(st, P.PINK, `⊘${pc.misses}`) : null
  const head = c(st, P.DIM, st.glyph.cache.trim())
  return seg('cache', pc.misses ? 6 : 4, [join(head, hit, state, timeLeft, miss), join(head, hit, state, miss)])
}

export const costSeg = (st: Style, usd: number | null): Seg => (usd ? seg('cost', 5, [c(st, null, `$${usd.toFixed(2)}`)]) : none('cost'))

// The API part: the known total (under a minute as <1m, never 0m), `--` while pending, else left out.
export function timeSeg(st: Style, durationMs: number | null, apiMs: number | null, apiPending = false): Seg {
  if (!durationMs || durationMs < 60_000) return none('time')
  const wall = humanize(durationMs / 1000)
  const api = apiMs ? `/${apiMs < 60_000 ? '<1m' : humanize(apiMs / 1000)}` : apiPending ? '/--' : ''
  return seg('time', 4, [c(st, st.P.DIM, wall + api), c(st, st.P.DIM, wall)])
}

// ---- loading ----

// What the band knows about its sources while they load (see pendingFor).
export type Arrival = {
  enabled: boolean // the placeholders option
  waiting: boolean // within the deadline after the mod loaded
  responded: boolean // the engine has reported the session's first API response (context tokens, cost or limits)
  transcript: 'none' | 'reading' | 'done' // none: no transcript file yet (a new session)
  forgeExpected: boolean // a forge remote whose counts have not been answered yet
}
export const PENDING_DEADLINE_MS = 10_000

// The segments that are still on their way, each drawn as a dim placeholder until its data comes. A segment
// whose source has answered and has nothing to show (no repository, no limits on this plan) is not pending.
// - ctx, 5h, 7d, cost: the engine has them only after the session's first API response; they wait for it with
//   no deadline, and the limits that are still missing after it (an API-key plan has none) are dropped.
// - time: under a minute of session time is drawn as `--`.
// - api, cache: read from the transcript; pending while it is being read (until the deadline), and in a new
//   session until the first response writes it. A resumed session shows the transcript's figures as soon as
//   they are read: the hit ratio over its past requests and, from the last response's time, whether the cache
//   is still warm.
// - forge: until gh/glab answer or the deadline passes; a failure shows as ✗forge.
export function pendingFor(a: Arrival, v: View): string[] {
  if (!a.enabled) return []
  const out: string[] = []
  if (!a.responded) {
    if (!v.context || v.context.tokens === undefined) out.push('ctx')
    for (const [label, kind] of WINDOWS) if (!v.limits.some((l) => l.kind === kind)) out.push(label)
    if (!v.costUsd) out.push('cost')
  }
  if (!v.durationMs || v.durationMs < 60_000) out.push('time')
  const fromTranscript = (a.transcript === 'reading' && a.waiting) || (!a.responded && a.transcript === 'none')
  if (fromTranscript && !v.apiMs) out.push('api')
  if (fromTranscript && !v.cache) out.push('cache')
  if (a.forgeExpected && a.waiting && !v.forge) out.push('forge')
  return out
}

// A pending segment's stand-in: dim, the shape of the real one, at the same priority.
export function placeholderSeg(st: Style, name: string): Seg {
  const P = st.P
  const dim = (t: string) => c(st, P.DIM, t)
  const track = (w: number) => c(st, P.TRACK, '─'.repeat(w))
  const window = WINDOWS.find(([label]) => label === name)
  if (window) return seg(name, window[3], [10, 8, 6, 4].map((w) => join(dim(name), track(w), dim('--'))))
  if (name === 'ctx') return ctxSeg(st, { window: 0 })
  if (name === 'cost') return seg('cost', 5, [dim('$--')])
  if (name === 'time') return seg('time', 4, [dim('--')])
  if (name === 'cache') return seg('cache', 4, [join(dim(st.glyph.cache.trim()), dim('--'))])
  if (name === 'forge') return seg('forge', 8, [join(dim(st.glyph.pr.trim()), dim('--'), dim(st.glyph.issue.trim()), dim('--'))])
  return none(name)
}

// The session's own line counts when known; otherwise uncommitted lines in the working tree, marked Δ.
export function linesSeg(st: Style, lines: View['lines']): Seg {
  if (!lines || (!lines.added && !lines.removed)) return none('lines')
  const body = cat(c(st, st.P.MINT, `+${lines.added}`), [{ t: ' ' }], c(st, st.P.PINK, `-${lines.removed}`))
  return seg('lines', 2, [lines.session ? body : cat(c(st, st.P.DIM, 'Δ'), body)])
}

// Builds every segment; one that throws is left out and named, as the script does, in a ✗name notice.
// linesRow 1 (the owner's layout, the default) puts lines added/removed beside the git segment, dropped after
// the forge counts and before git; 2 is the script's layout, kept so the formatter can be checked against it.
export function buildRows(st: Style, v: View, cols: number, rows: 1 | 2 = 2, linesRow: 1 | 2 = 1): Part[] {
  const failed = [...v.failed]
  const safe = (name: string, build: () => Seg): Seg => {
    try {
      return build()
    } catch {
      failed.push(name)
      return none(name)
    }
  }
  // A source that failed shows its ✗name, never a placeholder.
  const pend = new Set((v.pending ?? []).filter((n) => !failed.includes(n)))
  const slot = (name: string, build: () => Seg): Seg => {
    const s = safe(name, build)
    return s.forms.length || !pend.has(name) ? s : placeholderSeg(st, name)
  }
  const P = st.P
  const budget = cols - 4
  const nowS = v.now / 1000
  const folder = clean(v.cwd ? v.cwd.split('/').filter(Boolean).pop() || '/' : '')
  const limit = (kind: string) => v.limits.find((l) => l.kind === kind)

  const ident: Seg[] = [safe('model', () => modelSeg(st, v.model, v.effort))]
  if (v.fast) ident.push(seg('fast', 7, [c(st, P.YELLOW, '⚡')]))
  // The folder is always drawn, also beside a worktree badge of the same name (the script hid it then).
  if (v.cwd) ident.push(seg('folder', 8, [c(st, null, `${st.glyph.folder}${clip(folder, 32)}`), c(st, null, clip(folder, 12))]))
  const lines = safe('lines', () => linesSeg(st, v.lines))
  const git = safe('git', () => gitSeg(st, v.git, v.worktree))
  const kube = safe('kube', () => kubeSeg(st, v.kube))
  const pr = safe('pr', () => prSeg(st, v.pr))
  const agent = v.agent ? [seg('agent', 4, [c(st, P.YELLOW, `@${clip(clean(v.agent), 24)}`)])] : []
  // The repository's PR and issue counts, from 120 columns. In the owner's layout they sit right after the
  // branch and its PR, as garnish: on a short row they go before kube, the session name and the style.
  const forge = cols < FORGE_MIN_COLS && !st.desktop ? [] : [slot('forge', () => forgeSeg(st, v.forge))]
  if (linesRow === 1) {
    lines.prio = 8.5
    for (const f of forge) Object.assign(f, { optional: true, prio: 3.5 })
    ident.push(git, pr, ...forge, lines, kube, ...agent)
  } else {
    ident.push(git, kube, pr, ...agent)
  }

  const extras: Seg[] = []
  if (v.sessionName) {
    const name = clean(v.sessionName)
    extras.push(seg('session', 4, [c(st, P.DIM, clip(name, 28), false, true), c(st, P.DIM, clip(name, 12), false, true)], { optional: true }))
  }
  const style = clean(v.outputStyle ?? '')
  if (style && style.toLowerCase() !== 'default') extras.push(seg('style', 5, [c(st, P.DIM, `✎ ${clip(style, 20)}`)], { optional: true }))
  if (v.vim) extras.push(seg('vim', 3, [c(st, P.DIM, `[${clean(v.vim).slice(0, 1)}]`)], { optional: true }))
  // The script draws the counts at the far right, after the garnish.
  const tail = linesRow === 1 ? [] : forge

  const budgets = [
    slot('ctx', () => ctxSeg(st, v.context)),
    ...WINDOWS.map(([label, kind, window, prio]) => slot(label, () => limitSeg(st, label, limit(kind), window, prio, nowS))),
    safe('spend', () => spendSeg(st, limit('spend_limit'), nowS)),
  ]
  const stats = [
    slot('cache', () => cacheSeg(st, v.cache, nowS)),
    slot('cost', () => costSeg(st, v.costUsd)),
    slot('time', () => timeSeg(st, v.durationMs, v.apiMs, pend.has('api'))),
    ...(linesRow === 2 ? [lines] : []),
  ]
  // Every source or segment that failed, as a dim ✗name at the end of row 1, so a screenshot says why a
  // segment is missing.
  const names = [...new Set(failed)]
  const notice = names.length ? [seg('failed', 9, [c(st, 'faint', names.map((n) => `✗${n}`).join(' '))])] : []
  const out = rows === 1 ? [fit(st, [...ident, ...extras, ...tail, ...notice, ...budgets, ...stats], budget)] : [fit(st, [...ident, ...extras, ...tail, ...notice], budget), fit(st, [...budgets, ...stats], budget)]
  return out.filter((r) => r.length)
}

// The thin dim rule drawn above the rows, the band's width, so the band stands apart from the transcript.
export const rule = (st: Style, width: number): Part => c(st, st.P.TRACK, '─'.repeat(Math.max(1, width)))

// ---- parsers for what git, gh, glab, kubectl and the transcript print ----

export function parsePorcelain(out: string, skipUntracked: boolean): GitInfo {
  const g: GitInfo = { branch: '', oid: '', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: skipUntracked ? null : 0, conflicts: 0 }
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) g.branch = line.slice(14)
    else if (line.startsWith('# branch.oid ')) g.oid = line.slice(13, 20)
    else if (line.startsWith('# branch.ab ')) {
      const [a = '+0', b = '-0'] = line.slice(12).split(' ')
      g.ahead = Number(a.slice(1)) || 0
      g.behind = Number(b.slice(1)) || 0
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line[2] !== '.') g.staged++
      if (line[3] !== '.') g.modified++
    } else if (line.startsWith('u ')) g.conflicts++
    else if (line.startsWith('? ') && g.untracked !== null) g.untracked++
  }
  return g
}

export function parseNumstat(out: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const row of out.split('\n')) {
    const [a = '', r = ''] = row.split('\t')
    if (/^\d+$/.test(a)) added += Number(a)
    if (/^\d+$/.test(r)) removed += Number(r)
  }
  return { added, removed }
}

// `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir`: the worktree's name when this is a
// linked worktree (its own git dir differs from the shared one), else null.
export function parseWorktree(out: string): string | null {
  const [top = '', gitDir = '', common = ''] = out.split('\n').map((s) => s.trim())
  if (!top || !gitDir || !common) return null
  const norm = (p: string) => (p.startsWith('/') ? p : `${top}/${p}`).replace(/\/+$/, '').replace(/\/\.git$/, '/.git')
  if (norm(gitDir) === norm(common) || !gitDir.includes('/worktrees/')) return null
  return top.split('/').filter(Boolean).pop() ?? null
}

const REMOTE = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+(?=\/))?[:/](.+?)(?:\.git)?\/?$/i
const REMOTE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const REMOTE_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/
export const TRUSTED_FORGES: Record<string, 'github' | 'gitlab'> = { 'github.com': 'github', 'gitlab.com': 'gitlab' }

// (host, owner/repo) from an ssh, scp-style or https remote URL; null for local paths and odd shapes.
export function parseRemote(url: string): { host: string; path: string } | null {
  const u = url.trim()
  const m = u.startsWith('/') || u.startsWith('.') ? null : REMOTE.exec(u)
  if (!m || !REMOTE_HOST.test(m[1] ?? '') || !REMOTE_PATH.test(m[2] ?? '')) return null
  if ((m[2] ?? '').split('/').some((p) => p === '.' || p === '..')) return null
  return { host: (m[1] ?? '').toLowerCase(), path: m[2] ?? '' }
}

// Only github.com, gitlab.com and hosts the person declared: a repository's own remote is untrusted input and
// must not point the logged-in gh or glab at an arbitrary server.
export const providerFor = (host: string, declared: Record<string, 'github' | 'gitlab'>): 'github' | 'gitlab' | null => declared[host] ?? TRUSTED_FORGES[host] ?? null

export const GH_QUERY = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN){totalCount} issues(states:OPEN){totalCount}}}'

export function parseGhCounts(json: string): { prs: number; issues: number } {
  const repo = (JSON.parse(json) as { data?: { repository?: { pullRequests?: { totalCount?: unknown }; issues?: { totalCount?: unknown } } } }).data?.repository
  const prs = repo?.pullRequests?.totalCount
  const issues = repo?.issues?.totalCount
  if (typeof prs !== 'number' || typeof issues !== 'number') throw new Error('no counts')
  return { prs, issues }
}

// `gh pr list --json number,isDraft,reviewDecision --limit 1`
export function parseGhPr(json: string): Pr | null {
  const rows: unknown = JSON.parse(json)
  const r = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
  if (!r || typeof r.number !== 'number') return null
  const state = r.isDraft ? 'draft' : r.reviewDecision === 'APPROVED' ? 'approved' : r.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested' : 'pending'
  return { number: r.number, kind: 'pr', state }
}

// `glab api projects/<id>/merge_requests?state=opened&source_branch=<b>&per_page=1`
export function parseGlabMr(json: string): Pr | null {
  const rows: unknown = JSON.parse(json)
  const r = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
  if (!r || typeof r.iid !== 'number') return null
  return { number: r.iid, kind: 'mr', state: r.draft ? 'draft' : 'pending' }
}

// `kubectl config view --minify --output json`
export function parseKubectl(json: string): { ctx: string; ns: string } {
  const entry = ((JSON.parse(json) as { contexts?: { name?: string; context?: { namespace?: string } }[] }).contexts ?? [{}])[0] ?? {}
  return { ctx: entry.name ?? '', ns: entry.context?.namespace ?? '' }
}

// Without kubectl: the current context and its namespace read from the kubeconfig files' text, best effort.
export function kubeFromTexts(texts: string[]): { ctx: string; ns: string } {
  const found = texts.map((t) => /^current-context:\s*(.+?)\s*$/m.exec(t)?.[1]).filter((x): x is string => !!x)
  const ctx = (found[0] ?? '').replace(/^['"]|['"]$/g, '')
  if (!ctx) return { ctx: '', ns: '' }
  for (const text of texts) {
    const lines = text.split('\n')
    const start = lines.findIndex((l) => /^contexts:\s*$/.test(l))
    if (start < 0) continue
    const entries: string[][] = []
    let base: number | null = null
    for (const line of lines.slice(start + 1)) {
      if (line.trim() && !line.startsWith(' ') && !line.startsWith('-')) break
      const item = /^(\s*)- /.exec(line)
      if (item && (base === null || (item[1] ?? '').length <= base)) {
        base = (item[1] ?? '').length
        entries.push([])
      }
      entries[entries.length - 1]?.push(line)
    }
    for (const e of entries.map((x) => x.join('\n'))) {
      const name = /^\s*(?:-\s+)?name:\s*(.+?)\s*$/m.exec(e)
      if (name && (name[1] ?? '').replace(/^['"]|['"]$/g, '') === ctx) {
        const ns = /namespace:\s*([^\s,}]+)/.exec(e)
        return { ctx, ns: ns ? (ns[1] ?? '').replace(/^['"]|['"]$/g, '') : '' }
      }
    }
  }
  return { ctx, ns: '' }
}

// Running totals over the session transcript (append-only JSONL), folded one line at a time.
export type Transcript = {
  title: string | null
  effort: string | null
  fast: boolean
  ts: string | null
  ttl: number
  recent: string[]
  requests: number
  read: number
  create: number
  input: number
  misses: number
  // Lines from edit and write results since the last cost snapshot (or since the start without one).
  added: number
  removed: number
  // The engine's own running totals, as its latest `cost-state` entry saved them; `snapshots` counts them.
  snapshot: { apiMs: number; linesAdded: number; linesRemoved: number } | null
  snapshots: number
  // API requests since the last snapshot (or the start): ones from before this mod loaded were never timed.
  sinceSnapshot: number
}
export const emptyTranscript = (): Transcript => ({ title: null, effort: null, fast: false, ts: null, ttl: 300, recent: [], requests: 0, read: 0, create: 0, input: 0, misses: 0, added: 0, removed: 0, snapshot: null, snapshots: 0, sinceSnapshot: 0 })

// Session totals for the status line: the engine's last snapshot plus what came after it (lines from the
// transcript, API time from the requests this mod timed since the snapshot was read); without a snapshot,
// the transcript's lines and the mod's own API time. `untimed` counts requests after the last snapshot that
// ran before this mod loaded (a resumed session with no saved total, or one that ended without saving): their
// API time is unknown, so the total is null rather than a figure lower than the truth.
export function sessionTotals(t: Transcript, liveApiMs: number, apiAtSnapshot: number, untimed = 0): { apiMs: number | null; added: number; removed: number } {
  const known = untimed <= 0
  if (!t.snapshot) return { apiMs: known ? liveApiMs : null, added: t.added, removed: t.removed }
  return { apiMs: known ? t.snapshot.apiMs + Math.max(0, liveApiMs - apiAtSnapshot) : null, added: t.snapshot.linesAdded + t.added, removed: t.snapshot.linesRemoved + t.removed }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function absorb(s: Transcript, line: string): void {
  const entry = obj(JSON.parse(line))
  const kind = entry.type
  if (kind === 'custom-title' || kind === 'ai-title') {
    s.title = (entry.customTitle as string) || (entry.aiTitle as string) || s.title
  } else if (kind === 'assistant') {
    const message = obj(entry.message)
    const usage = message.usage && typeof message.usage === 'object' ? obj(message.usage) : null
    if (typeof entry.effort === 'string' && entry.effort) s.effort = entry.effort
    if (!usage) return
    s.fast = usage.speed === 'fast'
    s.ts = typeof entry.timestamp === 'string' ? entry.timestamp : s.ts
    const created = obj(usage.cache_creation)
    if (num(created.ephemeral_1h_input_tokens)) s.ttl = 3600
    else if (num(created.ephemeral_5m_input_tokens)) s.ttl = 300
    const id = String(message.id ?? '')
    if (s.recent.includes(id)) return // one API response is written as several entries
    s.recent = [...s.recent, id].slice(-64)
    const read = num(usage.cache_read_input_tokens)
    const create = num(usage.cache_creation_input_tokens)
    if (s.requests > 0 && read === 0 && create > 0) s.misses++
    s.requests++
    s.sinceSnapshot++
    s.read += read
    s.create += create
    s.input += num(usage.input_tokens)
  } else if (kind === 'cost-state') {
    // Cumulative, as the terminal's status line input has them (total_api_duration_ms, total_lines_*).
    s.snapshot = { apiMs: num(entry.totalAPIDuration), linesAdded: num(entry.totalLinesAdded), linesRemoved: num(entry.totalLinesRemoved) }
    s.snapshots++
    s.sinceSnapshot = 0
    s.added = 0
    s.removed = 0
  } else if (kind === 'user' && entry.toolUseResult && typeof entry.toolUseResult === 'object') {
    const result = obj(entry.toolUseResult)
    for (const hunk of Array.isArray(result.structuredPatch) ? result.structuredPatch : []) {
      for (const l of Array.isArray(obj(hunk).lines) ? (obj(hunk).lines as unknown[]) : []) {
        if (typeof l !== 'string') continue
        if (l.startsWith('+')) s.added++
        if (l.startsWith('-')) s.removed++
      }
    }
    if (result.type === 'create' && typeof result.content === 'string') s.added += result.content.split(/\r?\n/).length - (result.content.endsWith('\n') ? 1 : 0)
  }
}

// Bytes in UTF-8, so the read offset advances by what was consumed whatever the characters.
export function utf8Length(s: string): number {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

// Folds the complete lines of a chunk read from `offset`; a half-written last line waits for the next read.
// Returns the bytes consumed.
export function absorbChunk(s: Transcript, chunk: string): number {
  const end = chunk.lastIndexOf('\n')
  if (end < 0) return 0
  const body = chunk.slice(0, end + 1)
  for (const line of body.split('\n').slice(0, -1)) {
    try {
      absorb(s, line)
    } catch {
      // a line this version does not understand
    }
  }
  return utf8Length(body)
}

// The cache figures the status line shows, from the transcript totals; the script's Desktop derivation.
export function cacheFrom(s: Transcript, nowMs: number): PromptCache | null {
  if (!s.requests || !s.ts) return null
  const at = Date.parse(s.ts)
  if (!Number.isFinite(at)) return null
  const expiresAt = at + s.ttl * 1000
  const total = s.read + s.create + s.input
  return { observed: s.read + s.create > 0, warm: expiresAt > nowMs, expiresAt, requests: s.requests, misses: s.misses, hit: total ? s.read / total : null }
}

// The transcript Claude Code keeps for a session: under the config dir, in a folder named after the project
// root with every non-alphanumeric character replaced by a dash.
export const transcriptPath = (configDir: string, root: string, sessionId: string): string => `${configDir}/projects/${root.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`

// claude-<family>-<major>-<minor>[-yyyymmdd][[1m]] reads as "Family major.minor"; anything else as given.
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(?:\[[^\]]*\])?$/.exec(id)
  if (!m) return clean(id)
  const fam = m[1] ?? ''
  return `${fam.charAt(0).toUpperCase()}${fam.slice(1)} ${m[2]}.${m[3]}`
}

// ---- theme ----

// The "dark" colours from a Ghostty theme file (Noctalia generates one that follows the wallpaper).
export function noctaliaPalette(text: string): Palette | null {
  const slots = new Map<number, string>()
  for (const m of text.matchAll(/^\s*palette\s*=\s*(\d+)\s*=\s*#([0-9a-fA-F]{6})\s*$/gm)) slots.set(Number(m[1]), m[2] ?? '')
  const bg = /^\s*background\s*=\s*#([0-9a-fA-F]{6})\s*$/m.exec(text)
  if (!bg || ![1, 2, 3, 4].every((i) => slots.has(i))) return null
  const rgb = (h: string): Rgb => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb
  const ink = rgb(bg[1] ?? '')
  const [pink, mint, yellow, lav] = [1, 2, 3, 4].map((i) => rgb(slots.get(i) ?? '000000')) as [Rgb, Rgb, Rgb, Rgb]
  const toward = (share: number): Rgb => [0, 1, 2].map((i) => roundEven((ink[i] ?? 0) + ((lav[i] ?? 0) - (ink[i] ?? 0)) * share)) as unknown as Rgb
  return { MINT: mint, PINK: pink, YELLOW: yellow, LAV: lav, DIM: toward(0.75), TRACK: toward(0.55), INK: ink, BAR: [mint, yellow, pink] }
}

export type ThemeHints = { env: string | null; terminalEnv: string | null; colorFgBg: string | null; desktopMode: string | null; systemDark: boolean | null }

// The script's choice: an explicit theme, then COLORFGBG's background index, then (in Desktop) the app's own
// theme or the OS scheme it follows, else the mid-tone neutral palette that reads on dark and light alike.
export function pickTheme(surface: string, h: ThemeHints, available: (t: string) => boolean): ThemeName {
  const desktop = surface !== 'terminal'
  const wanted = (h.env || (desktop ? '' : h.terminalEnv || '')).toLowerCase()
  if (available(wanted)) return wanted as ThemeName
  const bgIndex = (h.colorFgBg ?? '').split(';').pop() ?? ''
  if (/^\d+$/.test(bgIndex)) return ['7', '15'].includes(bgIndex) ? 'light' : 'dark'
  if (desktop) {
    if (h.desktopMode === 'dark' || h.desktopMode === 'light') return h.desktopMode
    if (h.desktopMode === 'system' && h.systemDark !== null) return h.systemDark ? 'dark' : 'light'
  }
  return 'neutral'
}

// `gsettings get org.gnome.desktop.interface color-scheme` or the portal's color-scheme reply.
export function systemDark(out: string): boolean | null {
  if (out.includes('prefer-dark') || out.includes('uint32 1')) return true
  if (out.includes('prefer-light') || out.includes('uint32 2')) return false
  return null
}
