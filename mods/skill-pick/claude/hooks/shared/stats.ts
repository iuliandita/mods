// Generated from shared/stats.ts by scripts/mods generate. Do not edit by hand.
// Nearest-rank percentile; 0 for an empty list.
export const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0
  const a = [...xs].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] ?? 0
}
