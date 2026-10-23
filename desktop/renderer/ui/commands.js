// Command registry: every action the palette lists and every hotkey runs. Chords can be overridden per command in settings.keybinds.
import { app } from './store.js'

const registry = new Map()
const recent = []

export function registerCommand(cmd) {
  registry.set(cmd.id, cmd)
  return () => registry.get(cmd.id) === cmd && registry.delete(cmd.id)
}
export function registerCommands(list) {
  const offs = list.map(registerCommand)
  return () => offs.forEach((f) => f())
}

const resolveKeys = (cmd) => (app.settings.keybinds && app.settings.keybinds[cmd.id]) || cmd.keys || ''

export function allCommands() {
  return Array.from(registry.values())
    .filter((c) => !c.hidden && (!c.when || c.when()))
    .map((c) => ({ ...c, keys: resolveKeys(c), kind: c.kind || 'command' }))
}

export function getCommand(id) {
  const c = registry.get(id)
  return c ? { ...c, keys: resolveKeys(c) } : null
}

export function runCommand(id, arg) {
  const c = registry.get(id)
  if (!c || (c.when && !c.when())) return false
  const i = recent.indexOf(id)
  if (i >= 0) recent.splice(i, 1)
  recent.unshift(id)
  recent.length = Math.min(recent.length, 12)
  try {
    const r = c.run(arg)
    if (r && typeof r.catch === 'function') r.catch((e) => app.emit('error', e))
  } catch (e) {
    app.emit('error', e)
  }
  return true
}

export const recentCommands = () => recent.slice()

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta']
const NAMED = { ' ': 'Space', Esc: 'Escape' }

/** KeyboardEvent -> 'Ctrl+Shift+A'. Returns '' for bare modifier presses. */
export function chordFromEvent(e) {
  let k = e.key
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return ''
  k = NAMED[k] || (k.length === 1 ? k.toUpperCase() : k)
  // Shift changes the produced character for symbols; name the physical key for stable chords.
  if (e.shiftKey && k.length === 1 && /[^A-Z0-9]/.test(k) && e.code) {
    const m = /^(?:Key|Digit)(.)$/.exec(e.code)
    if (m) k = m[1]
    else if (e.code === 'Equal') k = '='
    else if (e.code === 'Minus') k = '-'
    else if (e.code === 'Backquote') k = '`'
    else if (e.code === 'Comma') k = ','
    else if (e.code === 'Period') k = '.'
    else if (e.code === 'Slash') k = '/'
    else if (e.code === 'Backslash') k = '\\'
  }
  const mods = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Meta')
  return [...mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b)), k].join('+')
}

export const splitChord = (chord) => (chord ? String(chord).split('+').map((s) => (s === '' ? '+' : s)) : [])

/** chord -> command (honours keybind overrides and `when`). */
export function commandForChord(chord) {
  if (!chord) return null
  for (const c of registry.values()) {
    if (resolveKeys(c) === chord && (!c.when || c.when())) return c
  }
  return null
}
