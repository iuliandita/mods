import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'

// Fixed under the account's home from the password database, not from HOME or XDG_*: a repository can set those
// through a .env file or a direnv rule, and it must not be able to point a guard at its own options.
export const home = (): string => userInfo().homedir
export const configDir = (): string => join(home(), '.config', 'iuliandita-mods')
export const dataDir = (): string => join(home(), '.local', 'share', 'iuliandita-mods')

// The directories every mod's options and stored state live in.
export const ownDirs = (): string[] => [configDir(), dataDir()]

export const optionsPath = (mod: string): string => join(configDir(), `${mod}.json`)

export type Loaded = { options: Record<string, unknown>; error?: string }

// A mod's options: the same names and string values as its Claude userConfig. A missing file is the defaults; a
// file that cannot be read as a JSON object is an error the caller must treat as a failure of the mod.
export function loadOptions(mod: string, path = optionsPath(mod)): Loaded {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { options: {} }
    return { options: {}, error: `${path} could not be read` }
  }
  try {
    const raw: unknown = JSON.parse(text)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
    return { options: raw as Record<string, unknown> }
  } catch {
    return { options: {}, error: `${path} is not a JSON object` }
  }
}
