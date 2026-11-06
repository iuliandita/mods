import type { EngineInterface as Engine, Register } from 'claude-code'

import { claudeChild, deliver, parseConfig, platformFromUname, wanted, withContext, claudeNotice, type Config, type Fs, type Pending } from './notify'

const TIMEOUT_MS = 5_000

type State = { platform: string | null; warned: boolean; question: string | null }

async function skipped($: Engine): Promise<boolean> {
  return claudeChild({
    IULIANDITA_MODS_NOTIFY: await $.env.get('IULIANDITA_MODS_NOTIFY').catch(() => undefined),
    T3CODE_THREAD_ID: await $.env.get('T3CODE_THREAD_ID').catch(() => undefined),
    CLAUDE_CODE_ENTRYPOINT: await $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined),
  })
}

async function platformOf($: Engine, s: State): Promise<string> {
  if (s.platform === null) {
    try {
      const r = await $.process.run(['uname', '-s'], { timeoutMs: TIMEOUT_MS })
      s.platform = r.exitCode === 0 ? platformFromUname(r.stdout) : 'unknown'
    } catch {
      s.platform = 'unknown'
    }
  }
  return s.platform
}

// A failure shows once per session as a toast and never reaches the session.
// The engine's file access, for the repo and branch lookup.
const engineFs = ($: Engine): Fs => ({
  async read(path) {
    try {
      const text: unknown = await $.fs.read(path)
      return typeof text === 'string' ? text : null
    } catch {
      return null
    }
  },
  async exists(path) {
    try {
      await $.fs.stat(path)
      return true
    } catch {
      return false
    }
  },
})

async function homeOf($: Engine): Promise<string | null> {
  try {
    return (await $.env.get('HOME')) ?? null
  } catch {
    return null
  }
}

async function show($: Engine, s: State, cfg: Config, pending: Pending): Promise<void> {
  const notice = await withContext(pending, await homeOf($), engineFs($))
  const result = await deliver((argv) => $.process.run(argv, { timeoutMs: TIMEOUT_MS }), await platformOf($, s), notice, cfg.sound)
  if (result.ok || s.warned) return
  s.warned = true
  try {
    await $.ui.toast(result.warning)
  } catch {
    // a toast must never surface as an error
  }
}

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  // off: no hook, no process.
  if (cfg.mode === 'off') return
  const s: State = { platform: null, warned: false, question: null }

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    try {
      // A Stop hook that blocks makes the turn go on: nothing finished yet.
      const notice = claudeNotice('Stop', e, cfg.state)
      if (s.question === null && result?.block === undefined && wanted(cfg, notice) && !await skipped($)) await show($, s, cfg, notice)
    } catch {
      // fail open: a notification is never worth a failed turn
    }
    return result
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const result = await next(e)
    try {
      const notice = claudeNotice('Notification', e)
      if (s.question === null && wanted(cfg, notice) && !await skipped($)) await show($, s, cfg, notice)
    } catch {
      // fail open
    }
    return result
  }).catch(($, e, next) => next(e))

  // Native question cards do not consistently raise Notification on every surface.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (s.question !== e.requestId && cfg.events.has('input') && !await skipped($)) {
        s.question = e.requestId
        await show($, s, cfg, { kind: 'input', harness: 'Claude Code', cwd: await $.session.cwd(), reason: 'Needs your input' })
      }
    } catch { /* fail open */ }
    return result
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', { tool_name: 'AskUserQuestion' }, async (_$, e, next) => {
    s.question = null
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.PostToolUseFailure', { tool_name: 'AskUserQuestion' }, async (_$, e, next) => {
    s.question = null
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async (_$, e, next) => {
    s.question = null
    return next(e)
  }).catch(($, e, next) => next(e))
}
