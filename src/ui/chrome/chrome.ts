import stringWidth from 'string-width'
import { gradientAt, readableOn } from '../theme/colors.js'
import type { Theme } from '../theme/themes.js'
import { clipSegs, gradientText, mergeSegs, pillSeg, segsWidth, spread, type Seg } from '../kit/segs.js'

/** What the header band shows. `spinner` is the current spinner frame (the component animates it). */
export interface HeaderInput {
  width: number
  /** Breadcrumb, outermost first: `['CHATS', 'alice']`. */
  crumbs: readonly string[]
  connected: boolean
  unread: number
  agentsRunning: number
  spinner: string
  name: string
  /** The glyph beside your name, '' for none. */
  badge: string
}

/** The top row: a full-width band with the two-tone logo and breadcrumb on the left and status pills on the right. */
export function headerSegs(i: HeaderInput, theme: Theme): Seg[] {
  const fill = { bg: theme.surface }
  const logo = gradientText('◆ pager', theme.gradient, { bold: true, ...fill })
  const crumbs = i.crumbs.flatMap((c, n): Seg[] => [
    { ...fill, text: '  ›  ', color: theme.border },
    { ...fill, text: c, color: n === i.crumbs.length - 1 ? theme.text : theme.dim, bold: n === i.crumbs.length - 1 },
  ])
  const left: Seg[] = [{ ...fill, text: ' ' }, ...logo, ...crumbs]
  const space: Seg = { ...fill, text: ' ' }
  const conn = i.connected ? pillSeg('● online', theme.pill.success) : pillSeg('… connecting', theme.pill.warning)
  const agents = i.agentsRunning > 0 ? pillSeg(`${i.spinner} ${i.agentsRunning}`, theme.pill.accent2) : undefined
  const unread = i.unread > 0 ? pillSeg(`●${i.unread}`, theme.pill.warning) : undefined
  const you = pillSeg(i.badge === '' ? i.name : `${i.badge} ${i.name}`, theme.pill.accent)
  // Drop the least important pills first until the band fits; the breadcrumb is clipped last.
  const tiers: (Seg | undefined)[][] = [
    [conn, agents, unread, you],
    [agents, unread, you],
    [unread, you],
    [you],
  ]
  for (const tier of tiers) {
    const right = tier.filter((p): p is Seg => p !== undefined).flatMap((p): Seg[] => [p, space])
    if (segsWidth(left) + segsWidth(right) <= i.width) return spread(left, right, i.width, fill)
  }
  return spread(left, [you, space], i.width, fill)
}

/** One side of the prompt box's chip: text and the fill behind it. */
export interface PromptChip {
  text: string
  /** Fill color; absent = the theme accent. */
  color?: string
}

export interface PromptBorders {
  top: Seg[]
  bottom: Seg[]
}

/** A heavy border row `width` columns wide with `inserts` (a chip, a hint) placed at their columns. Active rows fade across the theme gradient. */
function borderRow(width: number, corners: readonly [string, string], inserts: readonly { at: number; segs: Seg[] }[], theme: Theme, active: boolean): Seg[] {
  const stops = active ? theme.gradient : [theme.border]
  const out: Seg[] = []
  for (let col = 0; col < width; ) {
    const insert = inserts.find((x) => x.at === col)
    const w = insert === undefined ? 0 : segsWidth(insert.segs)
    if (insert !== undefined && w > 0) {
      out.push(...insert.segs)
      col += w
      continue
    }
    const glyph = col === 0 ? corners[0] : col === width - 1 ? corners[1] : '━'
    out.push({ text: glyph, color: gradientAt(stops, width <= 1 ? 0 : (col - (col % 4)) / (width - 1)), bold: active })
    col++
  }
  return mergeSegs(out)
}

/**
 * The heavy borders of the prompt box, each `width` columns: the top carries the mode chip, the bottom the hint on the right.
 * Active boxes glow with the theme gradient; inactive ones (an overlay owns the keyboard) fall back to the quiet border color.
 */
export function promptBorders(width: number, chip: PromptChip, hint: string, active: boolean, theme: Theme): PromptBorders {
  const bg = chip.color ?? theme.pill.accent.bg
  const chipSegs = clipSegs([{ text: ` ${chip.text} `, color: readableOn(bg), bg, bold: true }], Math.max(0, width - 6))
  const room = width - 6
  const shown = hint.length === 0 || room < 6 ? '' : stringWidth(hint) > room ? `${clipSegs([{ text: hint }], room - 1)[0]?.text ?? ''}…` : hint
  const hintSegs: Seg[] = shown === '' ? [] : [{ text: ` ${shown} `, color: theme.dim }]
  const top = borderRow(width, ['┏', '┓'], [{ at: 2, segs: chipSegs }], theme, active)
  const bottom = borderRow(width, ['┗', '┛'], [{ at: width - 2 - segsWidth(hintSegs), segs: hintSegs }], theme, active)
  return { top, bottom }
}

/** Where the user is, as far as the chrome cares. */
export interface Place {
  kind: 'home' | 'dm' | 'group' | 'hub' | 'shared' | 'agent' | 'terminal' | 'docs' | 'settings' | 'web' | 'ai'
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
    case 'web':
      return ['TOOLS', '⌕ web']
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
    case 'web':
      return { text: '⌕ web' }
    case 'ai':
      return { text: '✦ ai' }
  }
}
