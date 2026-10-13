import type { PromptSubmitInput } from 'claude-code'

// Pieces prompt-gate and skill-pick share: the prompt skip rules, the log key and the Jev endpoint.

export type Path = 'haiku' | 'jev' | 'cascade' | 'jev-fallback'

export const LOG_KEY = 'log'
export const TEXT_MAX = 4000
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MS = 6000

export function skipReason(e: PromptSubmitInput, c: { mode: string; minChars: number }): string | null {
  if (c.mode === 'off') return 'off'
  if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return 'origin'
  if (e.attachments?.length) return 'attachments'
  const t = e.text.trimStart()
  if (t.startsWith('/') || t.startsWith('!')) return 'command'
  if (e.text.trim().length < c.minChars) return 'short'
  if (e.text.length > TEXT_MAX) return 'long'
  return null
}
