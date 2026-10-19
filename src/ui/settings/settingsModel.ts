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

function agents(view: SettingsView): SettingsRow[] {
  if (!view.agentsOn) return []
  const a = view.agents
  const rows: SettingsRow[] = [{ kind: 'action', id: 'agents.setup', label: 'Teammates and installs…' }]
  for (const t of a.agents) {
    rows.push({ kind: 'action', id: `agent.model:${t.name}`, label: `${t.name}: model and effort`, value: `${t.model} · ${t.effort}` })
    rows.push({ kind: 'choice', id: `agent.color:${t.name}`, label: `${t.name}: color`, options: ['auto', ...COLOR_WORDS], value: t.color, custom: true })
  }
  rows.push({ kind: 'toggle', id: 'agents.review', label: 'Peer review after file changes', value: a.review })
  rows.push({ kind: 'toggle', id: 'agents.risk', label: 'Ask before risky actions', value: a.risk })
  const budgetOf = (key: string): string => a.budgets.find((b) => b.key === key)?.text ?? ''
  for (const key of ['*', ...a.agents.map((t) => t.name)]) {
    rows.push({
      kind: 'text',
      id: `agents.budget:${key}`,
      label: `Daily cap · ${key === '*' ? 'all agents' : key} (e.g. turns=20 minutes=60, or off)`,
      value: budgetOf(key) === '' ? 'no cap' : budgetOf(key),
      initial: budgetOf(key),
    })
  }
  rows.push({ kind: 'text', id: 'agents.verify', label: 'Verify command (off clears)', value: a.verify === '' ? 'off' : a.verify, initial: a.verify })
  rows.push({ kind: 'text', id: 'agents.goal', label: 'Shared goal', value: a.goal })
  rows.push({ kind: 'action', id: 'agents.memory.show', label: 'Show shared memory' })
  rows.push({ kind: 'text', id: 'agents.memory.add', label: 'Add a note to memory', value: '' })
  rows.push({ kind: 'action', id: 'agents.memory.clear', label: 'Clear shared memory', confirm: true })
  if (a.guests.length > 0 || a.sessions.length > 0) rows.push({ kind: 'info', label: 'Shared sessions', value: '' })
  for (const g of a.guests) rows.push({ kind: 'action', id: `guest.kick:${g.pk}`, label: `Remove ${g.name}`, value: g.mode, confirm: true })
  if (a.guests.length > 0) rows.push({ kind: 'action', id: 'guest.kickall', label: 'Remove everyone from my session', confirm: true })
  for (const s of a.sessions) rows.push({ kind: 'action', id: `session.leave:${s.pk}`, label: `Leave ${s.name}'s session`, confirm: true })
  return rows
}

function folders(view: SettingsView): SettingsRow[] {
  const rows: SettingsRow[] = [{ kind: 'action', id: 'folder.new', label: 'New folder…' }]
  for (const f of view.folders) {
    rows.push({ kind: 'text', id: `folder:${f.name}`, label: f.name, value: `${f.count} ${f.count === 1 ? 'chat' : 'chats'}`, initial: f.name })
    rows.push({ kind: 'action', id: `folder.delete:${f.name}`, label: `Delete "${f.name}"`, confirm: true })
  }
  return rows
}

const BUILDERS: Record<SettingsSection, (view: SettingsView) => SettingsRow[]> = {
  profile,
  appearance,
  notifications,
  folders,
  agents,
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
