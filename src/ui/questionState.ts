import type { AnswerMap, QuestionField, QuestionView } from '../agents/questions.js'
import { editedText, stepOf, typed, wrapIndex, type Press } from './pickerNav.js'

/** Where the user is in an agent's question. One entry per field in each array. */
export interface PickerState {
  field: number
  /** Cursor row per field: the options, then the Other row when the field allows one. */
  row: number[]
  /** Chosen option values per field. */
  picked: string[][]
  /** Typed text per field: the "Other" answer, or the whole answer of a free-text field. */
  text: string[]
}

export type PickerEffect = { kind: 'submit'; answers: AnswerMap } | { kind: 'cancel' }

/** Rows a field shows: its options, plus the Other row, or the single text row of a free-text field. */
export function fieldRows(f: QuestionField): number {
  return f.kind === 'text' ? 1 : f.options.length + (f.allowOther ? 1 : 0)
}

/** Whether `row` of `f` is the text field (Rule: while it is focused every printable key types into it). */
export function isTextRow(f: QuestionField, row: number): boolean {
  return f.kind === 'text' || (f.allowOther && row === f.options.length)
}

export function initPicker(view: QuestionView): PickerState {
  const recommended = view.fields.map((f) => (f.recommended === undefined ? -1 : f.options.findIndex((o) => o.value === f.recommended)))
  return {
    field: 0,
    row: recommended.map((i) => Math.max(0, i)),
    picked: view.fields.map((f, i) => (f.multi && (recommended[i] ?? -1) >= 0 && f.recommended !== undefined ? [f.recommended] : [])),
    text: view.fields.map(() => ''),
  }
}

/** The answers as the agent expects them: a value (or list for multi) per field, and `${key}__other` for typed text. */
export function answersOf(view: QuestionView, s: PickerState): AnswerMap {
  const out: AnswerMap = {}
  view.fields.forEach((f, i) => {
    const picked = s.picked[i] ?? []
    const text = (s.text[i] ?? '').trim()
    if (f.kind === 'text') out[f.key] = text
    else if (f.multi) out[f.key] = picked
    else if (picked[0] !== undefined) out[f.key] = picked[0]
    if (f.kind !== 'text' && f.allowOther && text !== '') out[`${f.key}__other`] = text
  })
  return out
}

/** One-line summary of what a finished field answered. */
export function answerSummary(f: QuestionField, s: PickerState, i: number): string {
  const labels = (s.picked[i] ?? []).map((v) => f.options.find((o) => o.value === v)?.label ?? v)
  const text = (s.text[i] ?? '').trim()
  if (text !== '') labels.push(f.kind === 'text' ? text : `other: ${text}`)
  return labels.length === 0 ? '—' : labels.join(', ')
}

function advance(view: QuestionView, s: PickerState): { state: PickerState; effect?: PickerEffect } {
  if (s.field >= view.fields.length - 1) return { state: s, effect: { kind: 'submit', answers: answersOf(view, s) } }
  return { state: { ...s, field: s.field + 1 } }
}

function setAt<T>(list: readonly T[], at: number, value: T): T[] {
  return list.map((v, i) => (i === at ? value : v))
}

/**
 * One key press. Up/Down move, Space picks (single) or toggles (multi), Enter confirms the field and submits after the last,
 * Tab/Shift+Tab change field, Esc cancels. On a text row every printable key (Space included) types; Enter there confirms.
 */
export function pickerKey(view: QuestionView, s: PickerState, p: Press): { state: PickerState; effect?: PickerEffect } {
  const f = view.fields[s.field]
  if (f === undefined) return { state: s }
  if (p.escape === true) return { state: s, effect: { kind: 'cancel' } }
  const row = Math.min(s.row[s.field] ?? 0, Math.max(0, fieldRows(f) - 1))
  const text = isTextRow(f, row)
  const move = stepOf(p)
  if (move !== 0) return { state: { ...s, row: setAt(s.row, s.field, wrapIndex(row, move, fieldRows(f))) } }
  if (p.tab === true) {
    const next = Math.min(view.fields.length - 1, Math.max(0, s.field + (p.shift === true ? -1 : 1)))
    return { state: { ...s, field: next } }
  }
  const option = text ? undefined : f.options[row]
  if (p.return === true) {
    if (text) {
      if (f.kind !== 'text' && !f.multi && (s.text[s.field] ?? '').trim() === '') return { state: s }
      // A typed Other answer replaces any single pick.
      return advance(view, f.kind !== 'text' && !f.multi ? { ...s, picked: setAt(s.picked, s.field, []) } : s)
    }
    if (option === undefined) return { state: s }
    const picked = s.picked[s.field] ?? []
    if (f.multi) return advance(view, picked.length === 0 && (s.text[s.field] ?? '') === '' ? { ...s, picked: setAt(s.picked, s.field, [option.value]) } : s)
    return advance(view, { ...s, picked: setAt(s.picked, s.field, [option.value]), text: setAt(s.text, s.field, '') })
  }
  if (text) {
    const next = editedText(s.text[s.field] ?? '', p)
    if (next === undefined) return { state: s }
    // Typing Other deselects a single choice: the typed text is the answer.
    const clear = f.kind !== 'text' && !f.multi
    return { state: { ...s, text: setAt(s.text, s.field, next), picked: clear ? setAt(s.picked, s.field, []) : s.picked } }
  }
  if (typed(p) === ' ' && option !== undefined) {
    const picked = s.picked[s.field] ?? []
    if (!f.multi) return { state: { ...s, picked: setAt(s.picked, s.field, [option.value]), text: setAt(s.text, s.field, '') } }
    const has = picked.includes(option.value)
    return { state: { ...s, picked: setAt(s.picked, s.field, has ? picked.filter((v) => v !== option.value) : [...picked, option.value]) } }
  }
  return { state: s }
}

/** Rows the card's border takes (top and bottom); the component hands `height - PICKER_BORDER_ROWS` to `pickerRows`. */
export const PICKER_BORDER_ROWS = 2

/** Rows the picker occupies for a question: constant while it is open, so the pane above does not jump between fields. */
export function pickerHeight(view: QuestionView, maxRows: number): number {
  const fixed = 1 + view.fields.length + 1
  const body = Math.max(1, ...view.fields.map(fieldRows))
  return PICKER_BORDER_ROWS + Math.max(fixed + 2, Math.min(maxRows - PICKER_BORDER_ROWS, fixed + body))
}

/** A key in the hint row and what it does: drawn as a keycap `‹Enter›` and a dim word. */
export interface HintKey {
  key: string
  label: string
}

export type PickerRow =
  | { kind: 'head'; agent: string; message: string }
  | { kind: 'field'; status: 'done' | 'current' | 'todo'; index: number; total: number; label: string; answer: string }
  | { kind: 'option'; marker: string; label: string; description: string; recommended: boolean; here: boolean }
  | { kind: 'other'; marker: string; text: string; here: boolean; label: string }
  | { kind: 'hint'; lead: string; keys: HintKey[] }

function hintFor(f: QuestionField, text: boolean, last: boolean): { lead: string; keys: HintKey[] } {
  const enter: HintKey = { key: 'Enter', label: last ? 'submit' : 'next' }
  const keys: HintKey[] = [{ key: '↑↓', label: 'move' }]
  if (!text) keys.push({ key: 'Space', label: f.multi ? 'toggle' : 'pick' })
  keys.push(enter, { key: 'Tab', label: 'field' }, { key: 'Esc', label: 'cancel' })
  return { lead: text ? 'type your answer' : '', keys }
}

/** The picker as rows of data, `height` rows in all (see pickerHeight); the component only styles them. */
export function pickerRows(view: QuestionView, s: PickerState, height: number): PickerRow[] {
  const rows: PickerRow[] = [{ kind: 'head', agent: view.agent, message: view.message }]
  view.fields.forEach((f, i) => {
    const status = i < s.field ? 'done' : i === s.field ? 'current' : 'todo'
    rows.push({ kind: 'field', status, index: i + 1, total: view.fields.length, label: f.label, answer: status === 'done' ? answerSummary(f, s, i) : '' })
    if (i !== s.field) return
    const count = fieldRows(f)
    const body = Math.max(1, height - 2 - view.fields.length)
    const cursor = Math.min(s.row[i] ?? 0, count - 1)
    const start = Math.max(0, Math.min(cursor - Math.floor(body / 2), count - body))
    for (let n = start; n < Math.min(count, start + body); n++) {
      const here = n === cursor
      const picked = s.picked[i] ?? []
      const o = f.options[n]
      if (o !== undefined) {
        const on = picked.includes(o.value)
        const marker = f.multi ? (on ? '[x]' : '[ ]') : on ? '●' : '○'
        rows.push({ kind: 'option', marker, label: o.label, description: o.description ?? '', recommended: f.recommended === o.value, here })
      } else {
        const typedText = s.text[i] ?? ''
        const on = typedText !== '' && (f.multi || picked.length === 0)
        const marker = f.kind === 'text' ? '✎' : f.multi ? (on ? '[x]' : '[ ]') : on ? '●' : '○'
        rows.push({ kind: 'other', marker, label: f.kind === 'text' ? 'answer' : 'Other', text: typedText, here })
      }
    }
  })
  const cur = view.fields[s.field]
  const row = cur === undefined ? 0 : Math.min(s.row[s.field] ?? 0, fieldRows(cur) - 1)
  const hint = cur === undefined ? { lead: '', keys: [] } : hintFor(cur, isTextRow(cur, row), s.field >= view.fields.length - 1)
  rows.push({ kind: 'hint', ...hint })
  return rows
}
