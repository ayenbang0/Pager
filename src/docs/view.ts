/** Pure layout helpers for the document editor: soft wrapping, cursor <-> screen mapping, Markdown line styles. */

export interface Row {
  /** Offsets into the text; `text.slice(start, end)` is what the row shows (a trailing space stays on the row it ends). */
  start: number
  end: number
  /** 0-based logical line. */
  line: number
  /** First visual row of its logical line (the only one that gets a line number). */
  first: boolean
  /** Last visual row of its logical line: the cursor may sit at `end` (on the newline) only here. */
  last: boolean
}

/** Wrap every logical line at `width` columns, preferring to break after a space. */
export function wrapRows(text: string, width: number): Row[] {
  const w = Math.max(4, width)
  const rows: Row[] = []
  let offset = 0
  for (const [line, content] of text.split('\n').entries()) {
    let pos = 0
    let first = true
    do {
      let end = content.length
      if (content.length - pos > w) {
        const space = content.lastIndexOf(' ', pos + w - 1)
        end = space > pos ? space + 1 : pos + w
      }
      rows.push({ start: offset + pos, end: offset + end, line, first, last: end >= content.length })
      pos = end
      first = false
    } while (pos < content.length)
    offset += content.length + 1
  }
  return rows
}

/** The visual row holding text index `index` (the newline position counts as the end of its line's last row). */
export function rowOf(rows: readonly Row[], index: number): number {
  let lo = 0
  let hi = rows.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((rows[mid]?.start ?? 0) <= index) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Text index for a click at visual row `row`, column `col` (0-based, within the row's text), clamped onto the row. */
export function indexAtRow(rows: readonly Row[], row: number, col: number): number {
  const r = rows[Math.min(rows.length - 1, Math.max(0, row))]
  if (!r) return 0
  const max = r.last ? r.end : Math.max(r.start, r.end - 1)
  return Math.min(max, r.start + Math.max(0, col))
}

export type LineKind = 'text' | 'heading' | 'code' | 'quote' | 'rule'

/** Markdown style of every logical line, tracking fenced code blocks. */
export function lineKinds(text: string): LineKind[] {
  let fenced = false
  return text.split('\n').map((l): LineKind => {
    if (/^\s*(```|~~~)/.test(l)) {
      fenced = !fenced
      return 'code'
    }
    if (fenced) return 'code'
    if (/^#{1,6}\s/.test(l)) return 'heading'
    if (/^\s*>/.test(l)) return 'quote'
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return 'rule'
    return 'text'
  })
}

export interface Piece {
  text: string
  /** Part of the visual selection. */
  selected: boolean
  cursor: boolean
}

/** Split one row into runs so the UI can invert the selection and the cursor cell. Offsets are absolute text indexes. */
export function rowPieces(text: string, row: Row, cursor: number, sel: { start: number; end: number } | null): Piece[] {
  const out: Piece[] = []
  const content = text.slice(row.start, row.end)
  const cursorHere = cursor >= row.start && (cursor < row.end || (row.last && cursor === row.end))
  let run = ''
  let runSel = false
  const flush = (): void => {
    if (run !== '') out.push({ text: run, selected: runSel, cursor: false })
    run = ''
  }
  for (let i = 0; i < content.length; i++) {
    const abs = row.start + i
    const selected = sel !== null && abs >= sel.start && abs < sel.end
    if (cursorHere && abs === cursor) {
      flush()
      out.push({ text: content[i] ?? ' ', selected, cursor: true })
      continue
    }
    if (run !== '' && selected !== runSel) flush()
    runSel = selected
    run += content[i]
  }
  flush()
  if (cursorHere && cursor === row.end) out.push({ text: ' ', selected: false, cursor: true })
  return out
}

/** Where `next` first differs from `prev`: the edit start, and how the length changed up to the common tail. */
export function diffText(prev: string, next: string): { pos: number; removed: number; added: number } {
  let head = 0
  while (head < prev.length && head < next.length && prev[head] === next[head]) head++
  let tail = 0
  while (tail < prev.length - head && tail < next.length - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++
  return { pos: head, removed: prev.length - head - tail, added: next.length - head - tail }
}

/** Move an index across an external edit so it keeps pointing at the same character. */
export function shiftIndex(index: number, change: { pos: number; removed: number; added: number }): number {
  if (index <= change.pos) return index
  if (index >= change.pos + change.removed) return index + change.added - change.removed
  return change.pos
}
