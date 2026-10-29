import type { EngineInterface as Engine, Register } from 'claude-code'
import { runsValues, VALUES_DENIED } from './commands'

import { makeScrubber, MIN_LEN, placeholderNames, quote, rewriteCommand, scrubBlocks, scrubToolAnswer, withhold, type Block, type Scrubber } from './scrub'

type Mode = 'off' | 'dry' | 'on'

// An unreadable option counts as on, so a typo cannot switch the box off.
const parseMode = (v: unknown): Mode => (v === 'off' || v === 'dry' ? v : 'on')

function wrapperOf($: Engine): string {
  return `${$.plugin.root}/bin/secret-box`
}

const LOAD_FAILED = (wrapper: string) =>
  `secret-box: the stored secrets could not be loaded, so the command was blocked before it ran (fail closed). Check that secret-tool works and the keyring is unlocked (run "${quote(wrapper)} names" in a terminal), or set mode to off or dry in the plugin options. The placeholders were left as written and no value was read.`

const RETRY_MS = 30_000
// The engine rejects an $.fs.read over 4 MiB.
const MAX_SAVED_BYTES = 4 * 1024 * 1024

type State = {
  mode: Mode
  known: Map<string, string> | null
  scrubber: Scrubber | null
  inflight: Promise<boolean> | null
  failedAt: number | null
  warned: boolean
  fileWarned: boolean
}

async function nowMs($: Engine): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

// Reads every stored value through the wrapper. Never throws and never puts a value in a message.
async function fetchValues($: Engine, s: State): Promise<boolean> {
  try {
    const r = await $.process.run([wrapperOf($), 'values'], { timeoutMs: 10_000 })
    if (r.exitCode !== 0 || r.isStdoutTruncated) return false
    const raw: unknown = JSON.parse(r.stdout)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
    const values = new Map<string, string>()
    for (const [name, value] of Object.entries(raw)) if (typeof value === 'string') values.set(name, value)
    s.known = values
    s.scrubber = makeScrubber(values)
    return true
  } catch {
    return false
  }
}

function load($: Engine, s: State): Promise<boolean> {
  s.inflight ??= (async () => {
    try {
      const ok = await fetchValues($, s)
      s.failedAt = ok ? null : await nowMs($)
      if (!ok && s.known === null && !s.warned) {
        s.warned = true
        $.ui.toast('secret-box: scrubbing is off, could not load secrets')
      }
      return ok
    } finally {
      s.inflight = null
    }
  })()
  return s.inflight
}

// Waits for a load in flight; after a failed load, tries again at most once per RETRY_MS.
async function scrubberFor($: Engine, s: State): Promise<Scrubber | null> {
  if (s.known !== null) return s.scrubber
  if (s.inflight) await s.inflight
  else if (s.failedAt === null || (await nowMs($)) - s.failedAt >= RETRY_MS) await load($, s)
  return s.scrubber
}

// The engine saves a long output as a direct child of a directory named tool-results.
function inToolResults(p: string | undefined): boolean {
  if (typeof p !== 'string' || !p.startsWith('/')) return false
  const parts = p.slice(1).split('/')
  if (parts.some((x) => x === '' || x === '.' || x === '..')) return false
  return parts.length >= 2 && parts[parts.length - 2] === 'tool-results'
}

async function warnFile($: Engine, s: State, reason: string): Promise<void> {
  if (s.fileWarned) return
  s.fileWarned = true
  try {
    await $.ui.toast(`secret-box: could not scrub the saved output file (${reason}); it may contain a secret`)
  } catch {
    // a toast must never surface as an error
  }
}

// Rewrites the file a Bash result points at (the saved full output) with known values replaced.
// Never throws and never puts a path or text in a message; a failure leaves the file as it is and
// toasts once per session.
async function scrubSavedFile($: Engine, s: State, scrub: Scrubber, answer: unknown): Promise<void> {
  try {
    const rec = (answer as { result?: unknown } | null)?.result
    if (rec === null || typeof rec !== 'object') return
    const paths = new Set<string>()
    for (const k of ['persistedOutputPath', 'rawOutputPath']) {
      const p = (rec as Record<string, unknown>)[k]
      if (typeof p === 'string' && p !== '') paths.add(p)
    }
    for (const path of paths) {
      let reason = 'unreadable'
      try {
        const st = await $.fs.stat(path, { resolve: true })
        if (st.kind !== 'file' || st.isLink || !inToolResults(path) || !inToolResults(st.realPath)) {
          reason = 'unexpected-path'
          throw new Error(reason)
        }
        if (st.size > MAX_SAVED_BYTES) {
          reason = 'too-large'
          throw new Error(reason)
        }
        const text: unknown = await $.fs.read(path)
        if (typeof text !== 'string') throw new Error('binary')
        reason = 'scrub-failed'
        const r = scrub(text)
        if (r.text === text) continue
        reason = 'write-failed'
        await $.fs.write(path, r.text)
      } catch {
        await warnFile($, s, reason)
      }
    }
  } catch {
    // the file step must never throw to the engine
  }
}

// The values a command ran with stay in its own scrub even when the reload after it dropped or changed them.
function scrubberAfter(s: State, before: ReadonlyMap<string, string> | null, names: string[]): Scrubber | null {
  const stale = names.flatMap((n) => {
    const v = before?.get(n)
    return v !== undefined && s.known?.get(n) !== v ? [[n, v] as const] : []
  })
  return stale.length === 0 ? s.scrubber : makeScrubber([...(s.known ?? []), ...stale])
}

function status($: Engine, s: State, reloaded: boolean | null): string {
  const wrapper = wrapperOf($)
  const known = s.known
  const names = known ? [...known.keys()].sort() : []
  const short = known ? names.filter((n) => (known.get(n) as string).length < MIN_LEN) : []
  const lines = [`secret-box: mode ${s.mode}`]
  if (s.mode === 'off') lines.push('secrets: not loaded (mode is off)')
  else if (known === null) lines.push('secrets: could not be loaded (check secret-tool and that the keyring is unlocked)')
  else lines.push(`secrets: ${names.length ? names.join(', ') : 'none stored'}${reloaded === false ? ' (reload failed, showing the last load)' : ''}`)
  if (short.length) lines.push(`not scrubbed (shorter than ${MIN_LEN} characters): ${short.join(', ')}`)
  lines.push(`wrapper: ${wrapper}`, `add one with: ${quote(wrapper)} set NAME   (in a terminal; use {{secret:NAME}} in commands)`)
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const s: State = { mode: parseMode(options.mode), known: null, scrubber: null, inflight: null, failedAt: null, warned: false, fileWarned: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'secret-box',
      description: 'Show secret-box status, or reload the stored secrets.',
      argumentHint: '[reload]',
    })
    if (s.mode !== 'off') await load($, s)
    return next(e)
  })

  on('command.run', { command: 'secret-box' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg !== '' && arg !== 'reload') return { text: 'secret-box: usage is /secret-box or /secret-box reload.' }
    const reloaded = arg === 'reload' && s.mode !== 'off' ? await load($, s) : null
    return { text: status($, s, reloaded) }
  }).catch(() => ({ text: 'secret-box: the command failed. Check the debug log.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (s.mode === 'off') return next(e)
    if (s.mode === 'on' && runsValues(e.command)) return { deny: VALUES_DENIED }
    const names = placeholderNames(e.command)
    if (names.length === 0) {
      if (s.mode !== 'on') return next(e)
      const scrub = await scrubberFor($, s)
      const answer = await next(e)
      if (!scrub) return answer
      const clean = scrubToolAnswer(answer, scrub)
      await scrubSavedFile($, s, scrub, clean)
      return clean
    }
    if (s.mode === 'dry') {
      $.ui.toast(`secret-box (dry run): would resolve ${names.join(', ')} at execution time`)
      return next(e)
    }
    const wrapper = wrapperOf($)
    try {
      await $.fs.stat(wrapper)
    } catch {
      return { deny: `secret-box: the helper ${wrapper} was not found, so the command was blocked (fail closed). Reinstall the plugin.` }
    }
    const known = s.known
    if ((known === null || names.some((n) => !known.has(n))) && !(await load($, s))) {
      return { deny: LOAD_FAILED(wrapper) }
    }
    const before = s.known
    const result = await next({ ...e, command: rewriteCommand(wrapper, e.command) })
    await load($, s)
    const scrub = scrubberAfter(s, before, names)
    if (!scrub) return result
    const clean = scrubToolAnswer(result, scrub)
    await scrubSavedFile($, s, scrub, clean)
    return clean
  }).catch(async ($, e, next) => {
    if (next.called) {
      const answer = await next(e)
      return s.mode === 'on' && s.scrubber ? scrubToolAnswer(answer, s.scrubber) : answer
    }
    if (s.mode !== 'off' && e.tool === 'Bash' && (runsValues(e.command) || placeholderNames(e.command).length > 0)) {
      return { deny: 'secret-box: the hook failed, so the command was blocked before it ran (fail closed). Check the debug log, or set mode to off or dry in the plugin options. The placeholders were left as written and no value was read.' }
    }
    return next(e)
  })

  // Every door: any row kind can carry a value (an @-mentioned file, a diff, another agent's message).
  on('session.append', async ($, e, next) => {
    if (s.mode === 'off') return next(e)
    const scrub = await scrubberFor($, s)
    if (!scrub) return next(e)
    const r = scrubBlocks(e.message.content, scrub)
    if (r.names.length === 0) return next(e)
    if (s.mode === 'dry') {
      $.ui.toast(`secret-box (dry run): would replace ${r.names.join(', ')} in a ${e.door} row`)
      return next(e)
    }
    return next({ ...e, message: { ...e.message, content: r.content } })
  }).catch((_$, e, next) => {
    if (next.called || s.mode !== 'on' || !s.scrubber) return next(e)
    let content: Block[]
    try {
      content = scrubBlocks(e.message.content, s.scrubber).content
    } catch {
      content = withhold(Array.isArray(e.message.content) ? e.message.content : [])
    }
    return next({ ...e, message: { ...e.message, content } })
  })

  on('session.send', async ($, e, next) => {
    if (s.mode === 'off') return next(e)
    const scrub = await scrubberFor($, s)
    if (!scrub) return next(e)
    const r = scrub(e.text)
    if (r.names.length === 0) return next(e)
    if (s.mode === 'dry') {
      $.ui.toast(`secret-box (dry run): would replace ${r.names.join(', ')} in a sent message`)
      return next(e)
    }
    return next({ ...e, text: r.text })
  }).catch(($, e, next) =>
    next.called || s.mode !== 'on'
      ? next(e)
      : { isDelivered: false as const, reason: 'secret-box: the message could not be checked for secrets, so it was not sent (fail closed). Check the debug log.' },
  )
}
