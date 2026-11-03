export function basename(p: string): string {
  const cut = p.lastIndexOf('/')
  return cut === -1 ? p : p.slice(cut + 1)
}

// Joins without collapsing `..`: the OS resolves it after any symlink before it, so `git -C link/..`, `env -C`,
// `sudo -D`, `terraform -chdir` and `cd -P` reach the link target's parent, which no lexical form describes.
export function joinPath(base: string, p: string, home: string): string {
  let q = p
  if (q === '~') q = home
  else if (q.startsWith('~/')) q = home + q.slice(1)
  const full = q.startsWith('/') ? q : base.replace(/\/+$/, '') + '/' + q
  return '/' + full.split('/').filter((seg) => seg && seg !== '.').join('/')
}

// Collapses `..` lexically, as a logical `cd` (the shell default) does.
export function resolvePath(base: string, p: string, home: string): string {
  let q = p
  if (q === '~') q = home
  else if (q.startsWith('~/')) q = home + q.slice(1)
  const full = q.startsWith('/') ? q : base.replace(/\/+$/, '') + '/' + q
  const out: string[] = []
  for (const seg of full.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

export function hasVariable(p: string): boolean {
  return p.includes('$') || p.includes('`') || /\{\{secret:[^}]*\}\}/.test(p)
}
