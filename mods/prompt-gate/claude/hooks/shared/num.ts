// Generated from shared/num.ts by scripts/mods generate. Do not edit by hand.
// A numeric option arrives as a number or a numeric string; anything else is NaN.
export const numOption = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
