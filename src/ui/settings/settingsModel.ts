import type { SettingsView } from '../../app/settingsView.js'
import { COLOR_WORDS, parseColor } from '../theme/colors.js'
import { DENSITIES, SOUND_MODES } from '../../app/settings.js'
import { SOUND_NAMES } from '../../platform/sounds.js'
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
    { kind: 'choice', id: 'soundMode', label: 'Sounds (pings: only /ping makes one)', options: SOUND_MODES, value: view.settings.soundMode },
    { kind: 'choice', id: 'notifySound', label: 'Message and ping sound', options: SOUND_NAMES, value: view.settings.notifySound },
    { kind: 'choice', id: 'ringSound', label: 'Call ring', options: SOUND_NAMES, value: view.settings.ringSound },
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

function ai(view: SettingsView): SettingsRow[] {
  const rows: SettingsRow[] = [toggle(view, 'web', 'Web search', 'restart to apply')]
  const a = view.ai
  if (!view.agentsOn || a === undefined) return rows
  const text = (id: string, label: string, value: string, extra: Partial<Extract<SettingsRow, { kind: 'text' }>> = {}): SettingsRow => {
    const locked = a.locks[id]
    return { kind: 'text', id, label, value, ...extra, ...(locked === undefined ? {} : { locked }) }
  }
  rows.push({ kind: 'choice', id: 'ai.default', label: 'Default backend', options: ['auto', ...a.backends], value: a.default })
  rows.push(text('ai.ollama.url', 'Ollama address', a.ollama.url))
  rows.push(text('ai.ollama.model', 'Ollama model (blank = first installed)', a.ollama.model))
  rows.push(text('ai.openai.url', 'OpenAI-compatible address', a.openai.url))
  rows.push(text('ai.openai.model', 'OpenAI-compatible model', a.openai.model))
  rows.push(text('ai.openai.key', 'API key (or PAGER_AI_KEY)', a.openai.keyHint, { masked: true, initial: '' }))
  rows.push({ kind: 'info', label: 'Agents run headless in a scratch folder; Ollama and API replies stream and have no tools', value: '' })
  rows.push({ kind: 'action', id: 'ai.clear', label: 'Clear AI chat history and scratch files', confirm: true })
  return rows
}

function privacy(view: SettingsView): SettingsRow[] {
  const p = view.privacy
  const run = p.lan === undefined ? 'Internet' : `LAN: ${p.lan.hosting ? 'hosting' : 'joined'} ${p.lan.address}`
  const rows: SettingsRow[] = [
    { kind: 'info', label: 'Encryption', value: p.encrypted ? 'on (passphrase)' : 'off (run: pager lock)' },
    toggle(view, 'lan', 'LAN-only mode', 'restart to apply'),
    toggle(view, 'agents', 'Agents (room, AI chat, agent tools)', 'restart to apply'),
    { kind: 'info', label: 'This run', value: `${run} · Agents: ${view.agentsOn ? 'on' : 'off'}` },
    { kind: 'info', label: 'Listening', value: p.net.listening ? 'yes' : 'no' },
    { kind: 'info', label: 'Contacts online', value: String(p.net.contacts.filter((c) => c.online).length) },
  ]
  for (const c of p.net.contacts) {
    rows.push({ kind: 'info', label: `${c.online ? '●' : '○'} ${c.name}`, value: c.pending ? 'request pending' : c.online ? c.caps.join(', ') || 'no extras' : 'offline' })
  }
  rows.push({ kind: 'action', id: 'net.log', label: 'net.log', value: p.net.logPath })
  return rows
}

const BUILDERS: Record<SettingsSection, (view: SettingsView) => SettingsRow[]> = {
  profile,
  appearance,
  notifications,
  folders,
  agents,
  ai,
  privacy,
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
