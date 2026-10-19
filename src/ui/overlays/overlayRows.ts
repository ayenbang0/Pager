import stringWidth from 'string-width'
import type { Theme } from '../theme/themes.js'
import { clipSegs, fitSegs, keycap, pillSeg, segsWidth, spread, type Seg } from '../kit/segs.js'

/** Rows an overlay card spends on its border (2) and its title band (1). */
export const CARD_CHROME_ROWS = 3

/** Which slice of a long list is on screen, centred on the cursor, and how much hides on each side. */
export interface ListWindow {
  start: number
  end: number
  above: number
  below: number
}

export function listWindow(total: number, cursor: number, rows: number): ListWindow {
  const size = Math.max(1, rows)
  const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), total - size))
  const end = Math.min(total, start + size)
  return { start, end, above: start, below: total - end }
}

/** `▲ 3 more ▼ 5 more` as muted pills; empty when the whole list shows. */
export function moreSegs(above: number, below: number, theme: Theme): Seg[] {
  const up = above > 0 ? [pillSeg(`▲ ${above} more`, theme.pill.muted)] : []
  const down = below > 0 ? [pillSeg(`▼ ${below} more`, theme.pill.muted)] : []
  return up.length > 0 && down.length > 0 ? [...up, { text: ' ' }, ...down] : [...up, ...down]
}

export type KeyHint = readonly [key: string, label: string]

/** `‹↑↓› move  ‹Enter› run`: keycaps with their plain-language action. */
export function hintSegs(hints: readonly KeyHint[], theme: Theme): Seg[] {
  return hints.flatMap(([key, label], i): Seg[] => [...(i === 0 ? [] : [{ text: '  ' }]), ...keycap(key, theme), { text: ` ${label}`, color: theme.dim }])
}

/**
 * The footer row: key hints on the left and `right` (counts, scroll pills) at the end. Hints are dropped from the end
 * until both fit, so the right side is never cut and a narrow pane keeps at least the first hint.
 */
export function footerSegs(hints: readonly KeyHint[], right: readonly Seg[], width: number, theme: Theme): Seg[] {
  const gap = right.length === 0 ? 0 : 1
  let left = hintSegs(hints, theme)
  for (let n = hints.length; n >= 1; n--) {
    left = hintSegs(hints.slice(0, n), theme)
    if (segsWidth(left) + gap + segsWidth(right) <= width) break
  }
  return fitSegs(spread(left, right, width), width)
}

/** The last `max` display columns of `text`, so a long line keeps the end the cursor sits at. */
export function tailWidth(text: string, max: number): string {
  if (max <= 0) return ''
  const chars = [...text]
  let used = 0
  let from = chars.length
  while (from > 0) {
    const w = stringWidth(chars[from - 1] ?? '')
    if (used + w > max) break
    used += w
    from--
  }
  return chars.slice(from).join('')
}

/** A text buffer cut at the cursor: what comes before, the character under it ('' at the end) and what follows. */
export interface FieldText {
  before: string
  at: string
  after: string
}

/**
 * A text field row of exactly `width` columns on the surface color: `prefix`, the text, an accent underline cursor
 * (`▁` at the end, an inverse cell over a character) and a dim `placeholder` while empty. Long text keeps its tail visible.
 */
export function fieldSegs(prefix: readonly Seg[], text: FieldText, placeholder: string, focused: boolean, width: number, theme: Theme): Seg[] {
  const bg = theme.surface
  const room = Math.max(1, width - segsWidth(prefix) - 1)
  const empty = text.before === '' && text.at === '' && text.after === ''
  const before = tailWidth(text.before, room)
  const body: Seg[] = [{ text: before, color: theme.text, bg }]
  if (focused) body.push(text.at === '' ? { text: '▁', color: theme.accent, bg, bold: true } : { text: text.at, color: theme.text, bg, inverse: true })
  body.push({ text: text.after, color: theme.text, bg })
  if (empty) body.push({ text: placeholder, color: theme.dim, bg })
  return fitSegs([...prefix, ...clipSegs(body, width - segsWidth(prefix))], width, { bg })
}

/** `text` broken into lines of at most `width` columns at spaces; a word longer than a line is cut. */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const next = line === '' ? word : `${line} ${word}`
    if (stringWidth(next) <= width) {
      line = next
      continue
    }
    if (line !== '') lines.push(line)
    line = ''
    let rest = word
    while (stringWidth(rest) > width) {
      const head = [...rest].reduce((acc, ch) => (stringWidth(acc + ch) <= width ? acc + ch : acc), '')
      if (head === '') break
      lines.push(head)
      rest = rest.slice(head.length)
    }
    line = rest
  }
  if (line !== '') lines.push(line)
  return lines
}
