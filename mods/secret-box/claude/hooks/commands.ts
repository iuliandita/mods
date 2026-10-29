export const VALUES_DENIED = 'secret-box: error: values is reserved for the hook: it exposes every stored secret; use secret-box names in a terminal'

// Only literal command words are modeled. This prevents accidental disclosure, not arbitrary code execution.
export function runsValues(script: string, depth = 0): boolean {
  if (depth > 12) return true
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let started = false
  let quote = ''
  const endWord = () => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!
    if (c === '\\' && quote !== "'") {
      const next = script[++i] ?? ''
      if (next !== '\n') {
        word += next
        started = true
      }
    } else if (quote) {
      if (c === quote) quote = ''
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (c === '#' && !started) {
      const end = script.indexOf('\n', i)
      i = end < 0 ? script.length : end - 1
    } else if (/[;&|()\n]/.test(c)) endCommand()
    else if (/\s/.test(c)) endWord()
    else {
      word += c
      started = true
    }
  }
  endCommand()
  return commands.some((argv) => {
    while (argv[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]) || ['command', 'builtin', 'exec', 'env', '--'].includes(argv[0]))) argv.shift()
    const head = argv[0]?.split('/').pop()
    if (head === 'secret-box') {
      if (argv[1] === 'values') return true
      if (argv[1] === 'exec') {
        const offset = argv[2] === '--scrub' ? 3 : 2
        return argv[offset] === '--' && argv[offset + 1] !== undefined && runsValues(argv[offset + 1]!, depth + 1)
      }
    }
    if (head && ['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(head)) {
      const at = argv.findIndex((arg, i) => i > 0 && /^-[^-]*c/.test(arg))
      return at > 0 && argv[at + 1] !== undefined && runsValues(argv[at + 1]!, depth + 1)
    }
    return false
  })
}
