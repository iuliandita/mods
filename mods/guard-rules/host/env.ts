import { execFile, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'

import type { Classes } from '../claude/hooks/context'
import { parseConfig, type Config, type Env, type GitResult } from '../claude/hooks/rules'

const TIMEOUT_MS = 5_000
const MAX_BUFFER = 1 << 20

const running = new Set<ChildProcess>()

// Stops the lookups still running when the hook gives up on its deadline.
export function killAll(): void {
  for (const child of running) child.kill('SIGKILL')
}

// `failed` is only for a git that could not run at all (spawn error, timeout); a non-zero exit is an answer.
export function run(dir: string, argv: string[], vars?: Record<string, string>): Promise<GitResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv
    if (cmd === undefined) return resolve({ ok: false, out: '', failed: true })
    const child = execFile(cmd, args, { cwd: dir, env: vars ? { ...process.env, ...vars } : process.env, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout) => {
      running.delete(child)
      if (!err) return resolve({ ok: true, out: stdout.trim() })
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      resolve(typeof e.code === 'number' && !e.killed ? { ok: false, out: stdout.trim() } : { ok: false, out: '', failed: true })
    })
    running.add(child)
  })
}

// Fixed under the account's home from the password database, not from HOME or XDG_*: a repository can set
// those through a .env file or a direnv rule, and it must not be able to point the guard at its own options.
const home = () => userInfo().homedir

export function configPath(): string {
  return join(home(), '.config', 'iuliandita-mods', 'guard-rules.json')
}

// The directories holding the options file and the class store.
export function guardDirs(): string[] {
  return [join(home(), '.config', 'iuliandita-mods'), join(home(), '.local', 'share', 'iuliandita-mods')]
}

export function storePath(): string {
  return join(home(), '.local', 'share', 'iuliandita-mods', 'guard-rules', 'contexts.json')
}

// Same option names and string values as the Claude plugin's userConfig. A missing file is the defaults; a file
// that cannot be read as an object makes the config invalid, which denies git and forge writes until it is fixed.
export function loadConfig(path = configPath()): Config {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig({})
    return { ...parseConfig({}), error: `${path} could not be read` }
  }
  try {
    const raw: unknown = JSON.parse(text)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
    return parseConfig(raw as Record<string, unknown>)
  } catch {
    return { ...parseConfig({}), error: `${path} is not a JSON object` }
  }
}

// An absent store is empty. One that exists but cannot be read throws, so the caller denies: reading it as empty
// would silently drop a `protected` class and let a name that matches a relaxed pattern through.
export function loadClasses(path = storePath()): Classes {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
  const raw: unknown = JSON.parse(text)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} is not a JSON object`)
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, 'protected' | 'relaxed'] => entry[1] === 'protected' || entry[1] === 'relaxed'))
}

// Last writer wins; two classifications typed at the same moment can lose one.
export function saveClasses(classes: Classes, path = storePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(classes, null, 2) + '\n')
    renameSync(tmp, path)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing was written
    }
    throw e
  }
}

export function nodeEnv(cwd: string, classes: () => Classes = loadClasses): Env {
  return {
    cwd,
    home: process.env.HOME || userInfo().homedir,
    git: (dir, args, vars) => run(dir, ['git', '-C', dir, ...args], vars),
    run,
    contexts: async () => classes(),
    read: async (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
  }
}
