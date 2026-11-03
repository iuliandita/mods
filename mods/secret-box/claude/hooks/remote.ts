import type { Scrubber } from './scrub'

export type ScrubReply = { results: { text: string; names: string[] }[]; names: string[]; short: string[] }
export type Request = (texts: string[]) => Promise<ScrubReply>

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

export function parseReply(stdout: string, count: number): ScrubReply {
  const v: unknown = JSON.parse(stdout)
  if (v === null || typeof v !== 'object' || !('results' in v) || !Array.isArray(v.results)
    || !('names' in v) || !strings(v.names) || !('short' in v) || !strings(v.short)) throw new Error('invalid scrub reply')
  const results = v.results.map((r: unknown) => {
    if (r === null || typeof r !== 'object' || !('text' in r) || typeof r.text !== 'string'
      || !('names' in r) || !strings(r.names)) throw new Error('invalid scrub result')
    return { text: r.text, names: r.names }
  })
  if (results.length !== count) throw new Error('incomplete scrub reply')
  return { results, names: v.names, short: v.short }
}

// Traverse once to collect distinct strings, scrub them in one helper call, then apply the results.
// The existing walkers retain their depth, path and key-collision handling.
export async function scrubBatch<T>(walk: (scrub: Scrubber) => T, request: Request): Promise<T> {
  const texts = new Set<string>()
  walk((text) => {
    texts.add(text)
    return { text, names: [] }
  })
  const input = [...texts]
  if (input.length === 0) return walk((text) => ({ text, names: [] }))
  const reply = await request(input)
  const clean = new Map(input.map((text, i) => [text, reply.results[i]!]))
  return walk((text) => {
    const result = clean.get(text)
    if (!result) throw new Error('uncollected scrub input')
    return result
  })
}
