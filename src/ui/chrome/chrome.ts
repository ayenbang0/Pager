import type { Theme } from '../theme/themes.js'
import { gradientText, segsWidth, spread, type Seg } from '../kit/segs.js'
import { dot, tabPills } from '../kit/tern.js'
import { truncateWidth } from '../kit/truncate.js'

/** What the header band shows. `spinner` is the current spinner frame (the component animates it). */
export interface HeaderInput {
  width: number
  /** Breadcrumb, outermost first: `['CHATS', 'alice']`. The first names the section tab, the second the place inside it. */
  crumbs: readonly string[]
  connected: boolean
  unread: number
  agentsRunning: number
  spinner: string
  name: string
  /** The glyph beside your name, '' for none. */
  badge: string
  /** False in a run without agents: the Agents tab is left out. Default true. */
  agentsOn?: boolean
}

/** The section tabs of the top bar: the crumb that names each and its label. */
const SECTIONS = [
  ['HOME', 'Home'],
  ['CHATS', 'Chats'],
  ['AGENTS', 'Agents'],
  ['TOOLS', 'Tools'],
] as const

/** Longest identity name the top bar shows before cutting it. */
const NAME_MAX = 16

/**
 * The top bar, one row on the surface: the mark, your avatar and identity chip, the section tab pills (the active one raised,
 * then the place inside it), and quiet status at the right: the connection dot, running agents, the unread dot in the accent.
 * Narrow bars drop the inactive tabs, then your name, then the status, clipping the place last.
 */
export function headerSegs(i: HeaderInput, theme: Theme): Seg[] {
  const fill = { bg: theme.surface }
  const paint = (segs: readonly Seg[]): Seg[] => segs.map((s) => (s.bg === undefined ? { ...s, ...fill } : s))
  const sections = SECTIONS.filter(([key]) => key !== 'AGENTS' || i.agentsOn !== false)
  const at = sections.findIndex(([key]) => key === i.crumbs[0])
  const leaf = i.crumbs[1]
  const leafSegs: Seg[] = leaf === undefined ? [] : [{ text: ' › ', color: theme.border }, { text: leaf, color: theme.text, bold: true }]
  const active = sections[at]
  const tabs = tabPills(sections.map(([, label]) => label), at, theme)
  const tab = active === undefined ? [] : tabPills([active[1]], 0, theme)
  const initial = [...i.name][0]?.toUpperCase() ?? '?'
  const avatar: Seg = { text: ` ${initial} `, color: theme.pill.accent.fg, bg: theme.pill.accent.bg, bold: true }
  const who: Seg[] = [{ text: ` ${i.badge === '' ? '' : `${i.badge} `}${truncateWidth(i.name, NAME_MAX)}  `, color: theme.text }, { text: '│', color: theme.border }, { text: ' ' }]
  const mark = gradientText('◆', theme.gradient, { bold: true })
  const head = [{ text: ' ' }, ...mark, { text: ' ' }, avatar]
  const place: Seg[] = active === undefined && leaf !== undefined ? [{ text: ' ' }, { text: leaf, color: theme.text, bold: true }] : leafSegs
  const conn: Seg[] = i.connected ? [dot(theme.online), { text: ' online', color: theme.dim }] : [{ text: '… connecting', color: theme.warning }]
  const agents: Seg[] = i.agentsRunning > 0 ? [{ text: `${i.spinner} ${i.agentsRunning}`, color: theme.accent2, bold: true }] : []
  const unread: Seg[] = i.unread > 0 ? [{ text: `●${i.unread}`, color: theme.accent, bold: true }] : []
  const status = (...parts: Seg[][]): Seg[] => {
    const shown = parts.filter((p) => p.length > 0)
    return shown.length === 0 ? [] : [...shown.flatMap((p, n) => (n === 0 ? p : [{ text: '  ' }, ...p])), { text: ' ' }]
  }
  const full = [...head, ...who, ...tabs, ...place]
  const lean = [...head, ...who, ...tab, ...place]
  const bare = [...head, { text: ' ' }, ...tab, ...place]
  const mini = [...head, ...(place.length > 0 ? place : [{ text: ' ' }])]
  // Drop the least important pieces first until the band fits; the place is clipped last.
  const tiers: [Seg[], Seg[]][] = [
    [full, status(conn, agents, unread)],
    [full, status(agents, unread)],
    [lean, status(agents, unread)],
    [lean, status(unread)],
    [bare, status(unread)],
    [mini, status(unread)],
  ]
  for (const [left, right] of tiers) {
    if (segsWidth(left) + segsWidth(right) <= i.width) return spread(paint(left), paint(right), i.width, fill)
  }
  return spread(paint(mini), paint(status(unread)), i.width, fill)
}

/** One side of the prompt box's chip: text and the fill behind it. */
export interface PromptChip {
  text: string
  /** Fill color; absent = the theme accent. */
  color?: string
}

/** Where the user is, as far as the chrome cares. */
export interface Place {
  kind: 'home' | 'dm' | 'group' | 'hub' | 'shared' | 'agent' | 'terminal' | 'docs' | 'settings' | 'ai'
  /** Conversation, agent or document name; '' where there is none. */
  title: string
}

/** Header breadcrumb for a place, outermost first, matching the sidebar's HOME / CHATS / TOOLS groups. */
export function crumbsFor(place: Place): string[] {
  switch (place.kind) {
    case 'home':
      return ['HOME']
    case 'dm':
      return ['CHATS', place.title]
    case 'group':
      return ['CHATS', `# ${place.title}`]
    case 'hub':
      return ['CHATS', '⌁ agents']
    case 'shared':
      return ['CHATS', `◈ ${place.title}`]
    case 'agent':
      return ['CHATS', `◆ ${place.title}`]
    case 'terminal':
      return ['TOOLS', '▸ terminal']
    case 'docs':
      return ['TOOLS', place.title === '' ? '▤ docs' : `▤ docs · ${place.title}`]
    case 'settings':
      return ['TOOLS', '⚙ settings']
    case 'ai':
      return ['AGENTS', '✦ ai']
  }
}

/** The mode label on the prompt's top border: who the message goes to, or that it is a command. `tint` fills an agent's chip in its color. */
export function chipFor(place: Place, command: boolean, tint?: string): PromptChip {
  if (command) return { text: '/ command' }
  switch (place.kind) {
    case 'home':
      return { text: '⌂ commands' }
    case 'dm':
      return { text: `→ ${place.title}` }
    case 'group':
      return { text: `→ #${place.title}` }
    case 'hub':
      return { text: '→ @agents' }
    case 'shared':
      return { text: `→ @agents · ${place.title}` }
    case 'agent':
      return tint === undefined ? { text: `→ ${place.title}` } : { text: `→ ${place.title}`, color: tint }
    case 'terminal':
      return { text: '▸ shell' }
    case 'docs':
      return { text: '▤ docs' }
    case 'settings':
      return { text: '⚙ settings' }
    case 'ai':
      return { text: '✦ ai' }
  }
}
