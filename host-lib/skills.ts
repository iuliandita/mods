import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { home } from './options'

export type SkillInfo = { name: string; description: string }

const DESC_MAX = 400

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
  for (const entry of entries.sort()) {
    const file = join(dir, entry, 'SKILL.md')
    try {
      if (!statSync(file).isFile()) continue
      const info = parseSkill(readFileSync(file, 'utf8'))
      if (info) out.push(info)
    } catch {
      // not a skill folder
    }
  }
  return out
}

// Where Codex looks: .agents/skills in the working directory and every parent up to the account's home or the
// filesystem root, the user's ~/.agents/skills and $CODEX_HOME/skills, the system folder, and the skills of
// installed plugins.
export function codexSkillDirs(cwd: string, env: { codexHome?: string } = {}): string[] {
  const dirs: string[] = []
  const stop = home()
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.push(join(dir, '.agents', 'skills'))
    if (dir === stop || dirname(dir) === dir) break
  }
  dirs.push(join(home(), '.agents', 'skills'))
  const codexHome = env.codexHome ?? process.env.CODEX_HOME ?? join(home(), '.codex')
  dirs.push(join(codexHome, 'skills'), join(codexHome, 'skills', '.system'), '/etc/codex/skills')
  const cache = join(codexHome, 'plugins', 'cache')
  if (existsSync(cache)) {
    try {
      for (const market of readdirSync(cache)) for (const plugin of readdirSync(join(cache, market))) for (const version of readdirSync(join(cache, market, plugin))) dirs.push(join(cache, market, plugin, version, 'skills'))
    } catch {
      // a half-installed cache
    }
  }
  return dirs
}

// First one wins when two folders hold the same name.
export function scanSkills(dirs: readonly string[]): SkillInfo[] {
  const seen = new Set<string>()
  return dirs.flatMap(skillsIn).filter((s) => !seen.has(s.name) && !!seen.add(s.name))
}

// The listing text the shared code reads: one "- name: description" line per skill.
export const listing = (skills: readonly SkillInfo[]): string => skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
