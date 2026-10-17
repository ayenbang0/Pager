export type AgentState = 'idle' | 'working' | 'asking' | 'reviewing'

/** What the UI shows of one agent teammate. */
export interface AgentView {
  name: string
  cli: string
  state: AgentState
  task: string
  model?: string
  effort?: string
  /** Messages in this agent's own tab that the user has not seen. */
  unread: number
  /** Share of the context window in use, 0..1, when the agent reports it. */
  contextPct?: number
  /** The agent's personal color from `/agent color`; absent when the theme picks one. */
  color?: string
}
