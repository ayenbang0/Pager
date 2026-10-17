import { editedText, stepOf, wrapIndex, type Press } from './pickerNav.js'

export type SettingKind = 'model' | 'effort'

export interface Choice {
  value: string
  label: string
}

/** One column of the picker: what the agent offers, and whether pager can change it at all. */
export interface ColumnSpec {
  kind: SettingKind
  /** False when the agent advertises no such option and its CLI has no flag for it. */
  settable: boolean
  choices: Choice[]
  /** The value in effect, if one was chosen. */
  current?: string
}

export type ColumnRow = { kind: 'default' } | { kind: 'choice'; value: string; label: string } | { kind: 'text' }

/** Rows of a column: `default` (clear the setting), then the offered values, or a free-text row when the agent offers no list. */
export function columnRows(spec: ColumnSpec): ColumnRow[] {
  if (!spec.settable) return []
  const list: ColumnRow[] = [{ kind: 'default' }]
  if (spec.choices.length === 0) list.push({ kind: 'text' })
  else for (const c of spec.choices) list.push({ kind: 'choice', value: c.value, label: c.label })
  return list
}

/** Which row of a column carries the value in effect (a typed value no list knows has none). */
export function currentRow(spec: ColumnSpec): number {
  if (spec.current === undefined) return 0
  const at = columnRows(spec).findIndex((r) => r.kind === 'choice' && r.value === spec.current)
  return Math.max(0, at)
}

export interface PickerPair {
  model: ColumnSpec
  effort: ColumnSpec
}

export interface ModelPickerState {
  col: 0 | 1
  row: [number, number]
  text: [string, string]
}

export type ModelPickerEffect = { kind: 'close' } | { kind: 'apply'; changes: { kind: SettingKind; value: string }[] }

const COLUMNS = ['model', 'effort'] as const

export function initModelPicker(p: PickerPair): ModelPickerState {
  return { col: p.model.settable || !p.effort.settable ? 0 : 1, row: [currentRow(p.model), currentRow(p.effort)], text: ['', ''] }
}

/** The changes Enter applies: every settable column whose chosen row differs from what is in effect. */
export function pendingChanges(p: PickerPair, s: ModelPickerState): { kind: SettingKind; value: string }[] {
  const out: { kind: SettingKind; value: string }[] = []
  COLUMNS.forEach((kind, i) => {
    const spec = p[kind]
    const row = columnRows(spec)[Math.min(s.row[i] ?? 0, Math.max(0, columnRows(spec).length - 1))]
    if (row === undefined) return
    if (row.kind === 'default') {
      if (spec.current !== undefined) out.push({ kind, value: 'default' })
    } else if (row.kind === 'choice') {
      if (row.value !== spec.current) out.push({ kind, value: row.value })
    } else {
      const value = (s.text[i] ?? '').trim()
      if (value !== '' && value !== spec.current) out.push({ kind, value })
    }
  })
  return out
}

/**
 * Tab, Shift+Tab and Left/Right switch column; Up/Down move; Enter applies both columns and closes; Esc closes.
 * The free-text row types every printable key; no other row treats a printable key as a command.
 */
export function modelPickerKey(p: PickerPair, s: ModelPickerState, press: Press): { state: ModelPickerState; effect?: ModelPickerEffect } {
  if (press.escape === true) return { state: s, effect: { kind: 'close' } }
  if (press.return === true) return { state: s, effect: { kind: 'apply', changes: pendingChanges(p, s) } }
  if (press.tab === true || press.leftArrow === true || press.rightArrow === true) {
    return { state: { ...s, col: s.col === 0 ? 1 : 0 } }
  }
  const spec = p[COLUMNS[s.col]]
  const rows = columnRows(spec)
  const row = Math.min(s.row[s.col], Math.max(0, rows.length - 1))
  const step = stepOf(press)
  if (step !== 0) {
    const next: [number, number] = [...s.row]
    next[s.col] = wrapIndex(row, step, rows.length)
    return { state: { ...s, row: next } }
  }
  if (rows[row]?.kind === 'text') {
    const edited = editedText(s.text[s.col], press)
    if (edited === undefined) return { state: s }
    const text: [string, string] = [...s.text]
    text[s.col] = edited
    return { state: { ...s, text } }
  }
  return { state: s }
}

/** The agent chooser shown first when the picker opens outside an agent tab. */
export function pickAgentKey(names: readonly string[], row: number, press: Press): { row: number; pick?: string; close?: boolean } {
  if (press.escape === true) return { row, close: true }
  if (press.return === true) {
    const name = names[row]
    return name === undefined ? { row } : { row, pick: name }
  }
  return { row: wrapIndex(row, stepOf(press), names.length) }
}
