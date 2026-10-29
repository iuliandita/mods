import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SECRET = 'p@ss/w0rd-longer'
const B64 = 'cEBzcy93MHJkLWxvbmdlcg=='
const URL_FORM = 'p%40ss%2Fw0rd-longer'

const done = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Stands in for the engine beneath the plugin: the wrapper (`values`), its file, and the Bash tool.
// `files` is the fake disk behind fs.read and fs.write; `stats` overrides what fs.stat reports for a path
// ('throw' rejects it, 'hang' never answers).
function world(
  on: On,
  values: Record<string, string> | 'fail' | (() => Record<string, string>) = { 'api.token': SECRET, pin: 'abc' },
  bash: object = { stdout: 'ran', stderr: '', interrupted: false },
  files = new Map<string, string>(),
  stats = new Map<string, Record<string, unknown> | 'throw' | 'hang'>(),
) {
  const seen = { commands: [] as string[], loads: 0, toasts: [] as string[], reads: [] as string[], writes: [] as string[] }
  on('fs.stat', (_$, e) => {
    const over = stats.get(e.path)
    if (over === 'throw') throw new Error('EIO')
    if (over === 'hang') return new Promise<never>(() => {})
    return { value: { kind: 'file', size: files.get(e.path)?.length ?? 1, mtimeMs: 0, isLink: false, realPath: e.path, ...over } }
  })
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path)
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    seen.writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    if (e.argv[1] !== 'values') return done('', 1)
    seen.loads++
    return values === 'fail' ? done('', 1) : done(JSON.stringify(typeof values === 'function' ? values() : values))
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.commands.push(e.command)
    return { result: bash as never }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

const row = (text: string) => ({
  message: { type: 'user' as const, role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
  door: 'tool-result' as const,
  origin: { kind: 'tool' as const, tool: 'Bash' },
  uuid: 'u1',
})

test('a placeholder command runs through the wrapper, quoted, and the values reload after it', async ($, on) => {
  const seen = world(on)
  const r = await $.tool.call({ tool: 'Bash', command: `curl -H "Authorization: Bearer {{secret:api.token}}" it's` })
  expect(r.deny).toBeUndefined()
  expect(seen.commands).toHaveLength(1)
  expect(seen.commands[0]).toMatch(/^\S+\/bin\/secret-box exec -- 'curl -H "Authorization: Bearer \{\{secret:api\.token\}\}" it'\\''s'$/)
  expect(seen.loads).toBe(2)
})

test('a command without a valid placeholder is not touched and the values load once', async ($, on) => {
  const seen = world(on)
  for (const command of ['ls -la', 'echo {{secret:bad name}}', 'echo {{ secret:x }}']) {
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny).toBeUndefined()
  }
  expect(seen.commands).toEqual(['ls -la', 'echo {{secret:bad name}}', 'echo {{ secret:x }}'])
  expect(seen.loads).toBe(1)
})

test('model values calls are denied while the internal load and scrubbing still work', async ($, on) => {
  const seen = world(on, undefined, { stdout: SECRET })
  for (const command of ['secret-box values', '/opt/plugin/secret-box values', 'bash -c "secret-box values"', "secret-box exec --scrub -- 'secret-box values'"]) {
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny).toContain('reserved for the hook')
  }
  expect(seen.commands).toEqual([])
  const allowed = await $.tool.call({ tool: 'Bash', command: 'secret-box names' })
  expect(allowed.result).toEqual({ stdout: '{{secret:api.token}}' })
  expect(seen.loads).toBe(1)
})

test('a Bash call without a placeholder has a known value in its structured result replaced', async ($, on) => {
  world(on, undefined, { stdout: `t=${SECRET}`, stderr: `e ${B64}`, interrupted: false })
  const r = await $.tool.call({ tool: 'Bash', command: 'echo $TOKEN' })
  expect(r.result).toEqual({ stdout: 't={{secret:api.token}}', stderr: 'e {{secret:api.token}}', interrupted: false })
})

test('the saved output file is scrubbed in place once; a failure leaves it, toasts once, and the call still returns', async ($, on) => {
  const files = new Map([['/o/tool-results/ok.txt', `a ${SECRET} b`]])
  const bash = { stdout: `x ${SECRET}`, stderr: '', interrupted: false, persistedOutputPath: '/o/tool-results/ok.txt' }
  const seen = world(on, undefined, bash, files)
  const first = await $.tool.call({ tool: 'Bash', command: 'cat big' })
  expect(files.get('/o/tool-results/ok.txt')).toBe('a {{secret:api.token}} b')
  expect(seen.writes).toEqual(['/o/tool-results/ok.txt'])
  expect((first.result as { persistedOutputPath: string }).persistedOutputPath).toBe('/o/tool-results/ok.txt')
  expect(seen.toasts).toEqual([])
  bash.persistedOutputPath = '/o/tool-results/missing.txt'
  const r = await $.tool.call({ tool: 'Bash', command: 'cat big' })
  expect((r.result as { stdout: string }).stdout).toBe('x {{secret:api.token}}')
  expect(seen.writes).toEqual(['/o/tool-results/ok.txt'])
  expect(seen.toasts).toEqual(['secret-box: could not scrub the saved output file (unreadable); it may contain a secret'])
})

test('a link, a path outside or nested below tool-results, a path with .. and a file over 4 MiB are left alone with one toast', async ($, on) => {
  const text = `a ${SECRET}`
  const files = new Map([['/o/tool-results/link.txt', text], ['/o/other/x.txt', text], ['/o/tool-results/big.txt', text],
    ['/o/tool-results/sub/x.txt', text], ['/tool-results/o/x.txt', text], ['/o/tool-results/../other/x.txt', text]])
  const stats = new Map<string, Record<string, unknown>>([
    ['/o/tool-results/link.txt', { isLink: true }],
    ['/o/tool-results/big.txt', { size: 5 * 1024 * 1024 }],
  ])
  const bash = { stdout: `x ${SECRET}`, stderr: '', interrupted: false, persistedOutputPath: '' }
  const seen = world(on, undefined, bash, files, stats)
  for (const path of files.keys()) {
    bash.persistedOutputPath = path
    const r = await $.tool.call({ tool: 'Bash', command: 'cat big' })
    expect((r.result as { stdout: string }).stdout).toBe('x {{secret:api.token}}')
    expect(files.get(path)).toBe(text)
  }
  expect(seen.reads).toEqual([])
  expect(seen.writes).toEqual([])
  expect(seen.toasts).toEqual(['secret-box: could not scrub the saved output file (unexpected-path); it may contain a secret'])
})

test('the answer is scrubbed even when the file step throws or hangs (absorbed inside the hook), and no file work is redone', { timeoutMs: 120_000 }, async ($, on) => {
  const files = new Map([['/o/tool-results/a.txt', `a ${SECRET}`]])
  const stats = new Map<string, 'throw' | 'hang'>([['/o/tool-results/a.txt', 'throw'], ['/o/tool-results/b.txt', 'hang']])
  const bash = { stdout: `x ${SECRET}`, stderr: '', interrupted: false, persistedOutputPath: '/o/tool-results/a.txt' }
  const seen = world(on, undefined, bash, files, stats)
  for (const path of stats.keys()) {
    bash.persistedOutputPath = path
    const r = await $.tool.call({ tool: 'Bash', command: 'cat big' })
    expect((r.result as { stdout: string }).stdout).toBe('x {{secret:api.token}}')
  }
  expect(seen.reads).toEqual([])
  expect(seen.writes).toEqual([])
  expect(seen.toasts).toHaveLength(1)
})

test('a known value, its base64 and URL forms are replaced in a tool result; a short value is left', async ($, on) => {
  world(on)
  const session = mock.session(on)
  await $.session.append(row(`a ${SECRET} b ${B64} c ${URL_FORM} d abc`))
  const stored = session.appended()[0]?.message.content[0] as unknown as { content: string }
  expect(stored.content).toBe('a {{secret:api.token}} b {{secret:api.token}} c {{secret:api.token}} d abc')
})

test('a value this command used is scrubbed even when the reload after it no longer has it', async ($, on) => {
  let loads = 0
  const files = new Map([['/o/tool-results/r.txt', `a ${SECRET}`]])
  const bash = { stdout: `x ${SECRET}`, stderr: '', interrupted: false, persistedOutputPath: '/o/tool-results/r.txt' }
  world(on, (): Record<string, string> => (++loads === 1 ? { 'api.token': SECRET } : {}), bash, files)
  const r = await $.tool.call({ tool: 'Bash', command: 'curl {{secret:api.token}}' })
  expect(loads).toBe(2)
  expect((r.result as { stdout: string }).stdout).toBe('x {{secret:api.token}}')
  expect(files.get('/o/tool-results/r.txt')).toBe('a {{secret:api.token}}')
})

test('attachment, delivery, compaction and notice rows are scrubbed too', async ($, on) => {
  world(on)
  const session = mock.session(on)
  const rows = [
    { door: 'attachment', message: { type: 'attachment', name: 'nested_memory', role: 'user', isMeta: true } },
    { door: 'delivery', message: { type: 'user', role: 'user', isMeta: true } },
    { door: 'compaction', message: { type: 'user', role: 'user', isMeta: true } },
    { door: 'notice', message: { type: 'system', name: 'local_command' } },
  ] as const
  for (const [i, r] of rows.entries()) {
    await $.session.append({
      door: r.door,
      message: { ...r.message, content: [{ type: 'text', text: `t ${SECRET}` }] },
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: `u${i}`,
    } as never)
  }
  const texts = session.appended().map((a) => (a.message.content[0] as unknown as { text: string }).text)
  expect(texts).toEqual(rows.map(() => 't {{secret:api.token}}'))
})

test('when the values cannot be loaded the placeholder command is denied and never runs', async ($, on) => {
  const seen = world(on, 'fail')
  const denied = await $.tool.call({ tool: 'Bash', command: 'curl {{secret:api.token}}' })
  expect(denied.deny).toContain('fail closed')
  expect(denied.deny).not.toContain(SECRET)
  const plain = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(plain.deny).toBeUndefined()
  expect(seen.commands).toEqual(['ls'])
})

test('dry mode toasts what it would do and rewrites nothing', { options: { mode: 'dry' } }, async ($, on) => {
  const files = new Map([['/o/tool-results/ok.txt', `a ${SECRET}`]])
  const seen = world(on, undefined, { stdout: 'ran', stderr: '', interrupted: false, persistedOutputPath: '/o/tool-results/ok.txt' }, files)
  const session = mock.session(on)
  await $.tool.call({ tool: 'Bash', command: 'curl {{secret:api.token}}' })
  await $.tool.call({ tool: 'Bash', command: 'cat big' })
  expect(seen.reads).toEqual([])
  expect(seen.writes).toEqual([])
  expect(files.get('/o/tool-results/ok.txt')).toBe(`a ${SECRET}`)
  await $.session.append(row(`x ${SECRET}`))
  expect(seen.commands).toEqual(['curl {{secret:api.token}}', 'cat big'])
  expect((session.appended()[0]?.message.content[0] as unknown as { content: string }).content).toBe(`x ${SECRET}`)
  expect(seen.toasts).toHaveLength(2)
  expect(seen.toasts.join(' ')).toContain('api.token')
  expect(seen.toasts.join(' ')).not.toContain(SECRET)
})

test('a sent message has a known value replaced, and is not sent when the check fails', async ($, on) => {
  world(on)
  const sent: string[] = []
  on('session.send', (_$, e) => {
    sent.push(e.text)
    return { isDelivered: true as const }
  })
  const ok = await $.session.send({ to: 'a1', text: `use ${SECRET}` } as never)
  expect(ok.isDelivered).toBe(true)
  expect(sent).toEqual(['use {{secret:api.token}}'])
  const bad = await $.session.send({ to: 'a1', text: undefined } as never)
  expect(bad.isDelivered).toBe(false)
  expect(bad.reason).toContain('fail closed')
  expect(sent).toHaveLength(1)
})

test('/secret-box lists names only and says how to add one', async ($, on) => {
  world(on)
  on('command.register', () => ({ value: { command: 'secret-box' } }))
  on('session.start', () => ({ cwd: '/h' }))
  await $.session.start({ cwd: '/h', surface: null, isInteractive: false })
  const r = await $.command.run({ command: 'secret-box', args: '' } as never)
  expect(r.text).toContain('mode on')
  expect(r.text).toContain('api.token')
  expect(r.text).toContain('not scrubbed (shorter than 6 characters): pin')
  expect(r.text).toContain('add one with:')
  expect(r.text).not.toContain(SECRET)
})
