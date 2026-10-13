// `chain` changes at every connector other than `&&` (and `then`); `certain` means the call runs exactly when
// the earlier calls of its chain succeeded, so a state change it makes holds for the rest of that chain.
// `loop` means the call is inside a loop body, where a relative change compounds.
export type Flow = { chain: number; certain: boolean; loop?: boolean }

// REAL: whatever the lookup reports; UNKNOWN: a value the guard cannot tell.
export const REAL: unique symbol = Symbol('real')
export const UNKNOWN: unique symbol = Symbol('unknown')
export type Possible<V> = V | typeof REAL | typeof UNKNOWN
export const MAX_POSSIBLE = 8

export type Tracker<V> = {
  get(k: string): Possible<V>[]
  set(k: string, next: Possible<V>[], flow: Flow): void
  step(chain: number): void
  size(): number
}

// The set of values each key could hold. A certain change replaces the set and holds the old one until a call
// outside its chain makes it possible again; any other change only adds possibilities.
export function createTracker<V>(keyOf: (v: V) => string, initial: (k: string) => Possible<V>[] = () => [REAL]): Tracker<V> {
  const now = new Map<string, Possible<V>[]>()
  const held = new Map<string, { chain: number; before: Possible<V>[] }>()
  const id = (v: Possible<V>) => (v === REAL ? '\0real' : v === UNKNOWN ? '\0unknown' : keyOf(v))
  const union = (a: Possible<V>[], b: Possible<V>[]): Possible<V>[] => {
    const seen = new Set<string>()
    const out = [...a, ...b].filter((v) => !seen.has(id(v)) && seen.add(id(v)))
    return out.length > MAX_POSSIBLE ? [UNKNOWN] : out
  }
  const get = (k: string) => now.get(k) ?? initial(k)
  return {
    get,
    size: () => now.size,
    set(k, next, flow) {
      if (flow.certain) {
        held.set(k, { chain: flow.chain, before: union(held.get(k)?.before ?? [], get(k)) })
        now.set(k, union([], next))
      } else {
        now.set(k, union(get(k), next))
      }
    },
    step(chain) {
      for (const [k, h] of held) {
        if (h.chain === chain) continue
        now.set(k, union(h.before, get(k)))
        held.delete(k)
      }
    },
  }
}
