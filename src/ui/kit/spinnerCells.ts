import type { Seg } from './segs.js'

/** A one-column placeholder (braille blank) that `SpinnerLine` replaces with a live spinner, so pure layout code can reserve its cell. */
export const SPINNER_CELL = '\u2800'

/** The placeholder, styled like the text around it (`color` is the spinner's color, `bg` the fill under it). */
export const spinnerCell = (style: Omit<Seg, 'text'> = {}): Seg => ({ ...style, text: SPINNER_CELL })

export type LinePart = { kind: 'segs'; segs: Seg[] } | { kind: 'spinner'; seg: Seg }

/** `segs` cut into runs of plain segs and spinner cells, in order. */
export function splitSpinners(segs: readonly Seg[]): LinePart[] {
  const parts: LinePart[] = []
  let run: Seg[] = []
  for (const seg of segs) {
    if (seg.text === SPINNER_CELL) {
      if (run.length > 0) parts.push({ kind: 'segs', segs: run })
      run = []
      parts.push({ kind: 'spinner', seg })
    } else run.push(seg)
  }
  if (run.length > 0) parts.push({ kind: 'segs', segs: run })
  return parts
}
