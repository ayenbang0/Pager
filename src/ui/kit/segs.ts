import stringWidth from 'string-width'
import { gradientAt } from '../theme/colors.js'
import type { Pill, Theme } from '../theme/themes.js'

/** A run of text with one style. Rows of segs are the unit every styled surface (messages, bands, pills, rules) is built from. */
export interface Seg {
  text: string
  color?: string
  /** Fill color behind the text (bands, pills, system notes). */
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  /** Terminal cells only. */
  underline?: boolean
  strike?: boolean
  /** Set by the mouse selection highlight, never by layout. */
  inverse?: boolean
  /** Decoration (gutter bars, author headers, role glyphs): drawn and selectable, but left out of copied text. */
  chrome?: boolean
}

export type SegStyle = Omit<Seg, 'text'>

export const segsWidth = (segs: readonly Seg[]): number => segs.reduce((sum, s) => sum + stringWidth(s.text), 0)

/** The first `width` display columns of `segs`; a wide glyph that would straddle the edge is dropped. */
export function clipSegs(segs: readonly Seg[], width: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const seg of segs) {
    const w = stringWidth(seg.text)
    if (used + w <= width) {
      out.push(seg)
      used += w
      continue
    }
    let text = ''
    for (const ch of seg.text) {
      const cw = stringWidth(ch)
      if (used + cw > width) break
      text += ch
      used += cw
    }
    if (text !== '') out.push({ ...seg, text })
    break
  }
  return out
}

/** `segs` clipped or padded with `fill`-styled spaces to exactly `width` columns. */
export function fitSegs(segs: readonly Seg[], width: number, fill: SegStyle = {}): Seg[] {
  const clipped = clipSegs(segs, width)
  const gap = width - segsWidth(clipped)
  return gap > 0 ? [...clipped, { ...fill, text: ' '.repeat(gap) }] : clipped
}

/** `left` and `right` on one row of `width` columns, the gap between them filled. The right side wins when both cannot fit; `left` is clipped. */
export function spread(left: readonly Seg[], right: readonly Seg[], width: number, fill: SegStyle = {}): Seg[] {
  const rightFit = clipSegs(right, width)
  const room = width - segsWidth(rightFit)
  return [...fitSegs(left, room, fill), ...rightFit]
}

/** ` text ` as a filled badge. `bold` defaults on. */
export const pillSeg = (text: string, p: Pill, bold = true): Seg => ({ text: ` ${text} `, color: p.fg, bg: p.bg, bold })

/** `‹Ctrl+G›`: a key as a keycap, the bracket dim and the key bright. */
export function keycap(key: string, theme: Theme, bg?: string): Seg[] {
  const edge: SegStyle = bg === undefined ? { color: theme.dim } : { color: theme.dim, bg }
  const face: SegStyle = bg === undefined ? { color: theme.glow, bold: true } : { color: theme.glow, bold: true, bg }
  return [{ ...edge, text: '‹' }, { ...face, text: key }, { ...edge, text: '›' }]
}

/** Gradient-colored text, one color per character (or per `chunk` characters for long runs). */
export function gradientText(text: string, stops: readonly string[], style: SegStyle = {}, chunk = 1): Seg[] {
  const chars = [...text]
  const out: Seg[] = []
  const span = Math.max(1, chars.length - 1)
  for (let i = 0; i < chars.length; i += chunk) {
    out.push({ ...style, text: chars.slice(i, i + chunk).join(''), color: gradientAt(stops, i / span) })
  }
  return out
}

/** A horizontal rule `width` columns wide fading across `stops`. Colors change every few cells to keep the node count down. */
export function gradientRule(width: number, stops: readonly string[], glyph = '━', style: SegStyle = {}): Seg[] {
  return width <= 0 ? [] : gradientText(glyph.repeat(width), stops, style, 4)
}

/** `▌ TITLE `: a banded section label. The half block nubs onto the filled pill. */
export const bandLabel = (title: string, theme: Theme): Seg[] => [{ text: '▌', color: theme.band.bg, bold: true }, pillSeg(title, theme.band)]

/** The row `segs` as the active row: a bright `▎` marker then every seg recolored onto an accent bar, padded to `width`. */
export function selectedBar(segs: readonly Seg[], width: number, theme: Theme): Seg[] {
  const { fg, bg } = theme.band
  const bar = (s: Seg): Seg => ({ ...s, color: fg, bg, bold: true, dim: false, italic: false })
  return fitSegs([{ text: '▎', color: theme.glow, bg, bold: true }, ...segs.map(bar)], width, { bg })
}

/** Adjacent segs with identical styling joined into one, so a gradient rule costs a handful of nodes instead of one per cell. */
export function mergeSegs(segs: readonly Seg[]): Seg[] {
  const out: Seg[] = []
  for (const seg of segs) {
    const last = out.at(-1)
    if (last !== undefined && last.color === seg.color && last.bg === seg.bg && last.bold === seg.bold && last.dim === seg.dim && last.italic === seg.italic && last.underline === seg.underline && last.strike === seg.strike && last.inverse === seg.inverse && last.chrome === seg.chrome) {
      out[out.length - 1] = { ...last, text: last.text + seg.text }
    } else out.push(seg)
  }
  return out
}
