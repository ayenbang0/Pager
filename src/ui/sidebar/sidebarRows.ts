import stringWidth from 'string-width'
import type { SharedView } from '../../agents/share/share.js'
import type { AgentView } from '../../agents/types.js'
import type { ConvView } from '../../app/engine.js'
import type { Theme } from '../theme/themes.js'
import { fitSegs, pillSeg, segsWidth, type Seg } from '../kit/segs.js'
import { raisedFill, relativeTime, ruleRow } from '../kit/tern.js'
import { spinnerCell } from '../kit/spinnerCells.js'
import { truncateWidth } from '../kit/truncate.js'

/** What one sidebar row shows, before it is laid out. */
export interface RowSpec {
  /** The one-column marker before the label. */
  glyph: string
  glyphColor?: string
  /** Draw a live spinner in the glyph's cell instead of `glyph`. */
  spinner?: boolean
  label: string
  labelColor?: string
  /** Right-aligned unread dot, ask or rev pill. */
  badge?: Seg[]
  /** Right-aligned dim relative time (`3m`); the first thing to give way when the row is tight. */
  time?: string
}

/** `▾ DIRECT ─────── 3`: a quiet group label, a hairline across the rest of `width`, the item count at the end. `fold` prefixes `▾ ` (open) or `▸ ` (closed). */
export function groupHeader(title: string, width: number, theme: Theme, fold?: 'open' | 'closed', count?: number): Seg[] {
  const shown = `${fold === undefined ? '' : fold === 'open' ? '▾ ' : '▸ '}${title}`
  const right: Seg[] = count === undefined ? [] : [{ text: String(count), color: theme.dim }]
  return ruleRow([{ text: ' ' }, { text: shown, color: theme.dim, bold: true }], right, width, theme)
}

/** `●3` in the accent for an unread count, capped at `99+`. Empty when there is nothing unread. */
export const unreadBadge = (count: number, theme: Theme): Seg[] => (count > 0 ? [{ text: `●${count > 99 ? '99+' : count}`, color: theme.accent, bold: true }] : [])

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

/** The call count in a conversation's room, as a quiet green `☎2 `. */
const callBadge = (conv: Pick<ConvView, 'call'>, theme: Theme): Seg[] => (conv.call === undefined ? [] : [{ text: `☎${conv.call} `, color: theme.success, bold: true }])

/**
 * A conversation row, the same wherever chats are listed (the sidebar, Home's recent chats): a contact is a presence dot (green online, a dim
 * ring offline), a group a `#`; then its title, the relative time of its newest message and the call and unread badges.
 */
export function chatRowSpec(conv: Pick<ConvView, 'kind' | 'online' | 'title' | 'unread' | 'call' | 'last' | 'thinking'>, now: number, theme: Theme): RowSpec {
  const badge = [...callBadge(conv, theme), ...unreadBadge(conv.unread, theme)]
  const time = conv.last === undefined ? {} : { time: relativeTime(conv.last, now) }
  if (conv.kind === 'dm') {
    const online = conv.online === true
    return { glyph: online ? '●' : '○', glyphColor: online ? theme.online : theme.dim, label: conv.title, labelColor: online ? theme.text : theme.dim, badge, ...time }
  }
  return { glyph: '#', glyphColor: theme.accent2, label: conv.title, badge, ...time, ...(conv.thinking === true ? { spinner: true } : {}) }
}

/** Fewest columns the label keeps before the time is dropped to make room. */
const MIN_LABEL = 6

/** One row of exactly `width` columns. The active row sits on the soft raised fill with a bold accent label; unread dots and pills keep their own colors at the right end. */
export function buildRow(spec: RowSpec, active: boolean, width: number, theme: Theme): Seg[] {
  const fill = active ? { bg: raisedFill(theme) } : {}
  const badge = spec.badge ?? []
  const lead = spec.glyph === '' ? 1 : 3
  const tailWidth = (time: string): number => (time === '' ? 0 : stringWidth(time)) + (time !== '' && badge.length > 0 ? 1 : 0) + segsWidth(badge)
  // A row's tail gets one space of margin on the right and one before it.
  const room = (time: string): number => width - lead - (tailWidth(time) === 0 ? 1 : tailWidth(time) + 2)
  const time = spec.time !== undefined && room(spec.time) >= MIN_LABEL ? spec.time : ''
  const glyph: Seg[] =
    spec.glyph === ''
      ? []
      : [spec.spinner === true ? spinnerCell({ color: spec.glyphColor, ...fill }) : { ...fill, text: spec.glyph, color: spec.glyphColor, bold: true }, { ...fill, text: ' ' }]
  const plain = spec.labelColor === undefined || spec.labelColor === theme.text || spec.labelColor === theme.dim
  const color = active && plain ? theme.accent : (spec.labelColor ?? theme.text)
  const label: Seg = { ...fill, text: truncateWidth(spec.label, Math.max(1, room(time))), color, bold: active }
  const tail: Seg[] = [
    ...(time === '' ? [] : [{ ...fill, text: time, color: theme.dim }]),
    ...(time !== '' && badge.length > 0 ? [{ ...fill, text: ' ' }] : []),
    ...badge.map((s): Seg => (s.bg === undefined ? { ...s, ...fill } : s)),
    ...(tailWidth(time) === 0 ? [] : [{ ...fill, text: ' ' }]),
  ]
  const left: Seg[] = [{ ...fill, text: ' ' }, ...glyph, label]
  const gap = Math.max(0, width - segsWidth(left) - segsWidth(tail))
  return fitSegs([...left, { ...fill, text: ' '.repeat(gap) }, ...tail], width, fill)
}
