import type { EngineInterface as Engine, Register } from 'claude-code'

import { deliver, parseConfig, platformFromUname, wanted, claudeNotice, type Config, type Notice } from './notify'

const TIMEOUT_MS = 5_000

type State = { platform: string | null; warned: boolean }

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
async function show($: Engine, s: State, cfg: Config, notice: Notice): Promise<void> {
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
  const s: State = { platform: null, warned: false }

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    try {
      // A Stop hook that blocks makes the turn go on: nothing finished yet.
      const notice = claudeNotice('Stop', e)
      if (result?.block === undefined && wanted(cfg, notice)) await show($, s, cfg, notice)
    } catch {
      // fail open: a notification is never worth a failed turn
    }
    return result
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const result = await next(e)
    try {
      const notice = claudeNotice('Notification', e)
      if (wanted(cfg, notice)) await show($, s, cfg, notice)
    } catch {
      // fail open
    }
    return result
  }).catch(($, e, next) => next(e))
}
