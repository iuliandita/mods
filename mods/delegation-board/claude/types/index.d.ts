export type DelegationBoardState = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed' | 'unknown'

export type DelegationBoardRow = {
  id: string
  parentId: string | null
  type: string
  model: string
  effort: string | null
  state: DelegationBoardState
  description: string
  background: boolean
  isTeammate: boolean
  startedAt: number
  endedAt: number | null
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  misses: number
}

declare module 'claude-code' {
  interface PluginState {
    'delegation-board': { agents: DelegationBoardRow[]; tick: number; opened: boolean }
  }
}
