import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import type { MessageView } from '../engine.js'
import { DEFAULT_THEME, type Theme } from '../themes.js'

export interface Seg {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
}
export interface Line {
  key: string
  segs: Seg[]
  /** Set on a fold marker row: the message key a click expands. */
  fold?: string
}

const MAX_AUTHOR_COLUMNS = 20
const MIN_BODY_COLUMNS = 10

export const FOLD_ABOVE_ROWS = 30
export const FOLD_HEAD_ROWS = 12
export const FOLD_TAIL_ROWS = 6

export interface FoldState {
  enabled: boolean
  expanded: ReadonlySet<string>
}

const DEFAULT_FOLDS: FoldState = { enabled: true, expanded: new Set() }

export function colorFor(theme: Theme, key: string): string {
  return theme.authors[Number.parseInt(key.slice(0, 8), 16) % theme.authors.length] ?? theme.accent
}

const two = (n: number): string => String(n).padStart(2, '0')

/** `HH:MM`, prefixed by `MM-DD ` when not today. */
function stamp(ts: number, now: Date): string {
  const d = new Date(ts)
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? time : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${time}`
}

function truncate(s: string, columns: number): string {
  if (stringWidth(s) <= columns) return s
  let out = ''
  for (const ch of s) {
    if (stringWidth(out + ch) > columns - 1) break
    out += ch
  }
  return out + '…'
}

function wrap(text: string, columns: number): string[] {
  return wrapAnsi(text, Math.max(1, columns), { hard: true, trim: false }).split('\n')
}

const FENCE = /^\s*(```|~~~)\s*(\S*)/
const HEADING = /^#{1,6}\s+(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/

/** Splits a row into plain, `code` and **bold** segments over `base` styling. */
function inline(row: string, base: Omit<Seg, 'text'>, theme: Theme): Seg[] {
  const out: Seg[] = []
  for (const part of row.split(INLINE)) {
    if (part === '') continue
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) out.push({ ...base, text: part.slice(1, -1), color: theme.info })
    else if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) out.push({ ...base, text: part.slice(2, -2), bold: true })
    else out.push({ ...base, text: part })
  }
  return out.length === 0 ? [{ ...base, text: '' }] : out
}

/** Markdown source lines are styled before wrapping so fences and bullets keep their shape. */
function markdownRows(text: string, columns: number, theme: Theme): Seg[][] {
  const rows: Seg[][] = []
  let inCode = false
  for (const line of text.split('\n')) {
    const fence = FENCE.exec(line)
    if (fence) {
      inCode = !inCode
      if (inCode) rows.push([{ text: `▎ ${fence[2] || 'code'}`, dim: true }])
      continue
    }
    if (inCode) {
      for (const row of wrap(line, columns - 2)) rows.push([{ text: '▎ ', dim: true }, { text: row, color: theme.info }])
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      for (const row of wrap(heading[1] ?? '', columns)) rows.push([{ text: row, bold: true, color: theme.accent }])
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      const indent = bullet[1] ?? ''
      wrap(bullet[2] ?? '', columns - indent.length - 2).forEach((row, i) => {
        rows.push([{ text: i === 0 ? `${indent}• ` : ' '.repeat(indent.length + 2) }, ...inline(row, {}, theme)])
      })
      continue
    }
    const quote = QUOTE.exec(line)
    const base: Omit<Seg, 'text'> = quote ? { dim: true, italic: true } : {}
    for (const row of wrap(quote ? (quote[1] ?? '') : line, columns)) rows.push(inline(row, base, theme))
  }
  return rows
}

export function buildLines(
  messages: MessageView[],
  width: number,
  theme: Theme = DEFAULT_THEME,
  now: Date = new Date(),
  folds: FoldState = DEFAULT_FOLDS,
): Line[] {
  const lines: Line[] = []
  for (const m of messages) {
    if (m.kind === 'system') {
      wrap(`* ${m.text}`, width).forEach((text, i) => {
        lines.push({ key: `${m.key}:${i}`, segs: [{ text: i === 0 ? text : `  ${text}`, dim: true, italic: true }] })
      })
      continue
    }
    const prefix = stamp(m.ts, now)
    const author = truncate(m.authorName, MAX_AUTHOR_COLUMNS)
    const bodyCol = stringWidth(prefix) + 1 + stringWidth(author) + 2
    const suffix = m.status === null ? 0 : 2
    const columns = Math.max(MIN_BODY_COLUMNS, width - bodyCol - suffix)
    let rows: Seg[][] = m.markdown ? markdownRows(m.text, columns, theme) : wrap(m.text, columns).map((row) => [{ text: row }])
    let foldAt = -1
    if (folds.enabled && !folds.expanded.has(m.key) && rows.length > FOLD_ABOVE_ROWS) {
      const hidden = rows.length - FOLD_HEAD_ROWS - FOLD_TAIL_ROWS
      foldAt = FOLD_HEAD_ROWS
      rows = [
        ...rows.slice(0, FOLD_HEAD_ROWS),
        [{ text: `▸ ${hidden} more lines · click or Ctrl+T to expand`, dim: true }],
        ...rows.slice(rows.length - FOLD_TAIL_ROWS),
      ]
    }
    rows.forEach((row, i) => {
      const segs: Seg[] =
        i === 0
          ? [
              { text: prefix, dim: true },
              { text: ' ' },
              { text: author, bold: true, color: m.mine ? theme.mine : colorFor(theme, m.authorKey) },
              { text: '  ' },
              ...row,
            ]
          : [{ text: ' '.repeat(bodyCol) }, ...row]
      if (i === rows.length - 1 && m.status === 'delivered') segs.push({ text: ' ✓', color: theme.success })
      if (i === rows.length - 1 && m.status === 'pending') segs.push({ text: ' …', color: theme.warning })
      lines.push(i === foldAt ? { key: `${m.key}:${i}`, segs, fold: m.key } : { key: `${m.key}:${i}`, segs })
    })
  }
  return lines
}

/** `offsetFromBottom` 0 shows the newest lines; it is clamped to the scrollable range. */
export function windowLines(lines: Line[], height: number, offsetFromBottom: number): { visible: Line[]; maxOffset: number } {
  const maxOffset = Math.max(0, lines.length - height)
  const offset = Math.min(Math.max(0, offsetFromBottom), maxOffset)
  const end = lines.length - offset
  return { visible: lines.slice(Math.max(0, end - height), end), maxOffset }
}

/** Unstyled wrapped lines (home view). */
export function plainLines(texts: string[], width: number): Line[] {
  // An empty row would collapse to zero height in Ink; a space keeps the blank line.
  return texts.flatMap((text, i) =>
    wrap(text, width).map((row, j): Line => ({ key: `p${i}:${j}`, segs: [{ text: row === '' ? ' ' : row }] })),
  )
}
