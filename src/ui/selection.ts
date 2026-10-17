import stringWidth from 'string-width'
import type { Line, Seg } from './layout.js'

/** A text cell in pane coordinates: `row` indexes the visible lines, `col` is a 0-based display column of the line's text. */
export interface Cell {
  row: number
  col: number
}
/** A mouse drag, anchor first. Both ends are inclusive and either may come first. */
export interface Sel {
  anchor: Cell
  head: Cell
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Inclusive display-column range selected on `row`, or null when the row is outside the selection. The end is Infinity for every row but the last. */
function rowRange(row: number, sel: Sel): [from: number, to: number] | null {
  const backwards = sel.anchor.row > sel.head.row || (sel.anchor.row === sel.head.row && sel.anchor.col > sel.head.col)
  const first = backwards ? sel.head : sel.anchor
  const last = backwards ? sel.anchor : sel.head
  if (row < first.row || row > last.row) return null
  return [row === first.row ? first.col : 0, row === last.row ? last.col : Number.POSITIVE_INFINITY]
}

/** Text a drag copies: the first row from its column, the last up to its column, rows between whole; trailing spaces trimmed per row. */
export function selectedText(lines: Line[], sel: Sel): string {
  const out: string[] = []
  const lastRow = Math.min(Math.max(sel.anchor.row, sel.head.row), lines.length - 1)
  for (let row = Math.max(0, Math.min(sel.anchor.row, sel.head.row)); row <= lastRow; row++) {
    const range = rowRange(row, sel)
    const segs = lines[row]?.segs ?? []
    // A row that is all decoration (an author header) contributes nothing, not an empty line.
    if (range === null || (segs.length > 0 && segs.every((s) => s.chrome === true))) continue
    let col = 0
    let picked = ''
    for (const seg of segs) {
      for (const { segment } of graphemes.segment(seg.text)) {
        const width = stringWidth(segment)
        if (seg.chrome !== true && col + width > range[0] && col <= range[1]) picked += segment
        col += width
      }
    }
    out.push(picked.trimEnd())
  }
  const text = out.join('\n')
  return text.trim() === '' ? '' : text
}

/** `segs` of the line at `row` with the selected cells marked `inverse`; the same array when the row is not selected. */
export function withSelection(segs: Seg[], row: number, sel: Sel | null): Seg[] {
  const range = sel === null ? null : rowRange(row, sel)
  if (range === null) return segs
  const out: Seg[] = []
  let col = 0
  for (const seg of segs) {
    let run = ''
    let runOn = false
    for (const { segment } of graphemes.segment(seg.text)) {
      const width = stringWidth(segment)
      const on = col + width > range[0] && col <= range[1]
      if (run !== '' && on !== runOn) {
        out.push(runOn ? { ...seg, text: run, inverse: true } : { ...seg, text: run })
        run = ''
      }
      run += segment
      runOn = on
      col += width
    }
    if (run !== '') out.push(runOn ? { ...seg, text: run, inverse: true } : { ...seg, text: run })
  }
  return out
}
