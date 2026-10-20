import type { Seg } from '../kit/segs.js'
import type { Theme } from '../theme/themes.js'

export interface BlockSpan {
  id: number
  first: number
  last: number
  exit: number | null
  running: boolean
}

/** The block after/before `current` among `ids` (oldest first); no current selects the newest. Clamped at both ends. */
export function moveSelection(ids: readonly number[], current: number | null, delta: -1 | 1): number {
  const last = ids.length - 1
  if (last < 0) return -1
  const at = current === null ? -1 : ids.indexOf(current)
  if (at < 0) return ids[last] ?? -1
  return ids[Math.max(0, Math.min(last, at + delta))] ?? -1
}

/** The two-column gutter cell for one buffer row: a colored bar on the rows of a block (running, ok, failed), a full block when selected. */
export function gutterFor(row: number, spans: readonly BlockSpan[], selected: number | null, theme: Theme): Seg {
  const span = spans.find((s) => row >= s.first && row <= s.last)
  if (span === undefined) return { text: '  ', chrome: true }
  const color = span.running ? theme.accent : span.exit === 0 ? theme.success : theme.error
  return { text: span.id === selected ? '█ ' : '▌ ', color, chrome: true }
}
