import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import type { MessageView } from '../engine.js'

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
}

const AUTHOR_COLORS = ['magenta', 'yellow', 'green', 'blue', 'red', 'cyan']
const MAX_AUTHOR_COLUMNS = 20
const MIN_BODY_COLUMNS = 10

export function colorFor(key: string): string {
  return AUTHOR_COLORS[Number.parseInt(key.slice(0, 8), 16) % AUTHOR_COLORS.length] ?? 'white'
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

export function buildLines(messages: MessageView[], width: number, now: Date = new Date()): Line[] {
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
    const rows = wrap(m.text, Math.max(MIN_BODY_COLUMNS, width - bodyCol - suffix))
    rows.forEach((row, i) => {
      const segs: Seg[] =
        i === 0
          ? [
              { text: prefix, dim: true },
              { text: ' ' },
              { text: author, bold: true, color: m.mine ? 'cyan' : colorFor(m.authorKey) },
              { text: '  ' },
              { text: row },
            ]
          : [{ text: ' '.repeat(bodyCol) }, { text: row }]
      if (i === rows.length - 1 && m.status === 'delivered') segs.push({ text: ' ✓', color: 'green' })
      if (i === rows.length - 1 && m.status === 'pending') segs.push({ text: ' …', color: 'yellow' })
      lines.push({ key: `${m.key}:${i}`, segs })
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
  return texts.flatMap((text, i) => wrap(text, width).map((row, j): Line => ({ key: `p${i}:${j}`, segs: [{ text: row }] })))
}
