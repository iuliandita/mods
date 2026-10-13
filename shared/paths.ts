// Lexical only (no fs, no symlinks): '.' and '..' segments are resolved, repeated slashes collapse. Relative paths give null.
function normalize(p: string): string | null {
  if (!p.startsWith('/')) return null
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

// True when cwd is equal to or under one of the comma-separated prefixes, on path boundaries, after both are normalized.
// Blank list: anywhere. A non-blank list with no usable entry (only commas, relative entries, `~` without a home): nowhere.
export function pathAllowed(cwd: string, paths: string, home: string | undefined): boolean {
  if (!paths.trim()) return true
  const dir = normalize(cwd)
  if (dir === null) return false
  return paths.split(',').some((raw) => {
    let p = raw.trim()
    if (p === '~' || p.startsWith('~/')) {
      if (!home) return false
      p = home + p.slice(1)
    }
    const prefix = normalize(p)
    if (prefix === null) return false
    return dir === prefix || dir.startsWith(prefix === '/' ? '/' : `${prefix}/`)
  })
}
