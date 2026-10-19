import type { SettingsView } from '../../app/settingsView.js'
import { COLOR_WORDS, parseColor } from '../theme/colors.js'
import { DENSITIES } from '../../app/settings.js'
import { SETTINGS_SECTIONS, type SettingsRow, type SettingsSection } from './settingsRows.js'

export const BADGE_CHOICES = ['auto', 'none', '🚀', '🔥', '✨', '👑', '⚡', '💀'] as const

const lockOf = (view: SettingsView, key: string): string | undefined => view.locks[key]

function toggle(view: SettingsView, id: keyof SettingsView['settings'] & string, label: string, note?: string): SettingsRow {
  const locked = lockOf(view, id)
  return {
    kind: 'toggle',
    id,
    label,
    value: view.settings[id] as boolean,
    ...(note === undefined ? {} : { note }),
    ...(locked === undefined ? {} : { locked }),
  }
}

/** The word for a stored accent color ('' = auto), or the color itself when it has no word. */
export function accentChoice(accent: string): string {
  if (accent === '') return 'auto'
  return COLOR_WORDS.find((w) => parseColor(w) === accent) ?? accent
}

function profile(view: SettingsView): SettingsRow[] {
  return [
    { kind: 'text', id: 'name', label: 'Display name', value: view.name },
    { kind: 'action', id: 'code', label: 'Contact code', value: view.code },
    { kind: 'choice', id: 'badge', label: 'Badge beside my name', options: BADGE_CHOICES, value: view.settings.badge, custom: true },
  ]
}

function appearance(view: SettingsView): SettingsRow[] {
  return [
    { kind: 'choice', id: 'theme', label: 'Theme', options: view.themes, value: view.settings.theme, custom: true },
    { kind: 'choice', id: 'accent', label: 'Accent color', options: ['auto', ...COLOR_WORDS], value: accentChoice(view.settings.accent), custom: true },
    { kind: 'choice', id: 'density', label: 'Message spacing', options: DENSITIES, value: view.settings.density },
    toggle(view, 'sidebar', 'Sidebar'),
  ]
}

function notifications(view: SettingsView): SettingsRow[] {
  return [
    { kind: 'toggle', id: 'notify', label: 'Desktop notifications', value: view.settings.notify },
    { kind: 'toggle', id: 'sound', label: 'Chime', value: view.settings.sound },
    toggle(view, 'alerts', 'All notifications (bell, taskbar, desktop)', 'restart to apply'),
  ]
}

function updates(view: SettingsView): SettingsRow[] {
  return [
    { kind: 'info', label: 'Version', value: view.update === null ? `pager ${view.version}` : `pager ${view.version} · update available ${view.update}` },
    { kind: 'action', id: 'update.check', label: 'Check for updates now' },
    toggle(view, 'updateCheck', 'Check daily', 'restart to apply'),
    { kind: 'action', id: 'changelog', label: "What's new in this version" },
  ]
}

function advanced(view: SettingsView): SettingsRow[] {
  return [
    toggle(view, 'reduceMotion', 'Reduce motion', 'restart to apply'),
    toggle(view, 'mouse', 'Mouse', 'restart to apply'),
    toggle(view, 'acp', 'ACP agent protocol', 'restart to apply'),
  ]
}

const BUILDERS: Record<SettingsSection, (view: SettingsView) => SettingsRow[]> = {
  profile,
  appearance,
  notifications,
  folders: () => [],
  agents: () => [],
  ai: () => [],
  privacy: () => [],
  updates,
  advanced,
}

/** Every row of the Settings tab, section headers included; sections with nothing to show are left out. */
export function buildSettingsRows(view: SettingsView): SettingsRow[] {
  return SETTINGS_SECTIONS.flatMap(({ key, title }): SettingsRow[] => {
    const rows = BUILDERS[key](view)
    return rows.length === 0 ? [] : [{ kind: 'section', section: key, title }, ...rows]
  })
}
