import type { SharedView } from '../agents/share.js'
import type { AgentView } from '../agents/types.js'
import type { Theme } from '../themes.js'
import { bandLabel, fitSegs, gradientRule, pillSeg, segsWidth, selectedBar, type Seg } from './segs.js'
import { spinnerCell } from './spinnerCells.js'
import { truncateWidth } from './truncate.js'

/** What one sidebar row shows, before it is laid out. */
export interface RowSpec {
  /** The one-column marker before the label. */
  glyph: string
  glyphColor?: string
  /** Draw a live spinner in the glyph's cell instead of `glyph`. */
  spinner?: boolean
  label: string
  labelColor?: string
  /** Right-aligned pills (unread, ask, rev). */
  badge?: Seg[]
}

/** `▌ TITLE ` then a thin gradient rule across the rest of `width`. */
export function groupHeader(title: string, width: number, theme: Theme): Seg[] {
  const label = bandLabel(title, theme)
  const rule = Math.max(0, width - segsWidth(label) - 1)
  return fitSegs([...label, { text: ' ' }, ...gradientRule(rule, theme.gradient, '─')], width)
}

/** ` ●3 ` for an unread count, capped at `99+`. Empty when there is nothing unread. */
export const unreadBadge = (count: number, theme: Theme): Seg[] => (count > 0 ? [pillSeg(`●${count > 99 ? '99+' : count}`, theme.pill.warning)] : [])

/** The pill of an agent that needs the user: ` ? ask ` (alternating with the accent pill while `blink` is off), ` rev ` or unread. */
export function agentBadge(agent: Pick<AgentView, 'state' | 'unread'>, theme: Theme, blink: boolean): Seg[] {
  if (agent.state === 'asking') return [pillSeg('? ask', blink ? theme.pill.warning : theme.pill.accent)]
  if (agent.state === 'reviewing') return [pillSeg('rev', theme.pill.info)]
  return unreadBadge(agent.unread, theme)
}

/** An agent row: its state dot (spinner when working, a blinking `?` when asking), its name in its own color, then its badge. */
export function agentRowSpec(agent: AgentView, tint: string, theme: Theme, blink: boolean): RowSpec {
  const badge = agentBadge(agent, theme, blink)
  switch (agent.state) {
    case 'working':
      return { glyph: '●', glyphColor: tint, spinner: true, label: agent.name, labelColor: tint, badge }
    case 'asking':
      return { glyph: '?', glyphColor: blink ? theme.warning : tint, label: agent.name, labelColor: tint, badge }
    case 'reviewing':
      return { glyph: '◆', glyphColor: theme.info, label: agent.name, labelColor: tint, badge }
    case 'idle':
      return { glyph: '●', glyphColor: tint, label: agent.name, labelColor: tint, badge }
  }
}

/** A shared agent session someone invited me to: `◈` lit while the host is connected, a `? ask` pill when an agent waits on an answer. */
export function sharedRowSpec(s: SharedView, theme: Theme): RowSpec {
  const badge = s.asking ? [pillSeg('? ask', theme.pill.warning)] : unreadBadge(s.unread, theme)
  return { glyph: '◈', glyphColor: s.connected ? theme.accent : theme.dim, label: s.name, labelColor: s.connected ? theme.text : theme.dim, badge }
}

/** One row of exactly `width` columns. The active row is an inverse accent bar; its pills keep their own colors at the right end. */
export function buildRow(spec: RowSpec, active: boolean, width: number, theme: Theme): Seg[] {
  const badge = spec.badge ?? []
  // The pills plus one space of margin on the right (and one before them).
  const tail = badge.length === 0 ? 0 : segsWidth(badge) + 1
  const lead = spec.glyph === '' ? 0 : 2
  const room = Math.max(1, width - 1 - lead - (tail === 0 ? 0 : tail + 1))
  const glyph: Seg[] =
    spec.glyph === ''
      ? []
      : [spec.spinner === true ? spinnerCell({ color: spec.glyphColor }) : { text: spec.glyph, color: spec.glyphColor, bold: true }, { text: ' ' }]
  const label: Seg = { text: truncateWidth(spec.label, room), color: spec.labelColor ?? theme.text }
  const left = [...glyph, label]
  if (active) {
    const bar = selectedBar(left, width - tail, theme)
    return tail === 0 ? bar : [...bar, ...badge, { text: ' ', bg: theme.band.bg }]
  }
  const body = fitSegs([{ text: ' ' }, ...left], width - tail)
  return tail === 0 ? body : [...body, ...badge, { text: ' ' }]
}
