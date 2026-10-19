import { authorKeyOf } from '../../agents/state/store.js'
import type { Density } from '../../app/settings.js'
import type { Theme } from './themes.js'

/** The user's personal choices that shape drawing, beyond the theme. */
export interface Look {
  density: Density
  /** The glyph shown beside your own name, '' for none. */
  badge: string
  /** Personal agent colors by agent name; an agent without one takes a theme author color. */
  agentColors: Readonly<Record<string, string>>
  /** Your own name. */
  me: string
}

export const DEFAULT_LOOK: Look = { density: 'cozy', badge: '', agentColors: {}, me: 'you' }

/** Glyphs `/badge auto` picks from, by a hash of your name. */
const AUTO_BADGES = ['◆', '●', '▲', '■', '✦', '★', '⬢', '♦'] as const

const hashOf = (text: string): number => [...text].reduce((h, ch) => (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0, 7)

/** The badge setting as the glyph to draw: `auto` derives one from `name`, `none` is empty. */
export function badgeGlyph(setting: string, name: string): string {
  if (setting === 'none') return ''
  if (setting === 'auto') return AUTO_BADGES[hashOf(name) % AUTO_BADGES.length] ?? '◆'
  return setting
}

/** A theme author color chosen by the hex `key` of an author (people) or agent. */
export function colorFor(theme: Theme, key: string): string {
  return theme.authors[Number.parseInt(key.slice(0, 8), 16) % theme.authors.length] ?? theme.accent
}

/** An agent's color: its personal one, else a stable theme author color. */
export function agentTint(theme: Theme, look: Pick<Look, 'agentColors'>, name: string): string {
  return (Object.hasOwn(look.agentColors, name) ? look.agentColors[name] : undefined) ?? colorFor(theme, authorKeyOf(name))
}

/** Spacing rules of a density. */
export interface Spacing {
  /** The speaker gets a header row above their messages instead of a name inline. */
  stacked: boolean
  /** Blank rows between messages from different speakers. */
  gapBetweenSpeakers: number
}

const SPACING: Record<Density, Spacing> = {
  compact: { stacked: false, gapBetweenSpeakers: 0 },
  cozy: { stacked: true, gapBetweenSpeakers: 0 },
  roomy: { stacked: true, gapBetweenSpeakers: 1 },
}

export const spacingFor = (density: Density): Spacing => SPACING[density]

/** Panes this short fall back to compact so a header row per speaker does not eat the screen. */
export const COMPACT_BELOW_ROWS = 16

export const effectiveDensity = (density: Density, terminalRows: number): Density => (terminalRows < COMPACT_BELOW_ROWS ? 'compact' : density)
