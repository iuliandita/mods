export const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
// Variables that change the identity `git var` reports; only these reach the guard's identity probe.
export const IDENTITY_ENV =
  /^(?:GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)|EMAIL|HOME|XDG_CONFIG_HOME|GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM|COUNT|KEY_\d+|VALUE_\d+))$/

// The other variables the guard reads for a call: kube and terraform targets, the git repository and config.
export const READ_ENV = /^(?:KUBECONFIG|TF_WORKSPACE|TF_DATA_DIR|HELM_KUBE(?:CONTEXT|APISERVER|TOKEN|CAFILE)|GIT_(?:DIR|WORK_TREE|NAMESPACE|CONFIG_PARAMETERS))$/

export function liftAssigns(words: string[]): { assigns: Record<string, string>; rest: string[] } {
  const assigns: Record<string, string> = {}
  let k = 0
  while (k < words.length && ASSIGN.test(words[k]!)) {
    const eq = words[k]!.indexOf('=')
    assigns[words[k]!.slice(0, eq)] = words[k]!.slice(eq + 1)
    k++
  }
  return { assigns, rest: words.slice(k) }
}

export const TOOLS = ['git', 'gh', 'glab', 'tea', 'fj', 'kubectl', 'helm', 'terraform', 'tofu']
export const SHELL_NAMES = ['bash', 'sh', 'zsh', 'dash', 'ksh']

// Only a literal path or filename, never inline code or a command string containing spaces.
export function isDataWord(word: string): boolean {
  return /^[\w@%+,=:~./-]+$/.test(word) && (word.includes('/') || /\.[A-Za-z0-9][\w-]*$/.test(word))
}
const TOOL_WORD = new RegExp(`(?<![\\w.-])(${TOOLS.join('|')})(?![\\w-])`, 'gi')
const RUN_WORD = new RegExp(`(?<![\\w.-])(${[...TOOLS, ...SHELL_NAMES].join('|')})(?![\\w-])`, 'g')

// The tool names that appear as words of their own in `text`, matched on word boundaries rather than whitespace.
// `anyCase` is for the whole command text, where `$GIT` names git too; `shells` adds the shell names.
export function toolWords(text: string, opts: { anyCase?: boolean; shells?: boolean } = {}): string[] {
  const re = opts.shells ? RUN_WORD : TOOL_WORD
  const flags = opts.anyCase ? 'gi' : 'g'
  // A path segment with a dotted name (`/gh.example/`, `/terraform.tfstate`) is a name, not the tool; elsewhere
  // `git.cmd` (`import git.cmd`) still names it.
  const found = [...text.matchAll(new RegExp(re.source, flags))].filter(
    (m) => !(text[m.index! - 1] === '/' && /^\.\w/.test(text.slice(m.index! + m[0].length))),
  )
  return [...new Set(found.map((m) => m[1]!.toLowerCase()))]
}

const esc = (s: string) => s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')

// The names in `names` a glob or brace command word (`gi[t]`, `/usr/bin/gi?`, `{git,true}`) could expand to;
// empty for a word with a variable or substitution, whose value cannot be told.
export function mayName(word: string, names: readonly string[]): string[] {
  if (/[$`]/.test(word)) return []
  const last = word.slice(word.lastIndexOf('/') + 1)
  let re = ''
  for (let i = 0; i < last.length; i++) {
    const c = last[i]!
    const close = c === '[' ? last.indexOf(']', i + 2) : c === '{' ? last.indexOf('}', i) : -1
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[' && close !== -1) re += `[${last.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
    else if (c === '{' && close !== -1) {
      const body = last.slice(i + 1, close)
      re += body.includes('..') ? '.*' : `(?:${body.split(',').map(esc).join('|')})`
    } else re += esc(c)
    if (close !== -1 && (c === '[' || c === '{')) i = close
  }
  try {
    const pattern = new RegExp(`^${re}$`)
    return names.filter((n) => pattern.test(n))
  } catch {
    return [...names]
  }
}
