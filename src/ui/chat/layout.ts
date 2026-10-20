import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import type { MessageView } from '../../app/engine.js'
import { DEFAULT_THEME, type Theme } from '../theme/themes.js'
import { agentTint, colorFor, DEFAULT_LOOK, spacingFor, type Look } from '../theme/look.js'
import { QUICK_REACTIONS } from '../../chat/reactions.js'
import { fitSegs, pillSeg, type Seg } from '../kit/segs.js'

export type { Seg } from '../kit/segs.js'
export { colorFor } from '../theme/look.js'

export interface Line {
  key: string
  segs: Seg[]
  /** Set on a fold marker row: the message key a click expands. */
  fold?: string
  /** Set on the header and body rows of a message a click can react to: its message key. */
  msg?: string
  /** Set on the emoji picker row: where its first cell starts and what each 4-column cell holds. */
  pick?: { col: number; items: readonly string[] }
}

/** Width of one cell of the emoji picker row: a space, the glyph (1 or 2 columns) and padding. */
export const PICK_CELL = 4

const MAX_AUTHOR_COLUMNS = 20
const MIN_BODY_COLUMNS = 10
/** The left gutter bar of every message block, in the author's color. */
const GUTTER = '▍'
/** A run of one speaker's messages shows their header again after this long a pause. */
const RUN_GAP_MS = 5 * 60_000

export const FOLD_ABOVE_ROWS = 30
export const FOLD_HEAD_ROWS = 12
export const FOLD_TAIL_ROWS = 6

export interface FoldState {
  enabled: boolean
  expanded: ReadonlySet<string>
}

const DEFAULT_FOLDS: FoldState = { enabled: true, expanded: new Set() }

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
/** The note an agent turn posts when it used tools: `omp-ab12 used 3 tools (read 2, edit 1)`. */
const TOOL_NOTE = /^(\S+) used \d+ tools? \((.+)\)$/

/** Splits a row into plain, `code` and **bold** segments over `base` styling. */
function inline(row: string, base: Omit<Seg, 'text'>, theme: Theme): Seg[] {
  const out: Seg[] = []
  for (const part of row.split(INLINE)) {
    if (part === '') continue
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) out.push({ ...base, text: part.slice(1, -1), color: theme.info, bg: theme.surface })
    else if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) out.push({ ...base, text: part.slice(2, -2), bold: true })
    else out.push({ ...base, text: part })
  }
  return out.length === 0 ? [{ ...base, text: '' }] : out
}

/** One row of a code block: a colored bar, then the code on a filled band `columns` wide. */
function codeRow(text: string, columns: number, theme: Theme, style: Omit<Seg, 'text'>): Seg[] {
  const fill = { bg: theme.surface }
  return [{ text: '▎', color: theme.accent2, bg: theme.surface, chrome: true }, ...fitSegs([{ ...style, ...fill, text: ` ${text}` }], columns - 1, fill)]
}

/** Markdown source lines are styled before wrapping so fences and bullets keep their shape. */
function markdownRows(text: string, columns: number, theme: Theme): Seg[][] {
  const rows: Seg[][] = []
  let inCode = false
  for (const line of text.split('\n')) {
    const fence = FENCE.exec(line)
    if (fence) {
      inCode = !inCode
      if (inCode) rows.push(codeRow(fence[2] || 'code', columns, theme, { color: theme.dim, bold: true }))
      continue
    }
    if (inCode) {
      for (const row of wrap(line, columns - 2)) rows.push(codeRow(row, columns, theme, { color: theme.info }))
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      for (const row of wrap(heading[1] ?? '', columns - 2)) rows.push([{ text: '▌ ', color: theme.accent2, chrome: true }, { text: row, bold: true, color: theme.accent }])
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      const indent = bullet[1] ?? ''
      wrap(bullet[2] ?? '', columns - indent.length - 2).forEach((row, i) => {
        rows.push([{ text: i === 0 ? `${indent}• ` : ' '.repeat(indent.length + 2), color: theme.accent }, ...inline(row, {}, theme)])
      })
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote) {
      for (const row of wrap(quote[1] ?? '', columns - 2)) rows.push([{ text: '▏ ', color: theme.border, chrome: true }, ...inline(row, { dim: true, italic: true }, theme)])
      continue
    }
    for (const row of wrap(line, columns)) rows.push(inline(row, {}, theme))
  }
  return rows
}

/** The glyph that says what kind of speaker wrote a message. */
function roleGlyph(m: MessageView, look: Look): string {
  if (m.mine) return look.badge === '' ? '●' : look.badge
  if (m.agent === true) return '◆'
  return m.authorName === 'pager' ? '⚙' : '●'
}

/** A system line as a dim note on the surface band, `width` columns wide. Tool summaries show each tool as a small pill. */
function noteRows(m: MessageView, width: number, theme: Theme): Seg[][] {
  const fill = { bg: theme.surface }
  const tools = TOOL_NOTE.exec(m.text)
  if (tools !== null) {
    const pills = (tools[2] ?? '').split(', ').flatMap((part): Seg[] => [pillSeg(part, theme.pill.muted, false), { ...fill, text: ' ' }])
    return [fitSegs([{ ...fill, text: ' ⚙ ', color: theme.accent2, chrome: true }, { ...fill, text: `${tools[1]} `, color: theme.dim, italic: true }, ...pills], width, fill)]
  }
  return wrap(m.text, width - 3).map((text, i) =>
    fitSegs([{ ...fill, text: i === 0 ? ' ⚙ ' : '   ', color: theme.accent2, chrome: true }, { ...fill, text, color: theme.dim, italic: true }], width, fill),
  )
}

export function buildLines(
  messages: MessageView[],
  width: number,
  theme: Theme = DEFAULT_THEME,
  now: Date = new Date(),
  folds: FoldState = DEFAULT_FOLDS,
  look: Look = DEFAULT_LOOK,
  /** The message whose emoji picker is open and the cell it highlights. */
  pick: { key: string; at: number } | null = null,
): Line[] {
  const spacing = spacingFor(look.density)
  const lines: Line[] = []
  let prevAuthor: string | null = null
  let prevTs = 0
  for (const m of messages) {
    if (m.kind === 'system') {
      noteRows(m, width, theme).forEach((segs, i) => lines.push({ key: `${m.key}:${i}`, segs }))
      prevAuthor = null
      continue
    }
    const prefix = stamp(m.ts, now)
    const author = truncate(m.authorName, MAX_AUTHOR_COLUMNS)
    // A run of messages from one person names them once; the body column stays aligned.
    // Name as well as key: agent runs share a key (omp-1 / omp-2) and "you" / "pager" share the zero key.
    const who = `${m.authorKey}\0${m.authorName}`
    const sameAsPrev = prevAuthor === who && m.ts - prevTs < RUN_GAP_MS
    if (!sameAsPrev && prevAuthor !== null) {
      for (let g = 0; g < spacing.gapBetweenSpeakers; g++) lines.push({ key: `${m.key}:gap${g}`, segs: [{ text: ' ' }] })
    }
    prevAuthor = who
    prevTs = m.ts
    const tint = m.mine ? theme.userBubble : m.agent === true ? agentTint(theme, look, m.authorName) : colorFor(theme, m.authorKey)
    const nameColor = m.mine ? theme.mine : tint
    const glyph = roleGlyph(m, look)
    const gutter: Seg = { text: GUTTER, color: tint, chrome: true }
    // Stacked: the speaker gets a header row and the body sits under the gutter. Compact: `▍ 09:05 ● bob  body` on one row.
    const bodyCol = spacing.stacked ? 2 : 1 + 1 + stringWidth(prefix) + 1 + stringWidth(glyph) + 1 + stringWidth(author) + 2
    const suffix = m.status === null ? 0 : 4
    const columns = Math.max(MIN_BODY_COLUMNS, width - bodyCol - suffix)
    let rows: Seg[][] = m.markdown ? markdownRows(m.text, columns, theme) : wrap(m.text, columns).map((row) => [{ text: row }])
    let foldAt = -1
    if (folds.enabled && !folds.expanded.has(m.key) && rows.length > FOLD_ABOVE_ROWS) {
      const hidden = rows.length - FOLD_HEAD_ROWS - FOLD_TAIL_ROWS
      foldAt = FOLD_HEAD_ROWS
      rows = [
        ...rows.slice(0, FOLD_HEAD_ROWS),
        [pillSeg(`▸ ${hidden} more lines`, theme.pill.muted, false), { text: ' click or Ctrl+T to expand', color: theme.dim }],
        ...rows.slice(rows.length - FOLD_TAIL_ROWS),
      ]
    }
    if (spacing.stacked && !sameAsPrev) {
      lines.push({
        key: `${m.key}:head`,
        ...(m.reactable === true ? { msg: m.key } : {}),
        segs: [
          gutter,
          { text: ' ', chrome: true },
          { text: glyph, color: nameColor, bold: true, chrome: true },
          { text: ' ', chrome: true },
          { text: author, bold: true, color: nameColor, chrome: true },
          { text: `  ${prefix}`, color: theme.dim, chrome: true },
        ],
      })
    }
    rows.forEach((row, i) => {
      let lead: Seg[]
      if (spacing.stacked) lead = [gutter, { text: ' ', chrome: true }]
      else if (i === 0) {
        lead = [
          gutter,
          { text: ' ', chrome: true },
          sameAsPrev ? { text: ' '.repeat(stringWidth(prefix)), chrome: true } : { text: prefix, color: theme.dim, chrome: true },
          { text: ' ', chrome: true },
          sameAsPrev ? { text: ' '.repeat(stringWidth(glyph)), chrome: true } : { text: glyph, color: nameColor, bold: true, chrome: true },
          { text: ' ', chrome: true },
          sameAsPrev ? { text: ' '.repeat(stringWidth(author)), chrome: true } : { text: author, bold: true, color: nameColor, chrome: true },
          { text: '  ', chrome: true },
        ]
      } else lead = [gutter, { text: ' '.repeat(bodyCol - 1), chrome: true }]
      const segs: Seg[] = [...lead, ...row]
      if (i === rows.length - 1 && m.status === 'sent') segs.push({ text: ' ✓', color: theme.dim })
      if (i === rows.length - 1 && m.status === 'delivered') segs.push({ text: ' ✓✓', color: theme.success })
      if (i === rows.length - 1 && m.status === 'read') segs.push({ text: ' ✓✓✓', color: theme.accent, bold: true })
      if (i === rows.length - 1 && m.status === 'pending') segs.push({ text: ' …', color: theme.warning })
      const line: Line = i === foldAt ? { key: `${m.key}:${i}`, segs, fold: m.key } : { key: `${m.key}:${i}`, segs }
      lines.push(m.reactable === true ? { ...line, msg: m.key } : line)
    })
    const lead: Seg[] = spacing.stacked ? [gutter, { text: ' ', chrome: true }] : [gutter, { text: ' '.repeat(bodyCol - 1), chrome: true }]
    if (m.reactions !== undefined && m.reactions.length > 0) {
      const pills = m.reactions.flatMap((r, n): Seg[] => [...(n === 0 ? [] : [{ text: '  ' }]), pillSeg(`${r.emoji} ${r.count}`, r.mine ? theme.pill.accent : theme.pill.muted, false)])
      lines.push({ key: `${m.key}:react`, segs: [...lead, ...pills] })
    }
    if (pick !== null && pick.key === m.key) {
      const items = [...QUICK_REACTIONS, '…']
      const cells = items.flatMap((item, n): Seg[] => {
        const selected = n === pick.at
        const cell = fitSegs([{ text: ` ${item}`, ...(selected ? { color: theme.band.fg, bg: theme.band.bg, bold: true } : {}) }], PICK_CELL, selected ? { bg: theme.band.bg } : {})
        return cell
      })
      lines.push({ key: `${m.key}:pick`, segs: [...lead, ...cells], pick: { col: stringWidth(lead.map((s) => s.text).join('')), items } })
    }
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
