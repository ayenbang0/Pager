import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_THEME, findTheme } from './themes.js'

export interface Settings {
  /** Name of a theme in THEMES. */
  theme: string
  sidebar: boolean
}

export const DEFAULT_SETTINGS: Settings = { theme: DEFAULT_THEME.name, sidebar: true }

/** Tolerant: a missing, unreadable or malformed file yields defaults, field by field. */
export function loadSettings(dir: string): Settings {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS }
  const o = parsed as Record<string, unknown>
  const theme = typeof o.theme === 'string' ? findTheme(o.theme) : undefined
  return {
    theme: theme?.name ?? DEFAULT_SETTINGS.theme,
    sidebar: typeof o.sidebar === 'boolean' ? o.sidebar : DEFAULT_SETTINGS.sidebar,
  }
}

/** Atomic: written beside the target, then renamed over it. */
export function saveSettings(dir: string, settings: Settings): void {
  const file = path.join(dir, 'settings.json')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(tmp, file)
}
