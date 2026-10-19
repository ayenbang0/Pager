import type { NetInfo } from './engine.js'
import type { Settings } from './settings.js'

export const SETTINGS_ID = 'settings'

export interface PrivacyView {
  /** Identity and history are protected by a passphrase. */
  encrypted: boolean
  /** Set in LAN-only mode. */
  lan?: { hosting: boolean; address: string }
  net: NetInfo
}

export interface AiSettingsView {
  default: string
  /** Every backend id: ready agents, then ollama, then openai. */
  backends: string[]
  ollama: { url: string; model: string }
  openai: { url: string; model: string; keyHint: string }
  /** `ai.openai.key` / `ai.openai.url` -> the environment variable that fixes it. */
  locks: Record<string, string>
}

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
  /** Absent in a run without agents. */
  ai?: AiSettingsView
  privacy: PrivacyView
}
