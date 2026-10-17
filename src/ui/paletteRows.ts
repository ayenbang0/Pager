import type { Theme } from '../themes.js'
import { keycap, pillSeg, selectedBar, spread, type Seg } from './segs.js'

/**
 * UTF-16 indexes of the characters of `label` that `query` matched, the way `fuzzyFilter` ranks it: a contiguous
 * substring first, else the first letters found in order. Empty for an empty query or no match.
 */
export function matchIndexes(label: string, rawQuery: string): number[] {
  const query = rawQuery.trim().toLowerCase()
  const hay = label.toLowerCase()
  if (query === '' || hay.length !== label.length) return []
  const at = hay.indexOf(query)
  if (at !== -1) return Array.from({ length: query.length }, (_, i) => at + i)
  const found: number[] = []
  let from = 0
  for (const ch of query) {
    const next = hay.indexOf(ch, from)
    if (next === -1) return []
    for (let i = 0; i < ch.length; i++) found.push(next + i)
    from = next + ch.length
  }
  return found
}

/** `label` as bold text with the matched letters in the glow color, runs of equal styling joined. */
export function labelSegs(label: string, query: string, theme: Theme): Seg[] {
  const hits = new Set(matchIndexes(label, query))
  const out: Seg[] = []
  let at = 0
  for (const ch of label) {
    const hit = hits.has(at)
    const last = out.at(-1)
    const color = hit ? theme.glow : theme.text
    if (last?.color === color) last.text += ch
    else out.push({ text: ch, color, bold: true })
    at += ch.length
  }
  return out
}

/** One palette row of exactly `width` columns: bold label with its matched letters lit, the hint as a keycap at the end. The selected row is the accent bar. */
export function paletteRow(item: { label: string; hint?: string }, query: string, selected: boolean, width: number, theme: Theme): Seg[] {
  const body = width - 1
  const right: Seg[] = item.hint === undefined || item.hint === '' ? [] : keycap(item.hint, theme)
  const left = labelSegs(item.label, selected ? '' : query, theme)
  const row = spread(left, right.length === 0 ? right : [{ text: ' ' }, ...right], body)
  return selected ? selectedBar(row, width, theme) : [{ text: ' ' }, ...row]
}

/** The query row's right end: how many entries match, as a muted pill. */
export const matchCount = (shown: number, total: number, theme: Theme): Seg[] => [pillSeg(shown === total ? `${total}` : `${shown}/${total}`, theme.pill.muted)]

/** The list body when nothing matches. */
export function noMatchSegs(theme: Theme): Seg[] {
  return [{ text: ' ' }, pillSeg('no matches', theme.pill.warning), { text: ' try fewer letters', color: theme.dim }]
}
