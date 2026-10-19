import type { Settings } from './settings.js'

export const SETTINGS_ID = 'settings'

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
}
