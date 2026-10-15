import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { home } from './options'

export type SkillInfo = { name: string; description: string }

const DESC_MAX = 400
const FILE_MAX = 8 * 1024
const DIR_MAX = 300
const REPO_MAX = 100

// Only the front matter matters, so a skill file is never read in full.
function readHead(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(FILE_MAX)
    return buf.subarray(0, readSync(fd, buf, 0, FILE_MAX, 0)).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

// name and description from the YAML front matter of a SKILL.md. Only what a skill file uses: plain, quoted and
// folded or literal block values.
export function parseSkill(text: string): SkillInfo | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return null
  const lines = (m[1] as string).split(/\r?\n/)
  const read = (key: string): string => {
    const i = lines.findIndex((l) => l.startsWith(`${key}:`))
    if (i < 0) return ''
    const first = (lines[i] as string).slice(key.length + 1).trim()
    if (/^[>|][+-]?$/.test(first)) {
      const body: string[] = []
      for (const l of lines.slice(i + 1)) {
        if (l.trim() !== '' && !/^\s/.test(l)) break
        body.push(l.trim())
      }
      return body.join(' ').trim()
    }
    return first.replace(/^(["'])([\s\S]*)\1$/, '$2')
  }
  const name = read('name')
  return name ? { name, description: read('description').replace(/\s+/g, ' ').slice(0, DESC_MAX) } : null
}

function skillsIn(dir: string): SkillInfo[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: SkillInfo[] = []
  for (const entry of entries.sort().slice(0, DIR_MAX)) {
    const file = join(dir, entry, 'SKILL.md')
    try {
      if (!statSync(file).isFile()) continue
      const info = parseSkill(readHead(file))
      if (info) out.push(info)
    } catch {
      // not a skill folder
    }
  }
  return out
}

// Where Codex looks: the user's and the system's folders, then .agents/skills of the working directory and its parents up
// to the repository root (or the home directory; a directory outside both gets only its own). User and system folders
// come first, so a repository cannot shadow one of their skills by reusing its name.
export function codexSkillDirs(cwd: string, env: { codexHome?: string } = {}): { user: string[]; repo: string[] } {
  const codexHome = env.codexHome ?? process.env.CODEX_HOME ?? join(home(), '.codex')
  const user = [join(home(), '.agents', 'skills'), join(codexHome, 'skills'), join(codexHome, 'skills', '.system'), '/etc/codex/skills']
  const cache = join(codexHome, 'plugins', 'cache')
  if (existsSync(cache)) {
    try {
      for (const market of readdirSync(cache)) for (const plugin of readdirSync(join(cache, market))) for (const version of readdirSync(join(cache, market, plugin))) user.push(join(cache, market, plugin, version, 'skills'))
    } catch {
      // a half-installed cache
    }
  }
  const repo: string[] = []
  const start = resolve(cwd)
  let bounded = false
  for (let dir = start; ; dir = dirname(dir)) {
    repo.push(join(dir, '.agents', 'skills'))
    if (existsSync(join(dir, '.git')) || dir === home()) {
      bounded = true
      break
    }
    if (dirname(dir) === dir) break
  }
  return { user, repo: bounded ? repo : repo.slice(0, 1) }
}

// First one wins when two folders hold the same name; the repository's skills are capped.
export function scanSkills(dirs: readonly string[] | { user: readonly string[]; repo: readonly string[] }): SkillInfo[] {
  const { user, repo } = Array.isArray(dirs) ? { user: dirs as readonly string[], repo: [] as readonly string[] } : (dirs as { user: readonly string[]; repo: readonly string[] })
  const seen = new Set<string>()
  const fresh = (s: SkillInfo): boolean => !seen.has(s.name) && !!seen.add(s.name)
  return [...user.flatMap(skillsIn).filter(fresh), ...repo.flatMap(skillsIn).filter(fresh).slice(0, REPO_MAX)]
}

// The listing text the shared code reads: one "- name: description" line per skill.
export const listing = (skills: readonly SkillInfo[]): string => skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
