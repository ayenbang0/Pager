import fs from 'node:fs'
import path from 'node:path'
import { parseColor } from '../ui/theme/colors.js'
import { isRecord } from '../util/guards.js'
import { DEFAULT_THEME, findTheme } from '../ui/theme/themes.js'

/** Spacing between messages: compact is one row per message, cozy gives each speaker a header row, roomy adds a blank row between speakers. */
export const DENSITIES = ['compact', 'cozy', 'roomy'] as const
export type Density = (typeof DENSITIES)[number]

export function isDensity(x: unknown): x is Density {
  return typeof x === 'string' && (DENSITIES as readonly string[]).includes(x)
}

export interface Folder {
  name: string
  /** Tab ids filed in this folder, in display order. */
  ids: string[]
}

export const MAX_FOLDERS = 12
export const MAX_FOLDER_NAME = 24

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
  /** The last pager version the user saw a changelog for; empty means "show on next launch". */
  lastSeenVersion: string
  /** Restart-to-apply switches. Each maps to a PAGER_* variable (see envSettings.ts). */
  reduceMotion: boolean
  mouse: boolean
  alerts: boolean
  updateCheck: boolean
  acp: boolean
  web: boolean
  agents: boolean
  lan: boolean
  /** Sidebar folders in display order. */
  folders: Folder[]
  /** Collapsed sidebar sections: `pending direct groups agents tools folder:<name>`. */
  collapsed: string[]
}

export const DEFAULT_SETTINGS: Settings = { theme: DEFAULT_THEME.name, sidebar: true, accent: '', badge: 'auto', density: 'cozy', notify: true, sound: true, lastSeenVersion: '', reduceMotion: false, mouse: true, alerts: true, updateCheck: true, acp: true, web: true, agents: true, lan: false, folders: [], collapsed: [] }

/** A badge is `auto`, `none`, or one symbol or emoji (one grapheme, not a letter or digit). Returns the stored form or undefined. */
export function parseBadge(input: string): string | undefined {
  const raw = input.trim()
  if (raw === 'auto' || raw === 'none') return raw
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(raw)]
  if (parts.length !== 1 || /^[\p{L}\p{N}\s]$/u.test(raw) || /\p{Cc}/u.test(raw)) return undefined
  return raw
}

/** A valid folder name: 1-24 characters, trimmed, no control characters. */
export function validFolderName(raw: string): boolean {
  const name = raw.trim()
  return name.length >= 1 && name.length <= MAX_FOLDER_NAME && name === raw && !/\p{Cc}/u.test(name)
}

function loadFolders(raw: unknown): Folder[] {
  if (!Array.isArray(raw)) return []
  const out: Folder[] = []
  const names = new Set<string>()
  const filed = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_FOLDERS) break
    if (!isRecord(item) || typeof item.name !== 'string' || !Array.isArray(item.ids)) continue
    const name = item.name.trim()
    if (!validFolderName(name) || names.has(name.toLowerCase())) continue
    names.add(name.toLowerCase())
    const ids: string[] = []
    for (const id of item.ids) {
      if (ids.length >= 200) break
      if (typeof id !== 'string' || id.length === 0 || id.length > 100 || filed.has(id)) continue
      filed.add(id)
      ids.push(id)
    }
    out.push({ name, ids })
  }
  return out
}

function loadCollapsed(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 40))].slice(0, 40)
}

const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

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
    lastSeenVersion: typeof parsed.lastSeenVersion === 'string' ? parsed.lastSeenVersion : DEFAULT_SETTINGS.lastSeenVersion,
    reduceMotion: flag(parsed.reduceMotion, DEFAULT_SETTINGS.reduceMotion),
    mouse: flag(parsed.mouse, DEFAULT_SETTINGS.mouse),
    alerts: flag(parsed.alerts, DEFAULT_SETTINGS.alerts),
    updateCheck: flag(parsed.updateCheck, DEFAULT_SETTINGS.updateCheck),
    acp: flag(parsed.acp, DEFAULT_SETTINGS.acp),
    web: flag(parsed.web, DEFAULT_SETTINGS.web),
    agents: flag(parsed.agents, DEFAULT_SETTINGS.agents),
    lan: flag(parsed.lan, DEFAULT_SETTINGS.lan),
    folders: loadFolders(parsed.folders),
    collapsed: loadCollapsed(parsed.collapsed),
  }
}

/** Atomic: written beside the target, then renamed over it. */
export function saveSettings(dir: string, settings: Settings): void {
  const file = path.join(dir, 'settings.json')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

/** When pager was last open (ms since epoch), kept in its own small file so the periodic stamp never rewrites settings.json. Undefined on a first run or an unreadable file. */
export function loadLastSeen(dir: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'last-seen.json'), 'utf8'))
    return isRecord(parsed) && typeof parsed.at === 'number' && Number.isFinite(parsed.at) && parsed.at > 0 ? parsed.at : undefined
  } catch {
    return undefined
  }
}

/** Best effort and atomic; a read-only data dir only costs the next recap. */
export function saveLastSeen(dir: string, at: number): void {
  const file = path.join(dir, 'last-seen.json')
  const tmp = `${file}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ at }) + '\n')
    fs.renameSync(tmp, file)
  } catch {
    // not worth a warning every minute
  }
}
