import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import type { KeySection } from '../input/keymap.js'

const NARROW_KEY_COLUMN = 26
const WIDE_KEY_COLUMN = 32
/** From this pane width the key column grows so a three-key combo fits on one row. */
const WIDE_PANE = 80
const MIN_ACTION_COLUMNS = 12
const SEPARATOR = ' / '
/** A key worth a keycap: optional modifiers, then one character or a named key. Anything else (`@name`, `/quit`, `wheel`) is accent text. */
const KEYCAP = /^(?:(?:Ctrl|Alt|Shift|Option|Cmd)\+)*(?:[A-Za-z0-9]|Enter|Esc|Tab|Space|Backspace|Delete|Up|Down|Left|Right|PgUp|PgDn|Home|End|F\d{1,2})$/
/** Where the quiet part of an action starts: a colon, semicolon or opening parenthesis. */
const DETAIL = /: |; | \(/

/** Width of the key column, including the gap before the action. */
export const helpKeyColumn = (width: number): number => (width >= WIDE_PANE ? WIDE_KEY_COLUMN : NARROW_KEY_COLUMN)

/** One run of a row's key column: a keycap (`‹Ctrl+G›` once drawn), accent text, or the dim ` / ` between alternatives. */
export interface KeyPiece {
  text: string
  style: 'cap' | 'text' | 'sep'
}

/** Display columns a piece takes once drawn (a keycap adds its two brackets). */
export const pieceWidth = (piece: KeyPiece): number => stringWidth(piece.text) + (piece.style === 'cap' ? 2 : 0)

/** One screen row of the help panel. */
export type HelpRow =
  | { kind: 'section'; text: string; /** The agent a section belongs to, drawn in its color. */ agent?: string }
  | { kind: 'gap' }
  | {
      kind: 'row'
      /** The key column as plain text (alternatives joined by ` / `, no keycap brackets). */
      keys: string
      pieces: KeyPiece[]
      /** Columns the pieces take once drawn. */
      keyWidth: number
      /** This row's slice of the action. */
      text: string
      /** Index in `text` where the dim detail starts (`text.length` when there is none). */
      detailFrom: number
    }

/** `keys` as rows of pieces, each at most `budget` columns wide: alternatives are filled in until one does not fit. */
function keyLines(keys: string, budget: number): KeyPiece[][] {
  const lines: KeyPiece[][] = []
  let line: KeyPiece[] = []
  let used = 0
  for (const alt of keys.split(SEPARATOR)) {
    const piece: KeyPiece = { text: alt, style: KEYCAP.test(alt) ? 'cap' : 'text' }
    const width = pieceWidth(piece)
    if (width > budget) {
      // Too long even alone: break it by display width, without brackets.
      if (line.length > 0) lines.push(line)
      const chunks = wrapAnsi(alt, budget, { hard: true }).split('\n')
      for (const chunk of chunks.slice(0, -1)) lines.push([{ text: chunk, style: 'text' }])
      const last = chunks.at(-1) ?? ''
      line = [{ text: last, style: 'text' }]
      used = stringWidth(last)
      continue
    }
    if (line.length > 0 && used + SEPARATOR.length + width > budget) {
      lines.push(line)
      line = []
      used = 0
    }
    if (line.length > 0) {
      line.push({ text: SEPARATOR, style: 'sep' })
      used += SEPARATOR.length
    }
    line.push(piece)
    used += width
  }
  if (line.length > 0 || lines.length === 0) lines.push(line)
  return lines
}

/** `action` wrapped to `columns`, each line with where its dim detail (the part after the first `:`, `;` or `(`) begins. */
function actionLines(action: string, columns: number): { text: string; detailFrom: number }[] {
  const split = DETAIL.exec(action)
  const detailAt = split !== null && split.index > 0 ? split.index + 1 : action.length
  let cursor = 0
  return wrapAnsi(action, columns, { hard: true })
    .split('\n')
    .map((text) => {
      const found = text === '' ? -1 : action.indexOf(text, cursor)
      const start = found === -1 ? cursor : found
      cursor = start + text.length
      return { text, detailFrom: Math.max(0, Math.min(text.length, detailAt - start)) }
    })
}

/**
 * Lays the sections out as screen rows for a pane `width` columns wide: a blank row between sections, and a key or action that
 * does not fit its column wrapped onto continuation rows (by display width) instead of being cut off.
 */
export function helpRows(sections: readonly KeySection[], width: number): HelpRow[] {
  const keyColumn = helpKeyColumn(width)
  const actionColumns = Math.max(MIN_ACTION_COLUMNS, width - keyColumn)
  const rows: HelpRow[] = []
  sections.forEach((section, i) => {
    if (i > 0) rows.push({ kind: 'gap' })
    rows.push({ kind: 'section', text: section.title.toUpperCase(), ...(section.agent === undefined ? {} : { agent: section.agent }) })
    for (const [keys, action] of section.rows) {
      const keyRows = keyLines(keys, keyColumn - 1)
      const actionRows = actionLines(action, actionColumns)
      for (let n = 0; n < Math.max(keyRows.length, actionRows.length); n++) {
        const pieces = keyRows[n] ?? []
        const text = actionRows[n]?.text ?? ''
        rows.push({
          kind: 'row',
          keys: pieces.map((p) => p.text).join(''),
          pieces,
          keyWidth: pieces.reduce((sum, p) => sum + pieceWidth(p), 0),
          text,
          detailFrom: actionRows[n]?.detailFrom ?? text.length,
        })
      }
    }
  })
  return rows
}

/** The scrollbar thumb for `visible` rows out of `total` scrolled to `top`: its first row and height, or undefined when everything fits. */
export function scrollThumb(total: number, visible: number, top: number): { start: number; size: number } | undefined {
  if (visible <= 0 || total <= visible) return undefined
  const size = Math.min(Math.max(1, visible - 1), Math.max(1, Math.round((visible * visible) / total)))
  const maxTop = total - visible
  return { start: Math.round((Math.min(Math.max(0, top), maxTop) / maxTop) * (visible - size)), size }
}
