import type { Theme } from '../theme/themes.js'
import { fitSegs, pillSeg, segsWidth, spread, type Seg } from '../kit/segs.js'
import { spinnerCell } from '../kit/spinnerCells.js'

export type StatusMode = 'home' | 'chat' | 'group' | 'hub' | 'shared' | 'agent' | 'terminal' | 'docs'

export interface StatusInput {
  columns: number
  listening: boolean
  online: number
  unread: number
  pending: number
  agentsRunning: number
  agentsReady: number
  review: boolean
  update: string | null
  mode: StatusMode
  quitArmed: boolean
  /** The time of day to show, `HH:MM`. */
  clock: string
}

/** Wide enough for every pill with its words and the clock. */
export const FULL_COLUMNS = 100
/** Below this only the mode, the connection and the most important alert are shown. */
export const COMPACT_COLUMNS = 76

export type StatusTier = 'full' | 'compact' | 'minimal'

export const statusTier = (columns: number): StatusTier => (columns >= FULL_COLUMNS ? 'full' : columns >= COMPACT_COLUMNS ? 'compact' : 'minimal')

const MODE_PILLS: Record<StatusMode, string> = {
  agent: '◆ AGENT',
  chat: '● CHAT',
  group: '# GROUP',
  home: '⌂ HOME',
  hub: '⌁ HUB',
  shared: '◈ SHARED',
  terminal: '▸ TERM',
  docs: '▤ DOCS',
}

/** `HH:MM` in local time. */
export function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** One pill of the left side; a lower `rank` is more important and is the last to be dropped when the row is too narrow. */
interface Part {
  rank: number
  /** Always shown, whatever the width. */
  keep?: boolean
  segs: Seg[]
}

/** ` <spinner> label ` as a pill; the spinner cell is drawn live by `SpinnerLine`. */
function spinnerPill(label: string, p: { fg: string; bg: string }): Seg[] {
  return [{ text: ' ', color: p.fg, bg: p.bg }, spinnerCell({ color: p.fg, bg: p.bg }), { text: ` ${label} `, color: p.fg, bg: p.bg, bold: true }]
}

function leftParts(input: StatusInput, tier: StatusTier, theme: Theme): Part[] {
  const { pill } = theme
  const words = tier === 'full'
  const parts: Part[] = [
    { rank: 0, keep: true, segs: [pillSeg(MODE_PILLS[input.mode], pill.accent)] },
    { rank: 1, keep: true, segs: input.listening ? [pillSeg('● connected', pill.success)] : spinnerPill('connecting…', pill.warning) },
  ]
  if (input.pending > 0) parts.push({ rank: 2, segs: [pillSeg(`◌ ${input.pending} pending`, pill.warning)] })
  if (input.unread > 0) parts.push({ rank: 3, segs: [pillSeg(`● ${input.unread} unread`, pill.warning)] })
  if (input.agentsRunning > 0) parts.push({ rank: 4, segs: spinnerPill(`${input.agentsRunning} running`, pill.accent2) })
  else if (input.agentsReady > 0) parts.push({ rank: 7, segs: [{ text: ` ◆ ${input.agentsReady} ready `, color: theme.dim }] })
  if (input.review && input.agentsReady > 0) parts.push({ rank: 5, segs: [pillSeg(words ? '⚑ review' : '⚑', pill.success)] })
  if (input.update !== null) {
    const tag = pillSeg(`↑ ${input.update}`, pill.accent2)
    parts.push({ rank: 6, segs: words ? [tag, { text: ' pager update ', color: theme.dim }] : [tag] })
  }
  parts.push({ rank: 8, segs: [pillSeg(words ? `${input.online} online` : `●${input.online}`, input.online > 0 ? pill.info : pill.muted, false)] })
  if (tier !== 'minimal') return parts
  // Mode, connection and the single most important alert.
  return parts.filter((p) => p.keep === true || p.rank <= 4).slice(0, 3)
}

function rightSegs(input: StatusInput, tier: StatusTier, theme: Theme): Seg[] {
  if (input.quitArmed) return [pillSeg('Press Ctrl+C again to quit', theme.pill.error), { text: ' ' }]
  return tier === 'full' ? [pillSeg(input.clock, theme.pill.muted, false), { text: ' ' }] : []
}

/**
 * The status row as segs of exactly `input.columns` columns on the theme surface.
 * Spinner cells (`SPINNER_CELL`) mark where `SpinnerLine` draws a live spinner.
 */
export function statusSegments(input: StatusInput, theme: Theme): Seg[] {
  const fill = { bg: theme.surface }
  const tier = statusTier(input.columns)
  const right = rightSegs(input, tier, theme)
  const sep: Seg = { text: '▕', color: theme.dim, bg: theme.surface }
  const join = (parts: readonly Part[]): Seg[] => [{ ...fill, text: ' ' }, ...parts.flatMap((p, i) => (i === 0 ? p.segs : [sep, ...p.segs]))]
  let parts = leftParts(input, tier, theme)
  // Too narrow: shed the least important pills first, never the mode or the connection.
  while (segsWidth(join(parts)) + segsWidth(right) > input.columns) {
    const drop = parts.reduce((worst, p, i) => (p.keep !== true && p.rank > (parts[worst]?.rank ?? -1) ? i : worst), -1)
    if (drop < 0) break
    parts = parts.filter((_, i) => i !== drop)
  }
  return spread(join(parts), right.map((s) => (s.bg === undefined ? { ...s, ...fill } : s)), input.columns, fill)
}

/** The row of `columns` spaces painted on the surface, for a bar that has nothing to say. */
export const blankBar = (columns: number, theme: Theme): Seg[] => fitSegs([], columns, { bg: theme.surface })
