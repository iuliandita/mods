import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { finishReason, type Runner } from '../claude/hooks/notify'
import { main, type Io } from './cli'
import { setup } from './opencode'
import { codexRunner, nodeRunner } from './run'
import { codexChild, t3Child, t3Path } from './session'

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
  const io = (stdin: string): Io => ({ stdin: async () => stdin, err: (s) => void seen.err.push(s), run, platform: 'linux', options, env: {}, home: null, ...over })
  return { seen, io }
}

const hook = (name: string, cwd = '/work/my-repo') => JSON.stringify({ hook_event_name: name, cwd, session_id: 's' })

test('codex hook: Stop is a finish notice and PermissionRequest an input notice, titled with the folder and harness', async () => {
  withOptions({})
  const { seen, io } = world()
  expect(await main(['hook'], io(hook('Stop')))).toBe(0)
  expect(await main(['hook'], io(hook('PermissionRequest')))).toBe(0)
  expect(await main(['hook'], io(hook('PreToolUse')))).toBe(0)
  expect(seen.runs.map((a) => a.slice(-2))).toEqual([['my-repo (Codex)', 'Finished'], ['my-repo (Codex)', 'Needs your permission']])
  expect(seen.err).toEqual([])
})

test('codex notify setting: the JSON argument counts, agent-turn-complete only', async () => {
  withOptions({})
  const { seen, io } = world()
  const payload = JSON.stringify({ type: 'agent-turn-complete', cwd: '/work/api', 'last-assistant-message': 'secret text' })
  expect(await main(['notify', payload], io(''))).toBe(0)
  expect(await main(['notify', JSON.stringify({ type: 'something-else', cwd: '/w' })], io(''))).toBe(0)
  expect(seen.runs).toEqual([['env', '-u', 'LD_LIBRARY_PATH', '-u', 'LD_PRELOAD', 'notify-send', '--app-name=mods', '--', 'api (Codex)', 'Finished']])
  expect(JSON.stringify(seen.runs)).not.toContain('secret text')
})

test('codex reads the repo and branch from the real file tree, with no git process', async () => {
  withOptions({})
  const repo = join(root, 'proj')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n')
  const { seen, io } = world()
  await main(['hook'], io(hook('PermissionRequest', join(repo, 'src'))))
  expect(seen.runs.map((a) => a.slice(-2))).toEqual([['proj (Codex)', 'Needs your permission on feature/x']])
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

test('codex Stop is synchronous, PermissionRequest stays background, and both entry paths cap a sleeping notifier', async () => {
  withOptions({})
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../codex/hooks/hooks.json'), 'utf8'))
  for (const { event, background, timeout } of [
    { event: 'Stop', background: false, timeout: 1 },
    { event: 'PermissionRequest', background: true, timeout: 10 },
  ]) {
    expect(manifest.hooks[event]).toHaveLength(1)
    expect(manifest.hooks[event][0].hooks).toHaveLength(1)
    expect(manifest.hooks[event][0].hooks[0].async).toBe(background)
    expect(manifest.hooks[event][0].hooks[0].timeout).toBe(timeout)
  }
  const stub = join(root, 'sleeping-notifier')
  const started = join(root, 'notifier-started')
  writeFileSync(stub, '#!/bin/sh\ntrap "" TERM\nprintf started > "$1"\nexec sleep 5\n', { mode: 0o755 })
  for (const command of ['hook', 'notify']) {
    rmSync(started, { force: true })
    const { seen, io } = world({ run: () => codexRunner([stub, started]) })
    const begin = performance.now()
    const argv = command === 'hook' ? ['hook'] : ['notify', JSON.stringify({ type: 'agent-turn-complete' })]
    expect(await main(argv, io(hook('Stop')))).toBe(0)
    expect(performance.now() - begin).toBeLessThan(1_500)
    expect(readFileSync(started, 'utf8')).toBe('started')
    expect(seen.err).toHaveLength(1)
    expect(seen.err[0]).toContain('notify-send timed out')
  }
})

test('codex Stop waits for delivery before returning, and notifier failure still exits zero', async () => {
  withOptions({})
  const stub = join(root, 'finish-notifier')
  const delivered = join(root, 'finish-delivered')
  writeFileSync(stub, '#!/bin/sh\nsleep 0.05\nprintf finished > "$1"\n', { mode: 0o755 })
  const { seen, io } = world({ run: () => codexRunner([stub, delivered]) })
  expect(await main(['hook'], io(hook('Stop')))).toBe(0)
  expect(readFileSync(delivered, 'utf8')).toBe('finished')
  expect(seen.err).toEqual([])
  expect(await main(['hook'], world({ runner: 'fail' }).io(hook('Stop')))).toBe(0)
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
  expect(await codexRunner(['sleep', '5'])).toEqual({ exitCode: 1, timedOut: true })
})

test('the branch reader gives null for a named pipe instead of waiting on it', () => {
  const fifo = join(root, 'head-fifo')
  execFileSync('mkfifo', [fifo])
  const script = `import { nodeFs } from ${JSON.stringify(join(import.meta.dir, 'run.ts'))}; console.log(JSON.stringify(await nodeFs.read(process.argv.at(-1))))`
  expect(execFileSync(process.execPath, ['-e', script, fifo], { timeout: 3_000, encoding: 'utf8' }).trim()).toBe('null')
})

test('opencode: after a notifier timeout, later events start no notifier', async () => {
  withOptions({})
  const { ctx, push } = stream()
  const runs: string[][] = []
  const warnings: string[] = []
  const cleanup = await setup(ctx, { options, env: {}, home: null, platform: 'linux', warn: (s) => void warnings.push(s), run: async (argv) => (runs.push(argv), { exitCode: 1, timedOut: true }) })
  push({ type: 'permission.asked', data: { sessionID: 'main' } })
  push({ type: 'permission.asked', data: { sessionID: 'main' } })
  push({ type: 'session.idle', data: { sessionID: 'main' } })
  await settle()
  expect(runs).toHaveLength(1)
  expect(warnings).toEqual(['notify: warning: notify-send timed out: no notification was shown; check the desktop notification service'])
  cleanup()
})

type Ev = { type: string; created?: number; data?: Record<string, unknown> }

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

function t3Fixture(name: string) {
  const base = join(root, name)
  mkdirSync(join(base, 'userdata'), { recursive: true })
  const path = join(base, 'userdata', 'statev2.sqlite')
  const db = new Database(path)
  db.exec(`CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT);`)
  for (const [nativeId, thread, lineage] of [
    ['child', 'thread:delegated-task:one', {}],
    ['lineage', 'bare-child', { parentThreadId: 'main' }],
    ['main', 'bare-main', {}],
  ] as const) {
    db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)').run(thread, JSON.stringify({ nativeThreadRef: { nativeId } }))
    db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)').run(thread, JSON.stringify({ lineage }))
  }
  db.close()
  return { base, path, env: { T3CODE_HOME: base } }
}

test('built OpenCode bundle uses Node SQLite read-only and fails open without its driver', () => {
  withOptions({})
  const fixture = t3Fixture('node-t3')
  const before = readFileSync(fixture.path)
  const script = `
    const { setup } = await import(process.argv[1]);
    const runs = [];
    let end;
    const drained = new Promise(resolve => { end = resolve });
    const begin = performance.now();
    const cleanup = await setup({
      location: { directory: '/work/repo' },
      event: { async *subscribe() {
        for (const sessionID of ['child', 'lineage', 'main']) yield { type: 'session.idle', data: { sessionID } };
        end();
      } }
    }, { options: process.argv[3], home: null, env: { T3CODE_HOME: process.argv[2] }, platform: 'linux',
      run: async argv => { runs.push(argv.at(-1)); return { exitCode: 0 } } });
    await drained;
    cleanup();
    console.log(JSON.stringify({ runs, elapsed: performance.now() - begin }));
  `
  for (const unavailable of [false, true]) {
    const out = execFileSync('node', [...(unavailable ? ['--no-experimental-sqlite'] : []), '--input-type=module', '-e', script,
      pathToFileURL(join(import.meta.dir, '../opencode/server.js')).href, fixture.base, options], { encoding: 'utf8', timeout: 2_000 })
    const result = JSON.parse(out)
    expect(result.runs).toEqual(unavailable ? ['Finished', 'Finished', 'Finished'] : ['Finished'])
    expect(result.elapsed).toBeLessThan(750)
  }
  expect(readFileSync(fixture.path)).toEqual(before)
})

test('codex: child signals skip both entry paths; absent and broken evidence fails open', async () => {
  withOptions({})
  const fixture = t3Fixture('codex-t3')
  const before = readFileSync(fixture.path)
  const transcript = join(root, 'rollout.jsonl')
  const cases = [
    { meta: { source: 'exec' }, skip: true },
    { meta: { originator: 'codex_exec' }, skip: true },
    { meta: { thread_source: 'subagent' }, skip: true },
    { meta: { source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } }, skip: true },
    { meta: { source: 'vscode', originator: 'T3 Code' }, skip: false },
    { text: '{ broken\n', skip: false },
    { text: 'x'.repeat(70_000), skip: false },
    { text: '\n' + JSON.stringify({ type: 'session_meta', payload: { source: 'exec' } }), skip: false },
  ]
  for (const row of cases) {
    writeFileSync(transcript, row.text ?? JSON.stringify({ type: 'session_meta', payload: row.meta }) + '\n' + 'x'.repeat(70_000))
    expect(codexChild(transcript)).toBe(row.skip)
    for (const command of ['hook', 'notify']) {
      const { seen, io } = world()
      const payload = JSON.stringify({ hook_event_name: 'Stop', type: 'agent-turn-complete', transcript_path: transcript })
      await main(command === 'hook' ? ['hook'] : ['notify', payload], io(payload))
      expect(seen.runs.length).toBe(row.skip ? 0 : 1)
    }
  }
  for (const [session, t3, expected] of [
    ['child', 'auto', 0], ['lineage', 'auto', 0], ['main', 'auto', 1], ['unknown', 'auto', 1], ['child', 'off', 1],
  ]) {
    withOptions({ t3 })
    const { seen, io } = world({ env: fixture.env })
    await main(['hook'], io(JSON.stringify({ hook_event_name: 'Stop', session_id: session })))
    expect(seen.runs).toHaveLength(expected as number)
    seen.runs.length = 0
    await main(['notify', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': session })], io(''))
    expect(seen.runs).toHaveLength(expected as number)
  }
  expect(readFileSync(fixture.path)).toEqual(before)
  expect(t3Path({}, '/h')).toBe('/h/.t3/userdata/statev2.sqlite')
  expect(t3Path(fixture.env, '/h')).toBe(fixture.path)
  for (const path of ['missing', 'broken', 'schema']) {
    const base = join(root, path)
    mkdirSync(join(base, 'userdata'), { recursive: true })
    if (path === 'broken') writeFileSync(join(base, 'userdata/statev2.sqlite'), 'broken')
    if (path === 'schema') new Database(join(base, 'userdata/statev2.sqlite')).close()
    expect(await t3Child('child', { t3: 'auto' }, { T3CODE_HOME: base }, null)).toBe(false)
  }
  const locked = new Database(fixture.path)
  locked.exec('BEGIN EXCLUSIVE')
  const begin = performance.now()
  expect(await t3Child('child', { t3: 'auto' }, fixture.env, null)).toBe(false)
  expect(performance.now() - begin).toBeLessThan(200)
  locked.exec('ROLLBACK')
  locked.close()
  expect(codexChild(join(root, 'absent'))).toBe(false)
  expect(codexChild(root)).toBe(false)
})

test('codex: only fixed current-message labels reach the notifier; state off and process opt-out work', async () => {
  for (const [message, label] of [
    ['private text\n[done]\n\n', 'Done'], ['[needs you] private detail', 'Needs you'],
    ['[waiting] job', 'Running'], ['[partial] failure', 'Unfinished'],
    ['[done]\nprivate text', 'Finished'], ['[Done]', 'Finished'], [undefined, 'Finished'],
  ] as const) {
    expect(finishReason(message)).toBe(label)
    for (const [command, key] of [['hook', 'last_assistant_message'], ['notify', 'last-assistant-message']]) {
      for (const state of ['on', 'off']) {
        withOptions({ state })
        const { seen, io } = world()
        const payload = JSON.stringify({ hook_event_name: 'Stop', type: 'agent-turn-complete', [key as string]: message })
        await main(command === 'hook' ? ['hook'] : ['notify', payload], io(payload))
        expect(seen.runs[0]?.at(-1)).toBe(state === 'off' ? 'Finished' : label)
        expect(JSON.stringify(seen.runs)).not.toContain('private')
      }
    }
  }
  withOptions({})
  const { seen, io } = world({ env: { IULIANDITA_MODS_NOTIFY: 'off' } })
  await main(['hook'], io(hook('Stop')))
  await main(['notify', JSON.stringify({ type: 'agent-turn-complete' })], io(''))
  expect(seen.runs).toEqual([])
})

test('opencode: created, late-loaded, env and T3 children skip; missing evidence notifies', async () => {
  withOptions({})
  const fixture = t3Fixture('opencode-t3')
  for (const row of [
    { info: { parentID: 'main' }, skip: true }, { info: { title: 'T3 Code helper' }, skip: true },
    { info: {}, skip: false }, { broken: true, skip: false }, { slow: true, skip: false },
    { env: { OPENCODE_SESSION_ID: 'parent' }, skip: true }, { env: { OPENCODE_SESSION_ID: '' }, skip: true },
    { env: { IULIANDITA_MODS_NOTIFY: 'off' }, skip: true },
    { env: fixture.env, session: 'child', skip: true }, { env: fixture.env, session: 'lineage', skip: true },
    { env: fixture.env, session: 'main', skip: false }, { env: fixture.env, session: 'unknown', skip: false },
    { created: { title: 'T3 Code helper' }, skip: true }, { created: { parentID: 'main' }, skip: true },
  ]) {
    const { ctx, push } = stream()
    const runs: string[][] = []
    const cleanup = await setup({ ...ctx, session: { get: async () => {
      if (row.broken) throw new Error('unavailable')
      if (row.slow) return new Promise(() => {})
      return row.info ?? {}
    } } }, { options, home: null, env: row.env ?? {}, platform: 'linux', run: async (argv) => (runs.push(argv), { exitCode: 0 }) })
    if (row.created) push({ type: 'session.created', data: { sessionID: 'main', ...row.created } })
    push({ type: 'session.idle', data: { sessionID: row.session ?? 'main' } })
    await new Promise((r) => setTimeout(r, row.slow ? 200 : 30))
    expect(runs.length).toBe(row.skip ? 0 : 1)
    cleanup()
  }
})

test('opencode: current-turn state, unavailable context, state off, and question waits do not duplicate finish', async () => {
  for (const row of [
    { time: 100, label: 'Needs you' }, { time: 99, label: 'Finished' },
    { time: 100, state: 'off', label: 'Finished' }, { time: 100, noStart: true, label: 'Finished' },
    { broken: true, label: 'Finished' }, { slow: true, label: 'Finished' },
    { malformed: true, label: 'Finished' }, { time: 100, failed: true, label: 'Finished' },
  ]) {
    withOptions({ state: row.state ?? 'on' })
    const { ctx, push } = stream()
    const runs: string[][] = []
    const cleanup = await setup({ ...ctx, session: { context: async () => {
      if (row.broken) throw new Error('unavailable')
      if (row.slow) return new Promise(() => {})
      if (row.malformed) return {} as never
      return [{ type: 'assistant', time: { created: row.time ?? 0 }, content: [{ type: 'text', text: '[needs you] private' }] }]
    } } }, { options, env: {}, home: null, platform: 'linux', run: async (argv) => (runs.push(argv), { exitCode: 0 }) })
    if (!row.noStart) push({ type: 'session.execution.started', created: 100, data: { sessionID: 'main' } })
    if (row.failed) {
      push({ type: 'session.execution.failed', data: { sessionID: 'main' } })
      push({ type: 'session.execution.started', created: 200, data: { sessionID: 'main' } })
    }
    push({ type: 'session.execution.succeeded', data: { sessionID: 'main' } })
    push({ type: 'session.idle', data: { sessionID: 'main' } })
    await new Promise((r) => setTimeout(r, row.slow ? 200 : 30))
    expect(runs.map((a) => a.at(-1))).toEqual([row.label])
    cleanup()
  }
  withOptions({})
  for (const type of ['form.created', 'question.asked']) {
    const { ctx, push } = stream()
    const runs: string[][] = []
    const cleanup = await setup(ctx, { options, env: {}, home: null, platform: 'linux', run: async (argv) => (runs.push(argv), { exitCode: 0 }) })
    push({ type, data: { sessionID: 'main', form: { sessionID: 'main' } } })
    push({ type, data: { sessionID: 'main', form: { sessionID: 'main' } } })
    push({ type: 'session.idle', data: { sessionID: 'main' } })
    await settle()
    expect(runs.map((a) => a.at(-1))).toEqual(['Needs your input'])
    push({ type: 'form.replied', data: { sessionID: 'main' } })
    push({ type: 'session.execution.succeeded', data: { sessionID: 'main' } })
    await settle()
    expect(runs.map((a) => a.at(-1))).toEqual(['Needs your input', 'Finished'])
    cleanup()
  }
})

test('opencode: success, permission and form events notify; legacy idle does not duplicate success', async () => {
  withOptions({})
  const { ctx, push, isAborted } = stream()
  const runs: string[][] = []
  const cleanup = await setup(ctx, { options, env: {}, home: null, platform: 'linux', run: async (argv) => (runs.push(argv), { exitCode: 0 }) })
  push({ type: 'session.created', data: { sessionID: 'main' } })
  push({ type: 'session.created', data: { sessionID: 'child', parentID: 'main' } })
  push({ type: 'session.execution.succeeded', data: { sessionID: 'child' } })
  push({ type: 'session.idle', data: { sessionID: 'child' } })
  push({ type: 'permission.asked', data: { sessionID: 'child' } })
  push({ type: 'session.execution.succeeded', data: { sessionID: 'main' } })
  push({ type: 'session.idle', data: { sessionID: 'main' } })
  push({ type: 'permission.asked', data: { sessionID: 'main' } })
  push({ type: 'form.created', data: { form: { sessionID: 'main' } } })
  push({ type: 'session.execution.failed', data: { sessionID: 'main' } })
  await settle()
  expect(runs.map((a) => a.at(-1))).toEqual(['Finished', 'Needs your permission', 'Needs your input'])
  expect(runs.every((a) => a.at(-2) === 'my-repo (OpenCode)')).toBe(true)
  cleanup()
  await settle()
  expect(isAborted()).toBe(true)
})

test('opencode: options are read per event and a failing notifier warns once', async () => {
  withOptions({ events: 'input' })
  const { ctx, push } = stream()
  const runs: string[][] = []
  const warnings: string[] = []
  const cleanup = await setup(ctx, { options, env: {}, home: null, platform: 'linux', warn: (s) => void warnings.push(s), run: async (argv) => (runs.push(argv), Promise.reject(new Error('ENOENT'))) })
  push({ type: 'session.idle', data: { sessionID: 'main' } })
  await settle()
  expect(runs).toEqual([])
  withOptions({})
  push({ type: 'session.status', data: { sessionID: 'main', status: { type: 'busy' } } })
  push({ type: 'session.idle', data: { sessionID: 'main' } })
  push({ type: 'session.status', data: { sessionID: 'main', status: { type: 'busy' } } })
  push({ type: 'session.idle', data: { sessionID: 'main' } })
  await settle()
  expect(runs).toHaveLength(2)
  expect(warnings).toEqual(['notify: warning: notify-send not found: no notification was shown; install it or set mode to off'])
  cleanup()
})

test.each([
  { events: ['session.execution.succeeded'] },
  { events: ['session.idle'] },
  { events: ['session.execution.succeeded', 'session.idle'] },
  { events: ['session.idle', 'session.execution.succeeded'] },
])('opencode: completion names %j notify once per execution and separately per session', async ({ events }) => {
  withOptions({})
  const { ctx, push } = stream()
  const runs: string[][] = []
  const cleanup = await setup(ctx, { options, env: {}, home: null, platform: 'linux', run: async (argv) => (runs.push(argv), { exitCode: 0 }) })
  for (let turn = 0; turn < 2; turn++) {
    for (const sessionID of ['one', 'two']) push({ type: 'session.execution.started', data: { sessionID } })
    for (const type of events) {
      for (const sessionID of ['one', 'two']) {
        push({ type, data: { sessionID } })
        push({ type, data: { sessionID } })
      }
    }
  }
  await settle()
  expect(runs.map((argv) => argv.at(-1))).toEqual(['Finished', 'Finished', 'Finished', 'Finished'])
  cleanup()
})
