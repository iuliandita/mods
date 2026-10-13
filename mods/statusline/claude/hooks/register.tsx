import type { EngineInterface as Engine, Register, SessionUsage, Timer } from 'claude-code'

import type { Config, Forge, GitInfo, Palette, Pr, Span, Style, ThemeHints, Transcript, View } from './segments'
import {
  absorbChunk, buildRows, cacheFrom, effectiveWindow, sessionTotals, emptyTranscript, GH_QUERY, ICONS, kubeFromTexts, modelName, noctaliaPalette, PALETTES,
  parseConfig, parseGhCounts, parseGhPr, parseGlabMr, parseKubectl, parseNumstat, parsePorcelain, parseRemote, parseWorktree,
  pickTheme, providerFor, rule, systemDark, transcriptPath,
} from './segments'

// Everything below runs off the render path: a refresh every `refreshSeconds` and after each main-loop turn
// fills the snapshot, and the band draws only what the snapshot already holds.
const GIT_TTL_MS = 5_000
const GIT_TIMEOUT_MS = 1_500
const SLOW_REPO_MS = 600_000
const REMOTE_TTL_MS = 300_000
const SSH_TTL_MS = 86_400_000
const KUBE_TIMEOUT_MS = 2_000
const KUBE_RETRY_MS = 30_000
const FORGE_TTL_MS = 300_000
const PR_TTL_MS = 120_000
const FORGE_TIMEOUT_MS = 10_000
const FORGE_STALE_MS = 1_800_000
const FORGE_ERROR_MS = 600_000
const UNSUPPORTED_MS = 3_600_000
const THEME_TTL_MS = 300_000
const TRANSCRIPT_TIMEOUT_MS = 3_000

type Target = { provider: 'github' | 'gitlab'; host: string; path: string }

type Snap = {
  cfg: Config
  model: string | null
  effort: string | null
  cwd: string | null
  root: string | null
  sessionId: string | null
  transcriptPath: string | null
  agent: string | null
  sessionTitle: string | null
  outputStyle: string | null
  settingsEffort: string | null
  windowSettings: Record<string, unknown>
  windowEnv: string | null
  usage: SessionUsage | null
  git: GitInfo | null
  worktree: string | null
  diff: { added: number; removed: number } | null
  gitAt: number
  slowUntil: number
  kube: { ctx: string; ns: string } | null
  kubeSig: string
  kubeError: { at: number } | null
  remote: { url: string; at: number } | null
  sshHosts: Map<string, { host: string; at: number }>
  target: Target | null
  pr: Pr | null
  prAt: number
  prKey: string
  forge: Forge | null
  forgeAt: number
  forgeDataAt: number
  forgeError: { at: number } | null
  unsupported: Map<string, number>
  tx: { path: string; offset: number; s: Transcript; caughtUp: boolean; apiAtSnapshot: number } | null
  hints: ThemeHints
  noctalia: Palette | null
  noColor: boolean
  themeAt: number
  apiMs: number
  shown: Set<string> // failures the script shows too: kube, forge
  sources: Set<string> // data sources whose last refresh failed
  busy: Set<string>
  timer: Timer | null
}

async function nowMs($: Engine): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

function redraw($: Engine): void {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // nothing drawn yet
  }
}

// One job of each name at a time; a failure is recorded under that name and loses only its segment.
async function job(s: Snap, name: string, fn: () => Promise<void>): Promise<void> {
  if (s.busy.has(name)) return
  s.busy.add(name)
  try {
    await fn()
    s.sources.delete(name)
  } catch {
    s.sources.add(name)
  } finally {
    s.busy.delete(name)
  }
}

const gitArgv = (cwd: string, ...args: string[]) => ['git', '-c', 'core.fsmonitor=false', '-C', cwd, '--no-optional-locks', ...args]
const missing = (err: unknown) => /ENOENT|not found|no such file/i.test(String(err))

async function refreshGit($: Engine, s: Snap): Promise<void> {
  const cwd = s.cwd
  if (!cwd) return
  const now = await nowMs($)
  s.gitAt = now
  const run = (args: string[]) => $.process.run(gitArgv(cwd, ...args), { cwd, timeoutMs: GIT_TIMEOUT_MS })
  const skip = now < s.slowUntil
  let res
  try {
    res = await run(['status', '--porcelain=v2', '--branch', skip ? '-uno' : '-uall'])
  } catch {
    // A timeout rejects: scan tracked files only, and remember the repo as slow for 10 minutes.
    s.slowUntil = now + SLOW_REPO_MS
    res = await run(['status', '--porcelain=v2', '--branch', '-uno'])
  }
  if (res.exitCode !== 0) {
    s.git = null
    s.worktree = null
    s.diff = null
    s.target = null
    return
  }
  s.git = parsePorcelain(res.stdout, now < s.slowUntil)
  const wt = await run(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'])
  s.worktree = wt.exitCode === 0 ? parseWorktree(wt.stdout) : null
  const diff = await run(['diff', '--numstat', 'HEAD'])
  s.diff = diff.exitCode === 0 ? parseNumstat(diff.stdout) : null
  if (!s.remote || now - s.remote.at > REMOTE_TTL_MS) {
    const remote = await run(['config', '--get', 'remote.origin.url'])
    s.remote = { url: remote.exitCode === 0 ? remote.stdout.trim() : '', at: now }
  }
}

// The real host behind an ssh config alias (`ssh -G` only reads the config; it never connects).
async function sshHost($: Engine, s: Snap, host: string, now: number): Promise<string> {
  const hit = s.sshHosts.get(host)
  if (hit && now - hit.at < SSH_TTL_MS) return hit.host
  let real = host
  try {
    const out = await $.process.run(['ssh', '-G', '--', host], { timeoutMs: 1_000 })
    const line = out.stdout.split('\n').find((l) => l.startsWith('hostname '))
    if (out.exitCode === 0 && line) real = line.slice(9).trim().toLowerCase()
  } catch {
    // unknown: the name stands for itself
  }
  s.sshHosts.set(host, { host: real, at: now })
  return real
}

async function forgeTarget($: Engine, s: Snap, now: number): Promise<Target | null> {
  const parsed = s.remote ? parseRemote(s.remote.url) : null
  if (!parsed) return null
  let { host } = parsed
  let provider = providerFor(host, s.cfg.forgeHosts)
  if (!provider) {
    const real = await sshHost($, s, host, now)
    if (real !== host) {
      host = real
      provider = providerFor(real, s.cfg.forgeHosts)
    }
  }
  if (!provider || (provider === 'github' && parsed.path.split('/').length !== 2)) return null
  return { provider, host, path: parsed.path }
}

async function cli($: Engine, s: Snap, argv: string[], cwd: string, now: number): Promise<string> {
  try {
    const res = await $.process.run(argv, { cwd, timeoutMs: FORGE_TIMEOUT_MS })
    if (res.exitCode !== 0) throw new Error(`${argv[0]} exited ${res.exitCode}`)
    return res.stdout
  } catch (err) {
    if (missing(err)) s.unsupported.set(argv[0] ?? '', now)
    throw err
  }
}

// Runs gh (GitHub) or glab (GitLab) for this repository's remote only: never on the render path, the counts at
// most every 5 minutes and the branch's PR every 2 minutes or on a branch change.
async function refreshForge($: Engine, s: Snap): Promise<void> {
  const cwd = s.cwd
  const now = await nowMs($)
  const target = s.cfg.forge && cwd && s.git ? await forgeTarget($, s, now) : null
  const key = target ? `${target.host}/${target.path}` : ''
  if (!target || !cwd || key !== (s.target ? `${s.target.host}/${s.target.path}` : '')) {
    s.forge = null
    s.pr = null
    s.forgeAt = 0
    s.prAt = 0
    s.forgeError = null
  }
  s.target = target
  if (!target || !cwd) return
  const tool = target.provider === 'github' ? 'gh' : 'glab'
  const since = s.unsupported.get(tool)
  if (since !== undefined && now - since < UNSUPPORTED_MS) return
  const enc = encodeURIComponent(target.path)
  if (now - s.forgeAt > FORGE_TTL_MS) {
    s.forgeAt = now
    try {
      if (target.provider === 'github') {
        const [owner = '', name = ''] = target.path.split('/')
        const counts = parseGhCounts(await cli($, s, ['gh', 'api', '--hostname', target.host, 'graphql', '-f', `query=${GH_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`], cwd, now))
        s.forge = { provider: 'github', ...counts, capped: false, stale: false }
      } else {
        const mrs: unknown = JSON.parse(await cli($, s, ['glab', 'api', '--hostname', target.host, `projects/${enc}/merge_requests?state=opened&per_page=100`], cwd, now))
        const project = JSON.parse(await cli($, s, ['glab', 'api', '--hostname', target.host, `projects/${enc}`], cwd, now)) as { open_issues_count?: unknown }
        const n = Array.isArray(mrs) ? mrs.length : 0
        s.forge = { provider: 'gitlab', prs: n, issues: typeof project.open_issues_count === 'number' ? project.open_issues_count : 0, capped: n >= 100, stale: false }
      }
      s.forgeDataAt = now
      s.forgeError = null
    } catch {
      s.forgeError = { at: now }
    }
  }
  if (s.forge && s.forgeError && now - s.forgeDataAt > FORGE_STALE_MS) s.forge = { ...s.forge, stale: true }
  if (!s.forge && s.forgeError && now - s.forgeError.at < FORGE_ERROR_MS && !s.unsupported.has(tool)) s.shown.add('forge')
  else s.shown.delete('forge')

  const branch = s.git?.branch ?? ''
  const prKey = `${key}@${branch}`
  if (!branch || branch === '(detached)') {
    s.pr = null
  } else if (prKey !== s.prKey || now - s.prAt > PR_TTL_MS) {
    s.prKey = prKey
    s.prAt = now
    try {
      s.pr =
        target.provider === 'github'
          ? parseGhPr(await cli($, s, ['gh', 'pr', 'list', '--repo', `${target.host}/${target.path}`, `--head=${branch}`, '--state', 'open', '--json', 'number,isDraft,reviewDecision', '--limit', '1'], cwd, now))
          : parseGlabMr(await cli($, s, ['glab', 'api', '--hostname', target.host, `projects/${enc}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=1`], cwd, now))
    } catch {
      // keep the last answer
    }
  }
}

// The current kube context and namespace, through kubectl, else read from the kubeconfig files. Re-read when a
// file changes; a failure shows as ✗kube and is retried after 30 seconds.
async function refreshKube($: Engine, s: Snap): Promise<void> {
  const now = await nowMs($)
  const home = (await $.env.get('HOME')) ?? ''
  const listed = ((await $.env.get('KUBECONFIG')) ?? '').split(':').filter(Boolean)
  const paths: string[] = []
  const sig: string[] = []
  for (const p of listed.length ? listed : [`${home}/.kube/config`]) {
    try {
      const st = await $.fs.stat(p)
      if (st.kind === 'file') {
        paths.push(p)
        sig.push(`${p}@${st.mtimeMs}`)
      }
    } catch {
      // not there
    }
  }
  if (!paths.length) {
    s.kube = null
    s.shown.delete('kube')
    return
  }
  const key = sig.join(':')
  if (key === s.kubeSig && (!s.kubeError || now - s.kubeError.at < KUBE_RETRY_MS)) return
  s.kubeSig = key
  try {
    let res
    try {
      res = await $.process.run(['kubectl', 'config', 'view', '--minify', '--output', 'json'], { timeoutMs: KUBE_TIMEOUT_MS })
    } catch (err) {
      if (!missing(err)) throw err
      res = null
    }
    if (res === null) s.kube = kubeFromTexts(await Promise.all(paths.map((p) => $.fs.read(p))))
    else if (res.exitCode === 0) s.kube = parseKubectl(res.stdout)
    else if (res.stderr.includes('current-context')) s.kube = { ctx: '', ns: '' }
    else throw new Error('kubectl failed')
    s.kubeError = null
    s.shown.delete('kube')
  } catch {
    s.kubeError = { at: now }
    s.kube = null
    s.shown.add('kube')
  }
}

// Folds what was appended to the session transcript since the last read: effort, fast mode, the session's
// title, cache totals and lines changed. Read with `tail -c +N`, at most 4 MiB a time, so a long transcript
// is caught up over several refreshes.
async function refreshTranscript($: Engine, s: Snap): Promise<void> {
  let path = s.transcriptPath
  if (!path && s.root && s.sessionId) {
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
    const guess = transcriptPath(dir, s.root, s.sessionId)
    if (await $.fs.exists(guess)) path = guess
  }
  // A new session names its transcript before the first message writes it: nothing to read yet, not a failure.
  if (!path || !(await $.fs.exists(path))) return
  const st = await $.fs.stat(path)
  if (!s.tx || s.tx.path !== path || st.size < s.tx.offset) s.tx = { path, offset: 0, s: emptyTranscript(), caughtUp: false, apiAtSnapshot: 0 }
  const tx = s.tx
  if (tx.offset < st.size) {
    const res = await $.process.run(['tail', '-c', `+${tx.offset + 1}`, path], { timeoutMs: TRANSCRIPT_TIMEOUT_MS })
    if (res.exitCode !== 0) throw new Error('tail failed')
    const before = tx.s.snapshots
    const used = absorbChunk(tx.s, res.stdout)
    // A snapshot read in the first catch-up predates every request this mod timed; one written while it runs
    // already holds what was timed until then.
    if (tx.s.snapshots !== before) tx.apiAtSnapshot = tx.caughtUp ? s.apiMs : 0
    // A single line longer than one read can never complete: skip what was read.
    tx.offset += used === 0 && res.isStdoutTruncated ? st.size - tx.offset : used
  }
  tx.caughtUp = tx.offset >= st.size
}

async function refreshTheme($: Engine, s: Snap): Promise<void> {
  const now = await nowMs($)
  if (now - s.themeAt < THEME_TTL_MS) return
  s.themeAt = now
  const opt = (p: Promise<string | undefined>) => p.then((v) => v ?? null, () => null)
  const home = (await opt($.env.get('HOME'))) ?? ''
  const xdg = (await opt($.env.get('XDG_CONFIG_HOME'))) || `${home}/.config`
  s.noColor = !!(await opt($.env.get('NO_COLOR')))
  s.hints = {
    env: await opt($.env.get('STATUSLINE_THEME')),
    terminalEnv: await opt($.env.get('STATUSLINE_TERMINAL_THEME')),
    colorFgBg: await opt($.env.get('COLORFGBG')),
    desktopMode: null,
    systemDark: null,
  }
  try {
    s.noctalia = noctaliaPalette(await $.fs.read(`${xdg}/ghostty/themes/noctalia`))
  } catch {
    s.noctalia = null
  }
  try {
    const mode = (JSON.parse(await $.fs.read(`${xdg}/Claude/config.json`)) as { userThemeMode?: unknown }).userThemeMode
    s.hints.desktopMode = typeof mode === 'string' ? mode : null
  } catch {
    s.hints.desktopMode = null
  }
  if (s.hints.desktopMode !== 'system') return
  const probes = [
    ['gsettings', 'get', 'org.gnome.desktop.interface', 'color-scheme'],
    ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/org/freedesktop/portal/desktop', '--method', 'org.freedesktop.portal.Settings.Read', 'org.freedesktop.appearance', 'color-scheme'],
  ]
  for (const argv of probes) {
    try {
      const res = await $.process.run(argv, { timeoutMs: 400 })
      const dark = res.exitCode === 0 ? systemDark(res.stdout) : null
      if (dark !== null) {
        s.hints.systemDark = dark
        return
      }
    } catch {
      // next probe
    }
  }
}

async function refresh($: Engine, s: Snap): Promise<void> {
  await job(s, 'cwd', async () => void (s.cwd = await $.session.cwd()))
  await job(s, 'model', async () => void (s.model = await $.session.model()))
  await job(s, 'usage', async () => void (s.usage = await $.session.usage()))
  await job(s, 'root', async () => void (s.root = await $.session.root()))
  await job(s, 'id', async () => void (s.sessionId = await $.session.id()))
  await job(s, 'settings', async () => {
    const set = await $.settings.read()
    s.outputStyle = typeof set.outputStyle === 'string' ? set.outputStyle : null
    s.settingsEffort = typeof set.effortLevel === 'string' ? set.effortLevel : null
    // The merged settings carry both window keys; only these two are kept.
    s.windowSettings = { autoCompactWindow: set.autoCompactWindow, modelSettings: set.modelSettings }
    if (!s.agent && typeof set.agent === 'string') s.agent = set.agent
  })
  await job(s, 'env', async () => void (s.windowEnv = (await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')) ?? null))
  // The style in force is the /config row: a style chosen in the session lives there, not in a settings file.
  await job(s, 'config', async () => {
    const row = (await $.config.list()).find((r) => r.key === 'outputStyle')
    if (row && typeof row.value === 'string') s.outputStyle = row.value
  })
  redraw($)
  const now = await nowMs($)
  const slow: Promise<void>[] = [
    job(s, 'theme', () => refreshTheme($, s)),
    job(s, 'transcript', () => refreshTranscript($, s)),
    job(s, 'kube', () => refreshKube($, s)),
  ]
  if (now - s.gitAt > GIT_TTL_MS) slow.push(job(s, 'git', () => refreshGit($, s)).then(() => job(s, 'forge', () => refreshForge($, s))))
  await Promise.all(slow)
  redraw($)
}

function kick($: Engine, s: Snap): void {
  if (!s.timer) s.timer = $.clock.every(s.cfg.refreshMs, () => void refresh($, s).catch(() => {}))
  void refresh($, s).catch(() => {})
}

function view(s: Snap, now: number): View {
  const u = s.usage
  const t = s.tx?.caughtUp ? s.tx.s : null
  const partial = s.tx?.s ?? null
  const totals = t && s.tx ? sessionTotals(t, s.apiMs, s.tx.apiAtSnapshot) : null
  const sessionLines = totals && totals.added + totals.removed > 0 ? { added: totals.added, removed: totals.removed, session: true } : null
  // The window lookup needs the model id and the settings; without either the ctx denominator may be wrong.
  const ctxwin = s.cfg.ctxWindow === 'auto' && (s.sources.has('settings') || s.sources.has('env') || !s.model) ? ['ctxwin'] : []
  return {
    now,
    model: s.model ? modelName(s.model) : null,
    effort: s.effort ?? partial?.effort ?? s.settingsEffort,
    fast: partial?.fast ?? false,
    cwd: s.cwd,
    worktree: s.worktree,
    git: s.git,
    kube: s.kube,
    pr: s.pr,
    agent: s.agent,
    sessionName: partial?.title ?? s.sessionTitle,
    outputStyle: s.outputStyle,
    vim: null,
    forge: s.forge,
    context: u?.context
      ? { ...u.context, limit: effectiveWindow({ mode: s.cfg.ctxWindow, engineWindow: u.context.window, model: s.model, settings: s.windowSettings, env: s.windowEnv }) }
      : null,
    limits: u?.rateLimits ?? [],
    costUsd: u?.cost?.usd ?? null,
    durationMs: u ? now - u.startedAt : null,
    apiMs: totals?.apiMs ?? s.apiMs,
    cache: t ? cacheFrom(t, now) : null,
    lines: sessionLines ?? (s.diff ? { ...s.diff, session: false } : null),
    failed: [...s.shown, ...s.sources, ...ctxwin],
  }
}

function styleFor(s: Snap, surface: string): Style {
  const available = (t: string) => t === 'dark' || t === 'light' || t === 'neutral' || (t === 'noctalia' && s.noctalia !== null)
  const theme = s.cfg.theme !== 'auto' && available(s.cfg.theme) ? s.cfg.theme : pickTheme(surface, s.hints, available)
  const P = theme === 'noctalia' ? (s.noctalia ?? PALETTES.neutral) : PALETTES[theme]
  return { P, glyph: ICONS[s.cfg.icons], tick: surface === 'terminal' ? '┃' : '●', noColor: s.noColor }
}

// Classic hook inputs carry what the engine's own calls do not: the transcript's path, the main thread's agent
// in an --agent session, the session's title and the turn's effort.
function noteClassic(s: Snap, e: { transcript_path?: string; agent_id?: string; agent_type?: string; session_title?: string; effort?: { level?: string } }): void {
  if (e.agent_id) return
  if (typeof e.transcript_path === 'string' && e.transcript_path) s.transcriptPath = e.transcript_path
  if (typeof e.agent_type === 'string' && e.agent_type) s.agent = e.agent_type
  if (typeof e.session_title === 'string' && e.session_title) s.sessionTitle = e.session_title
  if (typeof e.effort?.level === 'string' && e.effort.level) s.effort = e.effort.level
}

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  // off: no hook, no timer, no process.
  if (cfg.mode === 'off') return

  const s: Snap = {
    cfg, model: null, effort: null, cwd: null, root: null, sessionId: null, transcriptPath: null, agent: null, sessionTitle: null,
    outputStyle: null, settingsEffort: null, windowSettings: {}, windowEnv: null, usage: null, git: null, worktree: null, diff: null, gitAt: 0, slowUntil: 0,
    kube: null, kubeSig: '', kubeError: null, remote: null, sshHosts: new Map(), target: null, pr: null, prAt: 0, prKey: '',
    forge: null, forgeAt: 0, forgeDataAt: 0, forgeError: null, unsupported: new Map(), tx: null,
    hints: { env: null, terminalEnv: null, colorFgBg: null, desktopMode: null, systemDark: null }, noctalia: null, noColor: false,
    themeAt: 0, apiMs: 0, shown: new Set(), sources: new Set(), busy: new Set(), timer: null,
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      kick($, s)
    } catch {
      // fail soft: the band draws once a later event refreshes it
    }
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    try {
      // /clear and resume start another transcript.
      s.tx = null
      s.transcriptPath = null
      s.sessionTitle = null
      noteClassic(s, e)
    } catch {
      // fail soft
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    try {
      noteClassic(s, e)
    } catch {
      // fail soft
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) void refresh($, s).catch(() => {})
    return result
  })

  // Main-loop requests only: the effort each ran at and how long the API took. The stream beneath is passed
  // through untouched and read once; the bookkeeping around it never throws.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    let t0 = 0
    try {
      if (typeof e.effort === 'string') s.effort = e.effort
      t0 = await nowMs($)
    } catch {
      t0 = 0
    }
    const result = yield* next(e)
    try {
      if (t0) s.apiMs += Math.max(0, (await nowMs($)) - t0)
    } catch {
      // fail soft
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if (!s.usage && !s.model) {
      kick($, s)
      return next(e)
    }
    // The script lays a row out in the terminal's columns less 4; the band's own width is already net of the
    // engine's marks, so it is the whole budget here.
    const cols = (e.props.bodyColumns > 0 ? e.props.bodyColumns : 100) + 4
    const st = styleFor(s, e.surface)
    const rows = buildRows(st, view(s, await nowMs($)), cols, cfg.rows)
    if (!rows.length) return next(e)
    // Other mods' bands stack above this one; the status line sits next to the prompt, under its rule.
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const text = (sp: Span, i: number) => (
      <Text key={`s${i}`} color={sp.fg} backgroundColor={sp.bg} dimColor={sp.faint} bold={sp.bold} italic={sp.italic}>{sp.t}</Text>
    )
    return (
      <Box flexDirection="column">
        {below ?? null}
        {[rule(st, cols - 4), ...rows].map((row, r) => (
          <Box key={`row-${r}`} flexDirection="row">{row.map(text)}</Box>
        ))}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
