import { SETTINGS_SECTIONS_KEYS } from '../../app/commands.js'
import { fitSegs, pillSeg, selectedBar, spread, type Seg } from '../kit/segs.js'
import { wrapIndex, stepOf, type Press } from '../input/pickerNav.js'
import { groupHeader } from '../sidebar/sidebarRows.js'
import type { Theme } from '../theme/themes.js'

export type SettingsSection = (typeof SETTINGS_SECTIONS_KEYS)[number]

const TITLES: Record<SettingsSection, string> = {
  profile: 'Profile',
  appearance: 'Appearance',
  notifications: 'Notifications',
  folders: 'Folders',
  agents: 'Agents',
  ai: 'AI chat and Web',
  privacy: 'Privacy and Network',
  updates: 'Updates and About',
  advanced: 'Advanced',
}

export const SETTINGS_SECTIONS: readonly { key: SettingsSection; title: string }[] = SETTINGS_SECTIONS_KEYS.map((key) => ({ key, title: TITLES[key] }))

export type SettingsRow =
  | { kind: 'section'; section: SettingsSection; title: string }
  | { kind: 'toggle'; id: string; label: string; value: boolean; note?: string; locked?: string }
  | { kind: 'choice'; id: string; label: string; options: readonly string[]; value: string; custom?: boolean; locked?: string }
  /** `initial` is what the edit field starts with when it differs from the shown value. */
  | { kind: 'text'; id: string; label: string; value: string; initial?: string; masked?: boolean; locked?: string }
  | { kind: 'action'; id: string; label: string; value?: string; confirm?: boolean }
  | { kind: 'info'; label: string; value: string }

export interface SettingsState {
  cursor: number
  /** The id of an action waiting for its second Enter. */
  confirming: string | null
}

export type SettingsEffect =
  /** A toggle flipped or a choice cycled. */
  | { kind: 'set'; id: string; value: boolean | string }
  /** Open the one-shot text field for this row. */
  | { kind: 'edit'; id: string }
  /** Run an action (after confirmation when it asks for one). */
  | { kind: 'run'; id: string }
  | { kind: 'locked'; source: string }

const selectable = (row: SettingsRow | undefined): boolean => row !== undefined && row.kind !== 'section' && row.kind !== 'info'
const PAGE = 8

/** The next selectable row from `from` in direction `dir`, wrapping; `from` itself when there is none. */
function step(rows: readonly SettingsRow[], from: number, dir: -1 | 1): number {
  for (let n = 1; n <= rows.length; n++) {
    const i = wrapIndex(from, dir * n, rows.length)
    if (selectable(rows[i])) return i
  }
  return from
}

/** The first selectable row at or after `from` (or before it, for dir -1), without wrapping. */
function edge(rows: readonly SettingsRow[], from: number, dir: -1 | 1): number {
  for (let i = from; i >= 0 && i < rows.length; i += dir) if (selectable(rows[i])) return i
  return -1
}

/** The first selectable row at or after `cursor` (0 when none), for a fresh state. */
export function firstCursor(rows: readonly SettingsRow[], cursor = 0): number {
  const at = edge(rows, Math.max(0, Math.min(cursor, rows.length - 1)), 1)
  return at >= 0 ? at : Math.max(0, edge(rows, rows.length - 1, -1))
}

function jump(rows: readonly SettingsRow[], from: number, delta: number): number {
  const target = Math.max(0, Math.min(rows.length - 1, from + delta))
  const forward = delta > 0 ? 1 : -1
  const hit = edge(rows, target, forward)
  if (hit >= 0) return hit
  const back = edge(rows, target, forward === 1 ? -1 : 1)
  return back >= 0 ? back : from
}

const lockOf = (row: SettingsRow): string | undefined => (row.kind === 'toggle' || row.kind === 'choice' || row.kind === 'text' ? row.locked : undefined)

/** One key press in the Settings tab: the new cursor/confirmation state and, when the press changes something, what to do about it. */
export function settingsKey(state: SettingsState, rows: readonly SettingsRow[], press: Press): { state: SettingsState; effect?: SettingsEffect } {
  const here = Math.min(state.cursor, Math.max(0, rows.length - 1))
  const row = rows[here]
  const move = (cursor: number): { state: SettingsState } => ({ state: { cursor, confirming: null } })
  const dir = stepOf(press)
  if (dir !== 0) return move(step(rows, here, dir))
  if (press.pageDown === true) return move(jump(rows, here, PAGE))
  if (press.pageUp === true) return move(jump(rows, here, -PAGE))
  if (press.home === true) return move(Math.max(0, edge(rows, 0, 1)))
  if (press.end === true) return move(Math.max(0, edge(rows, rows.length - 1, -1)))
  if (row === undefined || !selectable(row)) return { state }
  const keep = { state: { cursor: here, confirming: state.confirming } }

  if (press.input === '[' || press.input === ']') {
    if (row.kind === 'text' && row.id.startsWith('folder:')) {
      return { ...keep, effect: { kind: 'run', id: `${press.input === '[' ? 'folder-up' : 'folder-down'}:${row.id.slice('folder:'.length)}` } }
    }
    return { state }
  }

  const left = press.leftArrow === true
  const right = press.rightArrow === true
  const enter = press.return === true
  const space = press.input === ' '
  if (!left && !right && !enter && !space) return { state }

  const locked = lockOf(row)
  if (locked !== undefined) return { ...keep, effect: { kind: 'locked', source: locked } }

  switch (row.kind) {
    case 'toggle': {
      if (left || right) return { ...keep, effect: { kind: 'set', id: row.id, value: right } }
      return { ...keep, effect: { kind: 'set', id: row.id, value: !row.value } }
    }
    case 'choice': {
      if (enter && row.custom === true) return { ...keep, effect: { kind: 'edit', id: row.id } }
      const at = row.options.indexOf(row.value)
      const delta = left ? -1 : 1
      const next = row.options[wrapIndex(at < 0 ? (delta > 0 ? -1 : 0) : at, delta, row.options.length)]
      return next === undefined ? { state } : { ...keep, effect: { kind: 'set', id: row.id, value: next } }
    }
    case 'text':
      return enter || space ? { ...keep, effect: { kind: 'edit', id: row.id } } : { state }
    case 'action': {
      if (!enter && !space) return { state }
      if (row.confirm === true && state.confirming !== row.id) return { state: { cursor: here, confirming: row.id } }
      return { state: { cursor: here, confirming: null }, effect: { kind: 'run', id: row.id } }
    }
  }
  return { state }
}

const wrap = (segs: readonly Seg[], selected: boolean, width: number, theme: Theme): Seg[] => (selected ? selectedBar(segs, width, theme) : fitSegs([{ text: ' ' }, ...segs], width))

/** One row of exactly `width` columns. `confirming` shows the second-Enter prompt on an action row. */
export function settingsRowSegs(row: SettingsRow, selected: boolean, width: number, theme: Theme, confirming = false): Seg[] {
  switch (row.kind) {
    case 'section':
      return groupHeader(row.title, width, theme)
    case 'info': {
      const left: Seg[] = [{ text: row.label, color: theme.dim }]
      const right: Seg[] = [{ text: `${row.value} `, color: theme.text }]
      return fitSegs(spread([{ text: ' ' }, ...left], right, width), width)
    }
    case 'toggle': {
      const left: Seg[] = [{ text: row.label, color: theme.text }]
      const notes: Seg[] = row.locked !== undefined ? [{ text: `locked by ${row.locked} `, color: theme.dim }] : row.note !== undefined ? [{ text: `${row.note} `, color: theme.dim }] : []
      const right: Seg[] = [...notes, pillSeg(row.value ? 'on' : 'off', row.value ? theme.pill.success : theme.pill.muted), { text: ' ' }]
      return wrap(spread(left, right, width - 1), selected, width, theme)
    }
    case 'choice': {
      const left: Seg[] = [{ text: row.label, color: theme.text }]
      const tail: Seg[] = row.locked !== undefined ? [{ text: ` locked by ${row.locked}`, color: theme.dim }] : []
      const right: Seg[] = [{ text: '‹ ', color: theme.dim }, { text: row.value, color: theme.glow, bold: true }, { text: ' ›', color: theme.dim }, ...tail, { text: ' ' }]
      return wrap(spread(left, right, width - 1), selected, width, theme)
    }
    case 'text': {
      const shown = row.value === '' ? '—' : row.value
      const left: Seg[] = [{ text: row.label, color: theme.text }]
      const tail: Seg[] = row.locked !== undefined ? [{ text: ` locked by ${row.locked}`, color: theme.dim }] : []
      const right: Seg[] = [{ text: shown, color: row.value === '' ? theme.dim : theme.glow }, ...tail, { text: ' ' }]
      return wrap(spread(left, right, width - 1), selected, width, theme)
    }
    case 'action': {
      const left: Seg[] = [{ text: '▸ ', color: theme.accent }, { text: row.label, color: theme.text }]
      const value = confirming ? 'Press Enter again to confirm' : (row.value ?? '')
      const right: Seg[] = value === '' ? [{ text: ' ' }] : [{ text: value, color: confirming ? theme.warning : theme.dim, bold: confirming }, { text: ' ' }]
      return wrap(spread(left, right, width - 1), selected, width, theme)
    }
  }
}
