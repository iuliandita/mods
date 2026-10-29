import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Runner } from '../claude/hooks/notify'
import { main, type Io } from './cli'
import { setup } from './opencode'
import { codexRunner, nodeRunner } from './run'

let root: string
let options: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'notify-host-'))
  options = join(root, 'notify.json')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const withOptions = (o: unknown) => writeFileSync(options, typeof o === 'string' ? o : JSON.stringify(o))

function world(over: Partial<Io> & { runner?: 'ok' | 'missing' | 'fail' } = {}) {
  const seen = { runs: [] as string[][], err: [] as string[] }
  const run: Runner = async (argv) => {
    seen.runs.push(argv)
    if (over.runner === 'missing') throw new Error('spawn notify-send ENOENT')
    return { exitCode: over.runner === 'fail' ? 1 : 0 }
  }
  const io = (stdin: string): Io => ({ stdin: async () => stdin, err: (s) => void seen.err.push(s), run, platform: 'linux', options, ...over })
  return { seen, io }
}

const hook = (name: string, cwd = '/work/my-repo') => JSON.stringify({ hook_event_name: name, cwd, session_id: 's' })

test('codex hook: Stop is a finish notice and PermissionRequest an input notice, titled with the folder', async () => {
  withOptions({})
  const { seen, io } = world()
  expect(await main(['hook'], io(hook('Stop')))).toBe(0)
  expect(await main(['hook'], io(hook('PermissionRequest')))).toBe(0)
  expect(await main(['hook'], io(hook('PreToolUse')))).toBe(0)
  expect(seen.runs.map((a) => a.slice(-2))).toEqual([['my-repo', 'Finished'], ['my-repo', 'Needs your permission']])
  expect(seen.err).toEqual([])
})

test('codex notify setting: the JSON argument counts, agent-turn-complete only', async () => {
  withOptions({})
  const { seen, io } = world()
  const payload = JSON.stringify({ type: 'agent-turn-complete', cwd: '/work/api', 'last-assistant-message': 'secret text' })
  expect(await main(['notify', payload], io(''))).toBe(0)
  expect(await main(['notify', JSON.stringify({ type: 'something-else', cwd: '/w' })], io(''))).toBe(0)
  expect(seen.runs).toEqual([['notify-send', '--app-name=mods', '--', 'api', 'Finished']])
  expect(JSON.stringify(seen.runs)).not.toContain('secret text')
})

test('codex skips subagent hooks and notify-setting events', async () => {
  withOptions({})
  const { seen, io } = world()
  for (const hook_event_name of ['Stop', 'PermissionRequest', 'SubagentStop']) {
    await main(['hook'], io(JSON.stringify({ hook_event_name, cwd: '/work/repo', agent_id: 'child' })))
  }
  await main(['notify', JSON.stringify({ type: 'agent-turn-complete', agent_id: 'child' })], io(''))
  expect(seen.runs).toEqual([])
  expect(seen.err).toEqual([])
})

test('codex hooks run in the background and a sleeping notifier is capped on both entry paths', async () => {
  withOptions({})
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../codex/hooks/hooks.json'), 'utf8'))
  for (const event of ['Stop', 'PermissionRequest']) {
    expect(manifest.hooks[event]).toHaveLength(1)
    expect(manifest.hooks[event][0].hooks).toHaveLength(1)
    expect(manifest.hooks[event][0].hooks[0].async).toBe(true)
  }
  const stub = join(root, 'sleeping-notifier')
  const started = join(root, 'notifier-started')
  writeFileSync(stub, '#!/bin/sh\ntrap "" TERM\nprintf started > "$1"\nexec sleep 5\n', { mode: 0o755 })
  for (const command of ['hook', 'notify']) {
    rmSync(started, { force: true })
    const { seen, io } = world({ run: () => codexRunner([stub, started]) })
    const begin = performance.now()
    const argv = command === 'hook' ? ['hook'] : ['notify', JSON.stringify({ type: 'agent-turn-complete' })]
    expect(await main(argv, io(hook('PermissionRequest')))).toBe(0)
    expect(performance.now() - begin).toBeLessThan(1_500)
    expect(readFileSync(started, 'utf8')).toBe('started')
    expect(seen.err).toHaveLength(1)
    expect(seen.err[0]).toContain('notify-send failed')
  }
})

test('options from the user file: events, sound, mode off, and a broken file gives defaults with a warning', async () => {
  const { seen, io } = world()
  withOptions({ events: 'input' })
  await main(['hook'], io(hook('Stop')))
  expect(seen.runs).toEqual([])
  withOptions({ sound: 'on' })
  await main(['hook'], io(hook('Stop')))
  expect(seen.runs[0]).toContain('--hint=string:sound-name:message-new-instant')
  withOptions({ mode: 'off' })
  seen.runs.length = 0
  await main(['hook'], io(hook('Stop')))
  expect(seen.runs).toEqual([])
  withOptions('{ broken')
  await main(['hook'], io(hook('Stop')))
  expect(seen.runs).toHaveLength(1)
  expect(seen.err[0]).toContain('notify: warning: options ignored')
})

test('a missing or failing notifier, bad input and a macOS host never fail the hook', async () => {
  withOptions({})
  const missing = world({ runner: 'missing' })
  expect(await main(['hook'], missing.io(hook('Stop')))).toBe(0)
  expect(missing.seen.err).toEqual(['notify: warning: notify-send not found: no notification was shown; install it or set mode to off'])
  const failing = world({ runner: 'fail' })
  expect(await main(['hook'], failing.io(hook('Stop')))).toBe(0)
  expect(failing.seen.err[0]).toContain('exited 1')
  const bad = world()
  for (const text of ['', 'not json', '[]', 'null']) expect(await main(['hook'], bad.io(text))).toBe(0)
  expect(bad.seen.runs).toEqual([])
  const mac = world({ platform: 'darwin' })
  await main(['hook'], mac.io(hook('Stop')))
  expect(mac.seen.runs[0]?.[0]).toBe('osascript')
  const win = world({ platform: 'win32' })
  expect(await main(['hook'], win.io(hook('Stop')))).toBe(0)
  expect(win.seen.err[0]).toContain('no notifier for win32')
})

test('an unknown command is a usage error', async () => {
  const { seen, io } = world()
  expect(await main(['serve'], io(''))).toBe(2)
  expect(await main([], io(''))).toBe(2)
  expect(seen.err[0]).toStartWith('notify: error: unknown command')
})

test('the node runner resolves an exit code and rejects only when the program is missing', async () => {
  expect(await nodeRunner(['true'])).toEqual({ exitCode: 0 })
  expect(await nodeRunner(['false'])).toEqual({ exitCode: 1 })
  await expect(nodeRunner(['notify-no-such-program-here'])).rejects.toThrow()
})

type Ev = { type: string; data?: Record<string, unknown> }

// An event stream the test feeds by hand, ended by the abort signal.
function stream() {
  const queue: Ev[] = []
  let wake: (() => void) | null = null
  let aborted = false
  const ctx = {
    location: { directory: '/work/my-repo' },
    event: {
      async *subscribe(o?: { signal?: AbortSignal }) {
        o?.signal?.addEventListener('abort', () => ((aborted = true), wake?.()))
        while (!aborted) {
          while (queue.length) yield queue.shift() as never
          if (aborted) return
          await new Promise<void>((r) => (wake = r))
        }
      },
    },
  }
  const push = (e: Ev) => (queue.push(e), wake?.())
  return { ctx, push, isAborted: () => aborted }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

test('opencode: idle, permission and form events notify; subagent sessions and other events do not', async () => {
  withOptions({})
  const { ctx, push, isAborted } = stream()
  const runs: string[][] = []
  const cleanup = await setup(ctx, { options, platform: 'linux', run: async (argv) => (runs.push(argv), { exitCode: 0 }) })
  push({ type: 'session.created', data: { sessionID: 'main' } })
  push({ type: 'session.created', data: { sessionID: 'child', parentID: 'main' } })
  push({ type: 'session.idle', data: { sessionID: 'child' } })
  push({ type: 'permission.asked', data: { sessionID: 'child' } })
  push({ type: 'session.execution.succeeded', data: { sessionID: 'main' } })
  push({ type: 'session.idle', data: { sessionID: 'main' } })
  push({ type: 'permission.asked', data: { sessionID: 'main' } })
  push({ type: 'form.created', data: { form: { sessionID: 'main' } } })
  await settle()
  expect(runs.map((a) => a.at(-1))).toEqual(['Finished', 'Needs your permission', 'Needs your input'])
  expect(runs.every((a) => a.at(-2) === 'my-repo')).toBe(true)
  cleanup()
  await settle()
  expect(isAborted()).toBe(true)
})

test('opencode: options are read per event and a failing notifier warns once', async () => {
  withOptions({ events: 'input' })
  const { ctx, push } = stream()
  const runs: string[][] = []
  const warnings: string[] = []
  const cleanup = await setup(ctx, { options, platform: 'linux', warn: (s) => void warnings.push(s), run: async (argv) => (runs.push(argv), Promise.reject(new Error('ENOENT'))) })
  push({ type: 'session.idle', data: { sessionID: 'main' } })
  await settle()
  expect(runs).toEqual([])
  withOptions({})
  push({ type: 'session.idle', data: { sessionID: 'main' } })
  push({ type: 'session.idle', data: { sessionID: 'main' } })
  await settle()
  expect(runs).toHaveLength(2)
  expect(warnings).toEqual(['notify: warning: notify-send not found: no notification was shown; install it or set mode to off'])
  cleanup()
})
