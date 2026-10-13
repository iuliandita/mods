// Generated from shared/reply.ts by scripts/mods generate. Do not edit by hand.
// The first {...} span of a model reply that parses as JSON, or null.
export function firstJson(text: string): object | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  for (let end = text.indexOf('}', start); end >= 0; end = text.indexOf('}', end + 1)) {
    try {
      const obj: unknown = JSON.parse(text.slice(start, end + 1))
      return typeof obj === 'object' ? obj : null
    } catch {
      continue
    }
  }
  return null
}

// The tags are the delimiters, so the text sent between them may not carry them.
export const defang = (s: string, tags: readonly string[]): string => s.replace(new RegExp(`<(/?)(${tags.join('|')})>`, 'gi'), '<$1 $2>')
