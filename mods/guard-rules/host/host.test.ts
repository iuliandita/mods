import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkCommand, checkTool } from './check'
import { main, type Io } from './cli'
import { configPath, loadClasses, loadConfig, nodeEnv } from './env'
import { setup } from './opencode'

let root: string
let repo: string
let other: string
let configFile: string
let storeFile: string

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' })

function io(stdin = '', interactive = false): Io & { stdout: string; stderr: string } {
  const o = { stdout: '', stderr: '', stdin: async () => stdin, out: (s: string) => void (o.stdout += s), err: (s: string) => void (o.stderr += s), interactive, config: configFile, store: storeFile }
  return o
}

const call = (command: string, cwd = repo, tool = 'Bash', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command, ...extra }, cwd })

const writeConfig = (text: string) => writeFileSync(configFile, text)

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-host-'))
  configFile = join(root, 'guard-rules.json')
  storeFile = join(root, 'data', 'contexts.json')
  repo = join(root, 'vault')
  other = join(root, 'vault-old')
  for (const dir of [repo, other]) {
    mkdirSync(dir)
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

test('config: a missing file is the defaults, a file that is not an object is an error that denies git writes', async () => {
  expect(loadConfig(configFile).error).toBeUndefined()
  expect(loadConfig(configFile).protectedBranches).toEqual(['develop', 'main'])
  writeConfig('[1]')
  expect(loadConfig(configFile).error).toContain('not a JSON object')
  writeConfig('{nope')
  expect(loadConfig(configFile).error).toContain('not a JSON object')
  const o = io(call('git commit -m x'))
  expect(await main(['hook'], o)).toBe(0)
  expect(JSON.parse(o.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  expect(o.stdout).toContain('settings are invalid')
  writeConfig('{}')
})

test('hook: a commit on a protected branch is denied with the decision Codex reads, a feature branch and other tools pass', async () => {
  const denied = io(call('git commit -m x'))
  expect(await main(['hook'], denied)).toBe(0)
  expect(JSON.parse(denied.stdout)).toEqual({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('protected branch "main"') },
  })
  expect(denied.stdout).toContain('in their own terminal')
  expect(denied.stdout).not.toContain('! prefix')
  const attribution = io(call('git commit -m "x\n\nCo-Authored-By: A <a@b.c>"', other))
  await main(['hook'], attribution)
  expect(JSON.parse(attribution.stdout).hookSpecificOutput.permissionDecisionReason).toContain('attribution')
  for (const stdin of [call('git status'), call('git commit -m x', repo, 'apply_patch'), call('ls')]) {
    const o = io(stdin)
    expect(await main(['hook'], o)).toBe(0)
    expect(o.stdout).toBe('')
  }
  git(repo, 'switch', '-q', '-c', 'feature/x')
  const feature = io(call('git commit -m x'))
  await main(['hook'], feature)
  expect(feature.stdout).toBe('')
  git(repo, 'switch', '-q', 'main')
})

test('hook: the directory a call runs in is its workdir when it has one', async () => {
  const o = io(call('git commit -m x', repo, 'Bash', { workdir: '../vault-old' }))
  await main(['hook'], o)
  expect(JSON.parse(o.stdout).hookSpecificOutput.permissionDecisionReason).toContain('protected branch "main"')
  writeConfig(JSON.stringify({ unprotectedRepos: other }))
  const exempt = io(call('git commit -m x', repo, 'Bash', { workdir: '../vault-old' }))
  await main(['hook'], exempt)
  expect(exempt.stdout).toBe('')
  writeConfig('{}')
})

test('hook: unprotectedRepos exempts the listed repository and nothing that merely shares its name prefix', async () => {
  writeConfig(JSON.stringify({ unprotectedRepos: repo }))
  const allowed = io(call('git commit -m x'))
  await main(['hook'], allowed)
  expect(allowed.stdout).toBe('')
  const sibling = io(call('git commit -m x', other))
  await main(['hook'], sibling)
  expect(JSON.parse(sibling.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  const attribution = io(call('git commit -m "x\n\nCo-Authored-By: A <a@b.c>"'))
  await main(['hook'], attribution)
  expect(attribution.stdout).toContain('attribution')
  writeConfig('{}')
})

test('hook: input it cannot read, or a check that runs out of time, is a block, not a pass', async () => {
  for (const stdin of ['not json', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, cwd: repo })]) {
    const o = io(stdin)
    expect(await main(['hook'], o)).toBe(2)
    expect(o.stderr).toContain('fail closed')
  }
  const slow = io(call('git commit -m x'))
  slow.deadlineMs = 0
  expect(await main(['hook'], slow)).toBe(0)
  expect(JSON.parse(slow.stdout).hookSpecificOutput.permissionDecisionReason).toContain('took too long')
})

test('dry mode reports through systemMessage and does not deny', async () => {
  writeConfig(JSON.stringify({ modeProtectedBranch: 'dry' }))
  const o = io(call('git commit -m x'))
  expect(await main(['hook'], o)).toBe(0)
  expect(JSON.parse(o.stdout).systemMessage).toContain('dry run')
  writeConfig('{}')
})

test('unparsed modes report or disable parser findings on both host adapters', async () => {
  let hook: (e: { tool: string; input: unknown }) => Promise<void> | void = () => {}
  await setup({ location: { directory: repo }, tool: { hook: async (_name, cb) => void (hook = cb) } }, { config: configFile })
  const warnings = spyOn(console, 'error').mockImplementation(() => {})
  for (const mode of ['on', 'dry', 'off', 'ask']) {
    writeConfig(JSON.stringify({ modeUnparsed: mode }))
    const o = io(call('xargs git push'))
    await main(['hook'], o)
    if (mode === 'on' || mode === 'ask') {
      expect(JSON.parse(o.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
      await expect(Promise.resolve(hook({ tool: 'shell', input: { command: 'xargs git push' } }))).rejects.toThrow('unparsed')
    } else {
      expect(o.stdout.includes('dry run')).toBe(mode === 'dry')
      await hook({ tool: 'shell', input: { command: 'xargs git push' } })
    }
    const parsed = io(call('git commit -m x'))
    await main(['hook'], parsed)
    expect(JSON.parse(parsed.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    if (mode === 'ask') {
      expect(o.stderr).toContain('treats it as on (deny)')
      expect(parsed.stderr).toBe('')
      await expect(Promise.resolve(hook({ tool: 'shell', input: { command: 'xargs git push' } }))).rejects.toThrow('unparsed')
      expect(warnings.mock.calls.filter(([message]) => String(message).includes('modeUnparsed=ask'))).toHaveLength(1)
    }
  }
  warnings.mockRestore()
  writeConfig('{}')
})

test('secret-box wrappers preserve allowed and denied commands on both hosts', async () => {
  writeConfig('{}')
  let hook: (e: { tool: string; input: unknown }) => Promise<void> | void = () => {}
  await setup({ location: { directory: repo }, tool: { hook: async (_name, cb) => void (hook = cb) } }, { config: configFile })
  for (const wrapper of ['secret-box exec --', 'secret-box exec --scrub --']) {
    for (const [script, denied] of [['git status', false], ['git commit -m x', true]] as const) {
      // Before rewriting the guard sees the script; after rewriting it sees the wrapper.
      for (const command of [script, `${wrapper} '${script}'`]) {
        const o = io(call(command))
        expect(await main(['hook'], o)).toBe(0)
        if (denied) {
          expect(JSON.parse(o.stdout).hookSpecificOutput.permissionDecisionReason).toContain('protected branch')
          await expect(Promise.resolve(hook({ tool: 'shell', input: { command } }))).rejects.toThrow('protected branch')
        } else {
          expect(o.stdout).toBe('')
          await hook({ tool: 'shell', input: { command } })
        }
      }
    }
  }
})

test('context: only a terminal changes a class, list reads, and the model cannot run the change through the guard', async () => {
  const refused = io('', false)
  expect(await main(['context', 'staging', 'relaxed'], refused)).toBe(1)
  expect(existsSync(storeFile)).toBe(false)
  expect(await main(['context', 'staging', 'relaxed'], io('', true))).toBe(0)
  const list = io('', false)
  expect(await main(['context', 'list'], list)).toBe(0)
  expect(list.stdout).toContain('staging: relaxed')
  expect(await main(['context', 'oops'], io('', true))).toBe(1)
  expect(loadClasses(storeFile)).toEqual({ staging: 'relaxed' })
  const env = nodeEnv(repo, () => loadClasses(storeFile))
  for (const command of ['guard-rules context prod relaxed', 'node /x/bin/guard-rules.mjs context prod relaxed', 'node guard-rules.mjs "context" prod relaxed', "guard-rules 'context' x relaxed"]) {
    expect((await checkCommand(command, loadConfig(configFile), env)).deny, command).toContain('only the user')
  }
  expect((await checkCommand('guard-rules context list', loadConfig(configFile), env)).deny).toBeUndefined()
})

test('context: a store that exists but cannot be read denies instead of reading as empty', async () => {
  writeFileSync(storeFile, '{broken')
  expect(() => loadClasses(storeFile)).toThrow()
  const env = nodeEnv(repo, () => loadClasses(storeFile))
  const kube = await checkCommand('kubectl delete pod x --context dev-box', loadConfig(configFile), env)
  expect(kube.deny).toContain('the guard failed')
  writeFileSync(storeFile, JSON.stringify({ 'dev-box': 'protected' }))
  expect((await checkCommand('kubectl delete pod x --context dev-box', loadConfig(configFile), env)).deny).toContain('dev-box')
  writeFileSync(storeFile, '{}')
  expect((await checkCommand('kubectl delete pod x --context dev-box', loadConfig(configFile), env)).deny).toBeUndefined()
})

test('self-protection: edit tools and shell commands aimed at the guard\'s own files are refused, other work passes', async () => {
  const patch = (path: string) => `*** Begin Patch\n*** Update File: ${path}\n@@\n-a\n+b\n*** End Patch`
  const dirs = [join(root, 'home', '.config', 'iuliandita-mods'), join(root, 'home', '.local', 'share', 'iuliandita-mods')]
  const home = join(root, 'home')
  for (const input of [
    { command: patch('~/.config/iuliandita-mods/guard-rules.json') },
    { command: patch(`${home}/.local/share/iuliandita-mods/guard-rules/contexts.json`) },
    { file_path: join(dirs[0]!, 'guard-rules.json'), content: '{}' },
    { filePath: 'iuliandita-mods/guard-rules.json', content: '{}' },
  ]) {
    expect(checkTool(input, join(root, 'home', '.config'), home, dirs).deny, JSON.stringify(input)).toContain('for the user to change')
  }
  expect(checkTool({ command: patch('src/app.ts') }, repo, home, dirs)).toEqual({})
  expect(checkTool({ filePath: 'iuliandita-mods/notes.md' }, repo, home, dirs)).toEqual({})
  const env = nodeEnv(repo, () => ({}))
  for (const command of ['echo {} > ~/.config/iuliandita-mods/guard-rules.json', 'sed -i s/on/off/ "$HOME/.config/iuliandita-mods/guard-rules.json"', "cat '/h/.local/share/iuliandita-mods/guard-rules/contexts.json'"]) {
    expect((await checkCommand(command, loadConfig(configFile), env)).deny, command).toContain('for the user to change')
  }
  expect((await checkCommand('ls ~/.codex/plugins/cache/iuliandita-mods/guard-rules/0.1.1', loadConfig(configFile), env)).deny).toBeUndefined()
  const viaHook = io(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch('~/.config/iuliandita-mods/guard-rules.json') }, cwd: repo }))
  expect(await main(['hook'], viaHook)).toBe(0)
  expect(JSON.parse(viaHook.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  const fine = io(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'x' }, cwd: repo }))
  expect(await main(['hook'], fine)).toBe(0)
  expect(fine.stdout).toBe('')
})

test('opencode: the shell tool is judged, a relative workdir is resolved from the project, other tools pass', async () => {
  writeConfig('{}')
  let hook: (e: { tool: string; input: unknown }) => Promise<void> | void = () => {}
  await setup({ location: { directory: repo }, tool: { hook: async (_name, cb) => void (hook = cb) } }, { config: configFile })
  await expect(Promise.resolve(hook({ tool: 'shell', input: { command: 'git commit -m x' } }))).rejects.toThrow('protected branch "main"')
  await expect(Promise.resolve(hook({ tool: 'shell', input: { command: 'git commit -m x', workdir: '../vault-old' } }))).rejects.toThrow('protected branch "main"')
  await expect(Promise.resolve(hook({ tool: 'shell', input: {} }))).rejects.toThrow('fail closed')
  await hook({ tool: 'read', input: { filePath: 'x' } })
  await expect(Promise.resolve(hook({ tool: 'edit', input: { filePath: '~/.config/iuliandita-mods/guard-rules.json', newString: '{}' } }))).rejects.toThrow('for the user to change')
  await hook({ tool: 'shell', input: { command: 'git status' } })
  writeConfig(JSON.stringify({ unprotectedRepos: other }))
  await hook({ tool: 'shell', input: { command: 'git commit -m x', workdir: '../vault-old' } })
  writeConfig('{}')
})

// The committed Codex bundle, under plain Node. It reads the user's real options file, so only the cases that no
// option changes are asserted, and the deny case is skipped when that file exists.
test('the built Codex bundle runs under node: bad input blocks with 2, a plain command passes', () => {
  const bundle = join(import.meta.dir, '..', 'codex', 'bin', 'guard-rules.mjs')
  const run = (stdin: string) => spawnSync('node', [bundle, 'hook'], { input: stdin, encoding: 'utf8' })
  expect(run('not json').status).toBe(2)
  expect(run(call('ls')).status).toBe(0)
  expect(run(call('ls')).stdout).toBe('')
  if (!existsSync(configPath())) {
    const denied = run(call('git commit -m x'))
    expect(denied.status).toBe(0)
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  }
})
