import type { SetupRow } from '../agents/orchestrator.js'
import { editedText, stepOf, wrapIndex, type Press } from './pickerNav.js'

export type Tone = 'ok' | 'busy' | 'bad' | 'dim'

/** One setup row as the screen draws it: a glyph and word (never colour alone), plus the reason when there is one. */
export interface SetupLine {
  glyph: string
  word: string
  tone: Tone
  reason?: string
}

export function setupLine(row: SetupRow): SetupLine {
  const r = row.readiness
  switch (r.state) {
    case 'ready':
      return { glyph: '●', word: 'ready', tone: 'ok' }
    case 'checking':
      return { glyph: '◌', word: 'checking', tone: 'busy' }
    case 'missing':
      return { glyph: '✗', word: 'missing', tone: 'bad', reason: r.reason }
    case 'failed':
      return { glyph: '!', word: 'failed', tone: 'bad', reason: r.reason }
    default:
      return { glyph: '◌', word: 'not checked', tone: 'dim' }
  }
}

/** The lines under the selected row: what runs, and for an agent that is not ready why and how to install or sign in. */
export function setupDetail(row: SetupRow): string[] {
  const lines = [`runs: ${row.command}`]
  const r = row.readiness
  if (r.state === 'ready') return lines
  if ((r.state === 'missing' || r.state === 'failed') && r.reason !== '') lines.push(r.reason)
  if (row.install !== undefined) lines.push(`install: ${row.install}`)
  if (row.auth !== undefined) lines.push(`sign in: ${row.auth}`)
  return lines
}

export type SetupAction =
  | { kind: 'add'; cli: string }
  | { kind: 'install'; text: string }
  | { kind: 'recheck'; cli: string }
  | { kind: 'wait' }

/** What Enter does on a row. */
export function setupAction(row: SetupRow): SetupAction {
  switch (row.readiness.state) {
    case 'ready':
      return { kind: 'add', cli: row.id }
    case 'checking':
      return { kind: 'wait' }
    case 'missing':
      return { kind: 'install', text: row.install === undefined ? `${row.label} is not installed (${row.command})` : `install ${row.label}: ${row.install}` }
    default:
      return { kind: 'recheck', cli: row.id }
  }
}

/** Selection: `row` indexes the agent rows, and `rows.length` is the `custom:` text row after them. */
export interface SetupState {
  row: number
  text: string
}

export type SetupEffect =
  | { kind: 'close' }
  | { kind: 'add'; cli: string }
  | { kind: 'install'; text: string }
  | { kind: 'recheck'; cli: string }
  | { kind: 'remove'; cli: string }
  /** The `custom:` line was submitted: the `/agent add` command to run, or the usage problem. */
  | { kind: 'custom'; command: string }
  | { kind: 'usage' }

/** Rule: printable keys act only when no text field is focused. On the `custom:` row every printable key types, `r` and `x` included. `r` rechecks, `x` (or Delete) removes. */
export function setupKey(state: SetupState, rows: readonly SetupRow[], p: Press): { state: SetupState; effect?: SetupEffect } {
  const count = rows.length + 1
  const row = Math.min(state.row, count - 1)
  const onText = row === rows.length
  if (p.escape === true) return { state, effect: { kind: 'close' } }
  const step = stepOf(p)
  if (step !== 0) return { state: { ...state, row: wrapIndex(row, step, count) } }
  if (p.return === true) {
    if (onText) {
      const line = state.text.trim()
      const words = line.split(/\s+/)
      if (line === '' || words.length < 2) return { state, effect: { kind: 'usage' } }
      return { state: { ...state, text: '' }, effect: { kind: 'custom', command: `/agent add ${line}` } }
    }
    const target = rows[row]
    if (target === undefined) return { state }
    const action = setupAction(target)
    return action.kind === 'wait' ? { state } : { state, effect: action }
  }
  if (onText) {
    const next = editedText(state.text, p)
    return next === undefined ? { state } : { state: { ...state, text: next } }
  }
  if (p.input === 'r' && p.ctrl !== true && p.meta !== true) {
    const target = rows[row]
    return target === undefined ? { state } : { state, effect: { kind: 'recheck', cli: target.id } }
  }
  if ((p.input === 'x' || p.delete === true) && p.ctrl !== true && p.meta !== true) {
    const target = rows[row]
    return target === undefined ? { state } : { state, effect: { kind: 'remove', cli: target.id } }
  }
  return { state }
}
