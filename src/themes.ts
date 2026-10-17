import { contrast, lighten, mix, readableOn, snapAnsi } from './colors.js'

/** Foreground and background of a filled badge (an inverse "pill"). `fg` always reads on `bg`. */
export interface Pill {
  fg: string
  bg: string
}

export const PILL_KINDS = ['accent', 'accent2', 'success', 'warning', 'error', 'info', 'muted'] as const
export type PillKind = (typeof PILL_KINDS)[number]

/** Semantic color tokens. Values are Ink color strings (names or #rrggbb). Components read these, never literal colors. */
export interface Theme {
  name: string
  description: string
  /** Prompt glyph, titles, focus: the color the theme is known by. `/accent` overrides it everywhere. */
  accent: string
  /** The second brand color: the far end of gradients, secondary highlights, code bars. */
  accent2: string
  /** A lighter tint of the accent for glows, cursors and the bright half of two-tone text. */
  glow: string
  /** Inactive borders and rules. */
  border: string
  /** Secondary text: timestamps, descriptions, hints. */
  dim: string
  /** Primary text on a `surface`. */
  text: string
  /** Background of bands: the header, status bar, section titles and system notes. */
  surface: string
  success: string
  warning: string
  error: string
  info: string
  online: string
  /** Unread counts and the pending section. */
  badge: string
  /** Your own name in message lists. */
  mine: string
  /** The gutter bar of your own messages. */
  userBubble: string
  /** Other authors, picked by a hash of their key. At least one entry. */
  authors: readonly string[]
  /** Two to four stops for the logo and rules, left to right. */
  gradient: readonly string[]
  /** Section header bands (`▌ CHATS`). */
  band: Pill
  /** Inverse badges by meaning. */
  pill: Record<PillKind, Pill>
}

/** A pill whose text is chosen to read on `bg`. */
function pill(bg: string): Pill {
  let fill = bg
  // A mid-tone fill can fail with both near-black and white text; brighten it a little until the text reads.
  for (let step = 0; step < 12 && fill.startsWith('#') && contrast(readableOn(fill), fill) < 4.5; step++) fill = mix(fill, '#ffffff', 0.05)
  return { fg: readableOn(fill), bg: fill }
}

type Base = Omit<Theme, 'band' | 'pill'>

/** How far the saturated tokens are pulled toward the background: the theme palettes are tuned vivid, this keeps them bold but easy on the eyes. */
const TONE_DOWN = 0.3
/** Secondary text moves toward primary text by this much so it never gets hard to read. */
const DIM_LIFT = 0.15

/** Pulls `color` toward `toward` (hex only; ANSI names are left to the terminal's own palette). */
const soften = (color: string, toward: string): string => (color.startsWith('#') ? mix(color, toward, TONE_DOWN) : color)

/** Tones the vivid tokens down by TONE_DOWN and lifts the dim text; glow, text and surface stay as designed. */
function tone(base: Base): Base {
  const dark = contrast(base.surface, '#ffffff') > 4
  const to = dark ? base.surface : base.text
  const s = (c: string): string => soften(c, to)
  return {
    ...base,
    accent: s(base.accent),
    accent2: s(base.accent2),
    border: s(base.border),
    dim: base.dim.startsWith('#') ? mix(base.dim, base.text, DIM_LIFT) : base.dim,
    success: s(base.success),
    warning: s(base.warning),
    error: s(base.error),
    info: s(base.info),
    online: s(base.online),
    badge: s(base.badge),
    mine: s(base.mine),
    userBubble: s(base.userBubble),
    authors: base.authors.map(s),
    gradient: base.gradient.map(s),
  }
}

/** Fills in the derived tokens: a band in the accent and a pill per meaning, each readable on its own background. */
function build(raw: Base): Theme {
  const base = tone(raw)
  return {
    ...base,
    band: pill(base.accent),
    pill: {
      accent: pill(base.accent),
      accent2: pill(base.accent2),
      success: pill(base.success),
      warning: pill(base.warning),
      error: pill(base.error),
      info: pill(base.info),
      muted: { fg: base.text, bg: mix(base.surface, base.text, 0.16) },
    },
  }
}

export const THEMES: readonly Theme[] = [
  build({
    // Palette from oh-my-pi's "titanium" theme, turned up: electric blue, hot magenta, mint.
    name: 'omp',
    description: 'Electric blue and magenta on steel (oh-my-pi inspired)',
    accent: '#00c8ff',
    accent2: '#ff4fd8',
    glow: '#8df4ff',
    border: '#2a6f95',
    dim: '#7f8da1',
    text: '#e8f0f8',
    surface: '#0f1a2b',
    success: '#00ff88',
    warning: '#ffb347',
    error: '#ff4d6a',
    info: '#6ec9ff',
    online: '#00ff88',
    badge: '#ffb347',
    mine: '#00c8ff',
    userBubble: '#00c8ff',
    authors: ['#ffd166', '#00ff88', '#d06fed', '#13e8e0', '#ff9f43', '#6ec9ff', '#ff6b9d'],
    gradient: ['#00e5ff', '#4d7cff', '#d84dff'],
  }),
  build({
    name: 'neon',
    description: 'Hot pink, acid lime and cyan on near-black',
    accent: '#ff2bd6',
    accent2: '#39ff14',
    glow: '#ff9cf0',
    border: '#7a1f8a',
    dim: '#9a7fb0',
    text: '#f5eaff',
    surface: '#16041f',
    success: '#39ff14',
    warning: '#fff200',
    error: '#ff3b30',
    info: '#00f0ff',
    online: '#39ff14',
    badge: '#fff200',
    mine: '#ff2bd6',
    userBubble: '#ff2bd6',
    authors: ['#00f0ff', '#39ff14', '#fff200', '#ff9100', '#b388ff', '#ff4081'],
    gradient: ['#ff2bd6', '#9d4dff', '#00f0ff'],
  }),
  build({
    name: 'sunset',
    description: 'Gold, orange and pink fading into violet',
    accent: '#ff7a1a',
    accent2: '#ff3d8b',
    glow: '#ffc27a',
    border: '#8a3b4a',
    dim: '#b58a8a',
    text: '#fff1e6',
    surface: '#2a0f1a',
    success: '#9be564',
    warning: '#ffd23f',
    error: '#ff4d4d',
    info: '#ff9bb3',
    online: '#9be564',
    badge: '#ffd23f',
    mine: '#ff7a1a',
    userBubble: '#ff7a1a',
    authors: ['#ffd23f', '#ff9bb3', '#9be564', '#ff6b6b', '#c77dff', '#ffa94d'],
    gradient: ['#ffd23f', '#ff7a1a', '#ff3d8b', '#a83cff'],
  }),
  build({
    name: 'aurora',
    description: 'Northern lights: mint, ice blue and violet',
    accent: '#2dffb2',
    accent2: '#a06bff',
    glow: '#b6ffe6',
    border: '#2c6e63',
    dim: '#7fa89d',
    text: '#e6fff6',
    surface: '#071f22',
    success: '#2dffb2',
    warning: '#ffd166',
    error: '#ff5c7a',
    info: '#5ce1ff',
    online: '#2dffb2',
    badge: '#ffd166',
    mine: '#2dffb2',
    userBubble: '#2dffb2',
    authors: ['#5ce1ff', '#a06bff', '#2dffb2', '#ffd166', '#ff8fd1', '#8bff6b'],
    gradient: ['#2dffb2', '#5ce1ff', '#a06bff'],
  }),
  build({
    name: 'ocean',
    description: 'Cool blues and teals',
    accent: '#38c6ff',
    accent2: '#00e0b8',
    glow: '#9be7ff',
    border: '#2f6f8a',
    dim: '#7f9fb0',
    text: '#e6f6ff',
    surface: '#0b2233',
    success: '#2de2b1',
    warning: '#ffb74d',
    error: '#ff5a5f',
    info: '#81d4fa',
    online: '#2de2b1',
    badge: '#ffb74d',
    mine: '#38c6ff',
    userBubble: '#38c6ff',
    authors: ['#81d4fa', '#2de2b1', '#9fa8da', '#b39ddb', '#80cbc4', '#90caf9'],
    gradient: ['#38c6ff', '#2de2b1', '#7c8cff'],
  }),
  build({
    name: 'amber',
    description: 'Warm gold on dark',
    accent: '#ffbf00',
    accent2: '#ff6a3d',
    glow: '#ffe27a',
    border: '#8d6e3f',
    dim: '#b09878',
    text: '#fff4dc',
    surface: '#241a08',
    success: '#9be564',
    warning: '#ff9800',
    error: '#ff4d3d',
    info: '#ffd54f',
    online: '#9be564',
    badge: '#ff9800',
    mine: '#ffbf00',
    userBubble: '#ffbf00',
    authors: ['#ffd54f', '#ffb74d', '#bcaaa4', '#dce775', '#ff8a65', '#e6ee9c'],
    gradient: ['#ffe27a', '#ffbf00', '#ff6a3d'],
  }),
  build({
    name: 'terminal',
    description: 'Your terminal ANSI palette',
    accent: 'cyan',
    accent2: 'magentaBright',
    glow: 'cyanBright',
    border: 'gray',
    dim: 'gray',
    text: 'white',
    surface: 'black',
    success: 'green',
    warning: 'yellow',
    error: 'red',
    info: 'cyan',
    online: 'green',
    badge: 'yellow',
    mine: 'cyan',
    userBubble: 'cyan',
    authors: ['magenta', 'yellow', 'green', 'blue', 'red', 'cyan'],
    gradient: ['cyan', 'blue', 'magenta'],
  }),
  {
    ...build({
      name: 'mono',
      description: 'Grayscale, no hue',
      accent: 'white',
      accent2: 'gray',
      glow: 'whiteBright',
      border: 'gray',
      dim: 'gray',
      text: 'white',
      surface: 'black',
      success: 'white',
      warning: 'white',
      error: 'white',
      info: 'white',
      online: 'white',
      badge: 'white',
      mine: 'white',
      userBubble: 'white',
      authors: ['white', 'gray'],
      gradient: ['white', 'gray'],
    }),
    // Without hue the pills are plain white-on-black and black-on-white so they stay legible on any terminal.
    pill: {
      accent: { fg: 'black', bg: 'white' },
      accent2: { fg: 'black', bg: 'white' },
      success: { fg: 'black', bg: 'white' },
      warning: { fg: 'black', bg: 'white' },
      error: { fg: 'black', bg: 'white' },
      info: { fg: 'black', bg: 'white' },
      muted: { fg: 'white', bg: 'black' },
    },
  },
  build({
    name: 'light',
    description: 'For light terminal backgrounds',
    accent: '#0057ff',
    accent2: '#d6006f',
    glow: '#4d8bff',
    border: '#9aa7b8',
    dim: '#5b6778',
    text: '#101828',
    surface: '#dfe7f3',
    success: '#0a7f3f',
    warning: '#a35a00',
    error: '#c4122f',
    info: '#0062a8',
    online: '#0a7f3f',
    badge: '#a35a00',
    mine: '#0057ff',
    userBubble: '#0057ff',
    authors: ['#6a1b9a', '#ad1457', '#2e7d32', '#1565c0', '#c62828', '#00695c'],
    gradient: ['#0057ff', '#7a3cff', '#d6006f'],
  }),
]

export const DEFAULT_THEME: Theme = THEMES[0]!

/** Exact, case-insensitive match. Unknown names resolve to undefined. */
export function findTheme(name: string): Theme | undefined {
  const wanted = name.trim().toLowerCase()
  return THEMES.find((t) => t.name === wanted)
}

/** `theme` with its accent replaced everywhere the accent shows: text, gutters, bands, accent pills and the logo gradient. */
export function withAccent(theme: Theme, accent: string): Theme {
  return {
    ...theme,
    accent,
    mine: accent,
    userBubble: accent,
    glow: lighten(accent, 0.45),
    gradient: [accent, theme.accent2],
    band: pill(accent),
    pill: { ...theme.pill, accent: pill(accent) },
  }
}

const COLOR_FIELDS = ['accent', 'accent2', 'glow', 'border', 'dim', 'text', 'surface', 'success', 'warning', 'error', 'info', 'online', 'badge', 'mine', 'userBubble'] as const

/**
 * The theme for a terminal with only 16 colors: every color snapped to the nearest ANSI one, pills re-picked so text still reads
 * on its fill. Terminals with 256 colors or truecolor keep the exact values (Ink down-samples hex itself).
 */
export function degradeTheme(theme: Theme): Theme {
  const out: Theme = { ...theme, authors: theme.authors.map(snapAnsi), gradient: [...new Set(theme.gradient.map(snapAnsi))] }
  for (const field of COLOR_FIELDS) out[field] = snapAnsi(theme[field])
  // An ANSI fill that cannot carry either text color (magenta, cyan, bright blue) moves to its bright or plain sibling.
  const snapPill = (p: Pill): Pill => {
    const bg = snapAnsi(p.bg)
    const candidates = [bg, `${bg}Bright`, bg.replace(/Bright$/, '')].map(pill)
    return candidates.find((c) => contrast(c.fg, c.bg) >= 4.5) ?? candidates[0]!
  }
  out.band = snapPill(theme.band)
  out.pill = {
    accent: snapPill(theme.pill.accent),
    accent2: snapPill(theme.pill.accent2),
    success: snapPill(theme.pill.success),
    warning: snapPill(theme.pill.warning),
    error: snapPill(theme.pill.error),
    info: snapPill(theme.pill.info),
    muted: { fg: snapAnsi(theme.pill.muted.fg), bg: snapAnsi(theme.pill.muted.bg) },
  }
  return out
}

/** Colors the terminal can show: 1 (none), 4 (16), 8 (256) or 24 (truecolor), as `process.stdout.getColorDepth()` reports. */
export function terminalDepth(): number {
  return typeof process.stdout.getColorDepth === 'function' ? process.stdout.getColorDepth() : 4
}

/** The theme the UI draws with: the saved one (or the default), the accent override, and a 16-color fallback when needed. */
export function resolveTheme(name: string, accent: string | undefined, depth: number = terminalDepth()): Theme {
  const base = findTheme(name) ?? DEFAULT_THEME
  const themed = accent === undefined ? base : withAccent(base, accent)
  return depth >= 8 ? themed : degradeTheme(themed)
}
