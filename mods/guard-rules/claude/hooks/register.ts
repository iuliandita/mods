import type { EngineInterface as Engine, Register } from 'claude-code'

import { applyGuardCommand, type Classes } from './context'
import { evaluate, formatDeny, parseConfig, type Env } from './rules'
import { extractCalls } from './shell'

async function stored($: Engine): Promise<Classes> {
  const raw = await $.store.get('contexts')
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, 'protected' | 'relaxed'] => entry[1] === 'protected' || entry[1] === 'relaxed'))
}

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'guard-context',
      description: 'Classify a kubectl/helm/terraform environment on this machine.',
      argumentHint: '<name> protected|relaxed | forget <name> | list',
    })
    return next(e)
  })

  on('command.run', { command: 'guard-context' }, async ($, e) => {
    const result = applyGuardCommand(e.args, e.origin, await stored($), cfg)
    if (result.stored) await $.store.set('contexts', result.stored)
    return { text: result.text }
  }).catch(() => ({ text: 'guard-context: the command failed, nothing was changed. Check the debug log.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const probe = extractCalls(e.command, '/', '/')
    if (probe.ok && probe.calls.length === 0) return next(e)
    const run = async (dir: string, argv: string[], vars?: Record<string, string>) => {
      try {
        const r = await $.process.run(argv, { cwd: dir, timeoutMs: 10_000, ...(vars && Object.keys(vars).length ? { env: vars } : {}) })
        return { ok: r.exitCode === 0, out: r.stdout.trim() }
      } catch {
        return { ok: false, out: '', failed: true }
      }
    }
    const env: Env = {
      cwd: await $.session.cwd(),
      home: (await $.env.get('HOME')) ?? '/',
      git: (dir, args, vars) => run(dir, ['git', '-C', dir, ...args], vars),
      run,
      contexts: () => stored($),
      exists: async (path) => {
        const r = await $.process.run(['test', '-e', path], { timeoutMs: 10_000 })
        if (r.exitCode === 0) return true
        if (r.exitCode === 1) return false
        throw new Error('Cannot check kubeconfig existence')
      },
      read: async (path) => {
        try {
          return await $.fs.read(path)
        } catch {
          return null
        }
      },
    }
    const verdict = await evaluate(e.command, cfg, env)
    if (verdict.dry.length) $.ui.toast(`guard-rules (dry run): ${verdict.dry.map((v) => v.message).join(' | ')}`)
    if (verdict.enforced.length) return { deny: formatDeny(verdict.enforced) }
    return next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'guard-rules: the guard failed, so the command was blocked (fail closed). Check the plugin options and the debug log. If this keeps happening, set modeAttribution, modeProtectedBranch and modeIdentity to off in the plugin options (modeContext for kubectl, helm and terraform), or disable the plugin.' },
  )
}
