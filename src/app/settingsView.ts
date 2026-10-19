import type { Settings } from './settings.js'

export const SETTINGS_ID = 'settings'

export interface AgentSettingsView {
  agents: { name: string; cli: string; model: string; effort: string; color: string; ready: boolean }[]
  review: boolean
  risk: boolean
  goal: string
  verify: string
  /** Daily caps: key `*` is every agent, otherwise an agent name. */
  budgets: { key: string; text: string }[]
  guests: { pk: string; name: string; mode: string }[]
  sessions: { pk: string; name: string }[]
}

/** Everything the Settings tab shows, as plain data (the tab never reaches into the engine's internals). */
export interface SettingsView {
  settings: Readonly<Settings>
  name: string
  code: string
  version: string
  /** A newer published version, if one is known. */
  update: string | null
  /** Setting key -> what fixes it (an environment variable or a flag). */
  locks: Record<string, string>
  themes: readonly string[]
  /** False in a run without agents (--no-agents): the Agents section and the AI rows are hidden. */
  /** Sidebar folders with how many tabs are filed in each. */
  folders: { name: string; count: number }[]
  agentsOn: boolean
  agents: AgentSettingsView
}
