import fs from 'node:fs'
import path from 'node:path'
import { parseColor } from './colors.js'
import { isRecord } from './guards.js'
import { DEFAULT_THEME, findTheme } from './themes.js'

/** Spacing between messages: compact is one row per message, cozy gives each speaker a header row, roomy adds a blank row between speakers. */
export const DENSITIES = ['compact', 'cozy', 'roomy'] as const
export type Density = (typeof DENSITIES)[number]

export function isDensity(x: unknown): x is Density {
  return typeof x === 'string' && (DENSITIES as readonly string[]).includes(x)
}

export interface Settings {
  /** Name of a theme in THEMES. */
  theme: string
  sidebar: boolean
  /** `/accent`: a stored color (`#rrggbb` or an Ink name) that replaces the theme accent, or '' for the theme's own. */
  accent: string
  /** `/badge`: `auto` picks a glyph from your name, `none` shows nothing, anything else is the glyph shown beside your name. */
  badge: string
  density: Density
  /** `/notify`: desktop notifications (outside the terminal) for messages, agents, invites and presence. */
  notify: boolean
  /** `/sound`: the chime that goes with a notification. */
  sound: boolean
}

export const DEFAULT_SETTINGS: Settings = { theme: DEFAULT_THEME.name, sidebar: true, accent: '', badge: 'auto', density: 'cozy', notify: true, sound: true }

/** A badge is `auto`, `none`, or one symbol or emoji (one grapheme, not a letter or digit). Returns the stored form or undefined. */
export function parseBadge(input: string): string | undefined {
  const raw = input.trim()
  if (raw === 'auto' || raw === 'none') return raw
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(raw)]
  if (parts.length !== 1 || /^[\p{L}\p{N}\s]$/u.test(raw) || /\p{Cc}/u.test(raw)) return undefined
  return raw
}

/** Tolerant: a missing, unreadable or malformed file yields defaults, field by field. */
export function loadSettings(dir: string): Settings {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  if (!isRecord(parsed)) return { ...DEFAULT_SETTINGS }
  const theme = typeof parsed.theme === 'string' ? findTheme(parsed.theme) : undefined
  return {
    theme: theme?.name ?? DEFAULT_SETTINGS.theme,
    sidebar: typeof parsed.sidebar === 'boolean' ? parsed.sidebar : DEFAULT_SETTINGS.sidebar,
    accent: (typeof parsed.accent === 'string' ? parseColor(parsed.accent) : undefined) ?? DEFAULT_SETTINGS.accent,
    badge: (typeof parsed.badge === 'string' ? parseBadge(parsed.badge) : undefined) ?? DEFAULT_SETTINGS.badge,
    density: isDensity(parsed.density) ? parsed.density : DEFAULT_SETTINGS.density,
    notify: typeof parsed.notify === 'boolean' ? parsed.notify : DEFAULT_SETTINGS.notify,
    sound: typeof parsed.sound === 'boolean' ? parsed.sound : DEFAULT_SETTINGS.sound,
  }
}

/** Atomic: written beside the target, then renamed over it. */
export function saveSettings(dir: string, settings: Settings): void {
  const file = path.join(dir, 'settings.json')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(tmp, file)
}
