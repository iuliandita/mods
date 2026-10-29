import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dataDir, home as accountHome, loadOptions, optionsPath, ownDirs } from '../../../host-lib/options'
import { killAll, run, type RunResult } from '../../../host-lib/proc'
import type { Classes } from '../claude/hooks/context'
import { parseConfig, type Config, type Env } from '../claude/hooks/rules'

export { killAll, run, type RunResult }

export const configPath = (): string => optionsPath('guard-rules')

// The directories holding every mod's options and stored state.
export const guardDirs = ownDirs

export const storePath = (): string => join(dataDir(), 'guard-rules', 'contexts.json')

// The Claude plugin's option names and string values. A missing file is the defaults; a file that cannot be read as
// an object makes the config invalid, which denies git and forge writes until it is fixed.
export function loadConfig(path = configPath()): Config {
  const loaded = loadOptions('guard-rules', path)
  return loaded.error ? { ...parseConfig({}), error: loaded.error } : parseConfig(loaded.options)
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
    home: process.env.HOME || accountHome(),
    git: (dir, args, vars) => run(dir, ['git', '-C', dir, ...args], vars),
    run,
    contexts: async () => classes(),
    exists: async (path) => {
      try {
        statSync(path)
        return true
      } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return false
        throw e
      }
    },
    read: async (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
  }
}
