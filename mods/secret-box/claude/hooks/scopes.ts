type Scopes = Map<string, string[]>

const INVALID = 'secret-box: error: secretScopes is invalid: expected a JSON object mapping secret names to arrays of absolute path globs; fix secretScopes in the plugin options'

function parseScopes(raw: unknown): Scopes | null {
  if (raw === undefined || raw === '') return new Map()
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const scopes: Scopes = new Map()
    for (const [name, paths] of Object.entries(value)) {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || !Array.isArray(paths)) return null
      const valid: string[] = []
      for (const path of paths) {
        if (typeof path !== 'string' || !path.startsWith('/') || /[\[\]{}\u0000]/.test(path) || path.split('/').some((p) => p === '.' || p === '..')) return null
        valid.push(path)
      }
      scopes.set(name, valid)
    }
    return scopes
  } catch {
    return null
  }
}

// Match the whole normalized directory: * and ? stay within a segment; ** spans directories.
function matches(pattern: string, cwd: string): boolean {
  let re = '^'
  const parts = pattern.split('/').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part === '**') re += '(?:/[^/]+)*'
    else re += '/' + part.replace(/[.+^$()|\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')
  }
  return new RegExp(re + '$').test(cwd === '/' ? '' : cwd)
}

export function scopeDenied(raw: unknown, names: readonly string[], cwd: string): string | null {
  if (names.length === 0) return null
  const scopes = parseScopes(raw)
  if (scopes === null) return INVALID
  const parts: string[] = []
  for (const part of cwd.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  const dir = '/' + parts.join('/')
  for (const name of names) {
    const paths = scopes.get(name)
    if (paths && (!cwd.startsWith('/') || !paths.some((path) => matches(path, dir)))) {
      return `secret-box: error: ${name} is not allowed in this directory; add the path to secretScopes`
    }
  }
  return null
}
