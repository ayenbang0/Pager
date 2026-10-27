import { mergeSegs, clipSegs, fitSegs, segsWidth, type Seg } from './segs.js'
import type { PillKind, Theme } from '../theme/themes.js'

/**
 * Pure builders for the pager look shared with the desktop shell and Tern: one smooth style, quiet hairlines, rounded
 * 1-cell corners, a soft raised fill for the selected thing, and the accent only for focus, selection and unread.
 * Everything returns segs of an exact width, so the Ink components stay thin.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** Time since `ts` in a few columns: `now`, `5m`, `3h`, `2d`, `3w`, `4mo`, `1y`. Times in the future read as `now`. */
export function relativeTime(ts: number, now: number): string {
  const age = now - ts
  if (!Number.isFinite(age) || age < 45_000) return 'now'
  if (age < HOUR_MS) return `${Math.max(1, Math.floor(age / MINUTE_MS))}m`
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h`
  const days = Math.floor(age / DAY_MS)
  if (days < 7) return `${days}d`
  if (days < 35) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

/** The soft raised fill: the selected row, the active tab, a chip. */
export const raisedFill = (theme: Theme): string => theme.pill.muted.bg

/** The rounded card's edge: a quiet hairline, the accent while the card has focus. */
export const edgeColor = (theme: Theme, focused = false): string => (focused ? theme.accent : theme.border)

/** A horizontal hairline `width` columns wide in the quiet border color. */
export const hairline = (width: number, theme: Theme, glyph = '─'): Seg[] => (width <= 0 ? [] : [{ text: glyph.repeat(width), color: theme.border }])

/** A status dot (`●`, or a ring `○` when `ring`) in `color`. */
export const dot = (color: string, ring = false): Seg => ({ text: ring ? '○' : '●', color, bold: !ring })

/** ` text ` on the soft raised fill, or on a toned pill when `tone` is given. */
export function chip(text: string, theme: Theme, tone?: PillKind, bold = false): Seg {
  const p = tone === undefined ? theme.pill.muted : theme.pill[tone]
  return { text: ` ${text} `, color: tone === undefined ? theme.text : p.fg, bg: p.bg, bold }
}

/** The tab strip of the top bar: the active tab on the raised fill and bold, the others dim; one space between tabs. */
export function tabPills(labels: readonly string[], active: number, theme: Theme): Seg[] {
  return labels.flatMap((label, i): Seg[] => {
    const lead: Seg[] = i === 0 ? [] : [{ text: ' ' }]
    return [...lead, i === active ? { text: ` ${label} `, color: theme.text, bg: raisedFill(theme), bold: true } : { text: ` ${label} `, color: theme.dim }]
  })
}

interface EdgeOptions {
  /** Shown after the corner, e.g. a title or a recipient chip. */
  left?: readonly Seg[]
  /** Shown before the closing corner. Dropped first when the edge is too narrow. */
  right?: readonly Seg[]
  /** Draw the edge in the accent. */
  focused?: boolean
}

/** One horizontal card edge, exactly `width` columns: corner, optional `left` and `right` inserts on the hairline, corner. */
function edge(corners: readonly [string, string], width: number, theme: Theme, o: EdgeOptions): Seg[] {
  const style = { color: edgeColor(theme, o.focused === true) }
  if (width < 2) return clipSegs([{ ...style, text: corners.join('') }], Math.max(0, width))
  const inner = width - 2
  let lead: Seg[] = o.left === undefined || o.left.length === 0 ? [] : [{ ...style, text: '─ ' }, ...o.left, { ...style, text: ' ' }]
  let tail: Seg[] = o.right === undefined || o.right.length === 0 ? [] : [{ ...style, text: ' ' }, ...o.right, { ...style, text: ' ─' }]
  if (segsWidth(lead) + segsWidth(tail) > inner) tail = []
  if (segsWidth(lead) > inner) lead = clipSegs(lead, inner)
  const fill = Math.max(0, inner - segsWidth(lead) - segsWidth(tail))
  return mergeSegs([{ ...style, text: corners[0] }, ...lead, { ...style, text: '─'.repeat(fill) }, ...tail, { ...style, text: corners[1] }])
}

/** `╭─ left ───── right ─╮`, exactly `width` columns. */
export const cardTop = (width: number, theme: Theme, o: EdgeOptions = {}): Seg[] => edge(['╭', '╮'], width, theme, o)

/** `╰─ left ───── right ─╯`, exactly `width` columns. */
export const cardBottom = (width: number, theme: Theme, o: EdgeOptions = {}): Seg[] => edge(['╰', '╯'], width, theme, o)

/** `│ content │`, exactly `width` columns: the content is clipped or padded to the room between the sides. */
export function cardRow(content: readonly Seg[], width: number, theme: Theme, focused = false): Seg[] {
  const side: Seg = { text: '│', color: edgeColor(theme, focused) }
  if (width < 4) return fitSegs([side], Math.max(0, width))
  return [side, { text: ' ' }, ...fitSegs(content, width - 4), { text: ' ' }, side]
}

/** A row with `left` text, a hairline across the gap and `right` text at the end, exactly `width` columns; `right` drops first when it does not fit. */
export function ruleRow(left: readonly Seg[], right: readonly Seg[], width: number, theme: Theme): Seg[] {
  let tail: Seg[] = right.length === 0 ? [] : [{ text: ' ' }, ...right, { text: ' ' }]
  let head = [...left]
  if (segsWidth(head) + segsWidth(tail) + 2 > width) tail = []
  if (segsWidth(head) > width) head = clipSegs(head, width)
  const gap = width - segsWidth(head) - segsWidth(tail)
  const rule = gap <= 0 ? [] : gap === 1 ? [{ text: ' ' }] : [{ text: ' ' }, ...hairline(gap - 1, theme)]
  return mergeSegs([...head, ...rule, ...tail])
}

/**
 * A heading row: the title on a raised chip (with an optional leading glyph such as a presence dot), a hairline across the gap, and a dim note
 * at the end when it fits. Used by the thread title and the overlay headings.
 */
export function titleRow(title: string, note: string | undefined, width: number, theme: Theme, lead?: Seg): Seg[] {
  const fill = { bg: raisedFill(theme) }
  const glyph: Seg[] = lead === undefined ? [] : [{ ...lead, ...fill }, { ...fill, text: ' ' }]
  const head: Seg[] = [{ ...fill, text: ' ' }, ...glyph, { ...fill, text: title, color: theme.text, bold: true }, { ...fill, text: ' ' }]
  return ruleRow(head, note === undefined || note === '' ? [] : [{ text: note, color: theme.dim }], width, theme)
}
