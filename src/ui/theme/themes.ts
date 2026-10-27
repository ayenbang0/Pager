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

/** How much of the color a toned pill keeps over the surface: a quiet tinted fill with light text instead of a neon block with black text. */
const PILL_KEEP = 0.42

/** A calm pill: `color` mixed into the surface (dark themes only), text chosen to read on it. Light surfaces keep the plain pill. */
function softPill(color: string, surface: string, text: string): Pill {
  if (!color.startsWith('#') || !surface.startsWith('#') || contrast(surface, '#ffffff') <= 4) return pill(color)
  let fill = mix(surface, color, PILL_KEEP)
  for (let step = 0; step < 12 && contrast(text, fill) < 4.5; step++) fill = mix(fill, surface, 0.1)
  return contrast(text, fill) >= 4.5 ? { fg: text, bg: fill } : pill(color)
}

type Base = Omit<Theme, 'band' | 'pill'>

/** How far the saturated tokens are pulled toward the background: the theme palettes are tuned vivid, this keeps them bold but easy on the eyes. */
const TONE_DOWN = 0.4
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

/** Fills in the derived tokens: a band in the accent and a pill per meaning, each readable on its own background. Custom themes skip the toning: their colors show as written. */
function build(raw: Base, toned = true): Theme {
  const base = toned ? tone(raw) : raw
  const p = (c: string): Pill => (toned ? softPill(c, base.surface, base.text) : pill(c))
  return {
    ...base,
    band: p(base.accent),
    pill: {
      accent: p(base.accent),
      accent2: p(base.accent2),
      success: p(base.success),
      warning: p(base.warning),
      error: p(base.error),
      info: p(base.info),
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
  // Flat themes: one-color rules and logo, no gradients anywhere.
  build({
    name: 'nord',
    description: 'Flat: frost blue on polar night, no gradients',
    accent: '#88c0d0',
    accent2: '#81a1c1',
    glow: '#b9e1ec',
    border: '#4c566a',
    dim: '#9aa5b8',
    text: '#eceff4',
    surface: '#2e3440',
    success: '#a3be8c',
    warning: '#ebcb8b',
    error: '#bf616a',
    info: '#81a1c1',
    online: '#a3be8c',
    badge: '#ebcb8b',
    mine: '#88c0d0',
    userBubble: '#88c0d0',
    authors: ['#b48ead', '#a3be8c', '#ebcb8b', '#d08770', '#8fbcbb', '#5e81ac'],
    gradient: ['#88c0d0', '#88c0d0'],
  }),
  build({
    name: 'gruvbox',
    description: 'Flat: warm retro yellow and orange, no gradients',
    accent: '#fabd2f',
    accent2: '#fe8019',
    glow: '#fde68a',
    border: '#504945',
    dim: '#a89984',
    text: '#ebdbb2',
    surface: '#282828',
    success: '#b8bb26',
    warning: '#fabd2f',
    error: '#fb4934',
    info: '#83a598',
    online: '#b8bb26',
    badge: '#fe8019',
    mine: '#fabd2f',
    userBubble: '#fabd2f',
    authors: ['#83a598', '#d3869b', '#8ec07c', '#fe8019', '#b8bb26', '#fb4934'],
    gradient: ['#fabd2f', '#fabd2f'],
  }),
  build({
    name: 'slate',
    description: 'Flat: calm blue on charcoal, no gradients',
    accent: '#61afef',
    accent2: '#c678dd',
    glow: '#a8d1f7',
    border: '#3b4048',
    dim: '#8b919a',
    text: '#e6e6e6',
    surface: '#1e2127',
    success: '#98c379',
    warning: '#e5c07b',
    error: '#e06c75',
    info: '#56b6c2',
    online: '#98c379',
    badge: '#e5c07b',
    mine: '#61afef',
    userBubble: '#61afef',
    authors: ['#c678dd', '#98c379', '#e5c07b', '#56b6c2', '#d19a66', '#e06c75'],
    gradient: ['#61afef', '#61afef'],
  }),
  build({
    name: 'paper',
    description: 'Flat: ink on warm paper for light terminals, no gradients',
    accent: '#2b6cb0',
    accent2: '#b7791f',
    glow: '#63a4e8',
    border: '#b8b0a0',
    dim: '#6b6458',
    text: '#1f1d1a',
    surface: '#f4f1ea',
    success: '#2f855a',
    warning: '#b7791f',
    error: '#c53030',
    info: '#2b6cb0',
    online: '#2f855a',
    badge: '#b7791f',
    mine: '#2b6cb0',
    userBubble: '#2b6cb0',
    authors: ['#805ad5', '#d53f8c', '#2f855a', '#dd6b20', '#319795', '#c53030'],
    gradient: ['#2b6cb0', '#2b6cb0'],
  }),
  // Visual themes: rich palettes with gradients.
  build({
    name: 'dracula',
    description: 'Purple, pink and cyan on the classic dark',
    accent: '#bd93f9',
    accent2: '#ff79c6',
    glow: '#dcc6ff',
    border: '#44475a',
    dim: '#7f8bbf',
    text: '#f8f8f2',
    surface: '#282a36',
    success: '#50fa7b',
    warning: '#f1fa8c',
    error: '#ff5555',
    info: '#8be9fd',
    online: '#50fa7b',
    badge: '#ffb86c',
    mine: '#bd93f9',
    userBubble: '#bd93f9',
    authors: ['#8be9fd', '#50fa7b', '#ffb86c', '#ff79c6', '#f1fa8c', '#ff5555'],
    gradient: ['#8be9fd', '#bd93f9', '#ff79c6'],
  }),
  build({
    name: 'synthwave',
    description: "Retro '84: sun yellow to hot pink to laser cyan",
    accent: '#f92aad',
    accent2: '#36f9f6',
    glow: '#ff9ee0',
    border: '#5a2a7a',
    dim: '#a99ac8',
    text: '#fdf2ff',
    surface: '#1a1033',
    success: '#72f1b8',
    warning: '#fede5d',
    error: '#fe4450',
    info: '#36f9f6',
    online: '#72f1b8',
    badge: '#fede5d',
    mine: '#f92aad',
    userBubble: '#f92aad',
    authors: ['#36f9f6', '#72f1b8', '#fede5d', '#ff8b39', '#b893ce', '#fe4450'],
    gradient: ['#fede5d', '#ff8b39', '#f92aad', '#36f9f6'],
  }),
  build({
    name: 'tokyo',
    description: 'City lights: blue and violet on midnight',
    accent: '#7aa2f7',
    accent2: '#bb9af7',
    glow: '#b4c9fb',
    border: '#3b4261',
    dim: '#7c84ad',
    text: '#c8d3f5',
    surface: '#1a1b26',
    success: '#9ece6a',
    warning: '#e0af68',
    error: '#f7768e',
    info: '#7dcfff',
    online: '#9ece6a',
    badge: '#ff9e64',
    mine: '#7aa2f7',
    userBubble: '#7aa2f7',
    authors: ['#bb9af7', '#9ece6a', '#e0af68', '#7dcfff', '#ff9e64', '#f7768e'],
    gradient: ['#7dcfff', '#7aa2f7', '#bb9af7'],
  }),
  build({
    name: 'rose',
    description: 'Soft rose, iris and foam (rosé pine inspired)',
    accent: '#ebbcba',
    accent2: '#c4a7e7',
    glow: '#f6d6d4',
    border: '#403d52',
    dim: '#908caa',
    text: '#e0def4',
    surface: '#191724',
    success: '#9ccfd8',
    warning: '#f6c177',
    error: '#eb6f92',
    info: '#5fa8c6',
    online: '#9ccfd8',
    badge: '#f6c177',
    mine: '#ebbcba',
    userBubble: '#ebbcba',
    authors: ['#c4a7e7', '#9ccfd8', '#f6c177', '#eb6f92', '#5fa8c6', '#e0a3b0'],
    gradient: ['#eb6f92', '#ebbcba', '#c4a7e7'],
  }),
  build({
    name: 'forest',
    description: 'Moss green and gold on deep pine',
    accent: '#5fd38d',
    accent2: '#e6c35c',
    glow: '#a7f3c5',
    border: '#2e5a43',
    dim: '#8fae9a',
    text: '#e8f5e9',
    surface: '#10201a',
    success: '#5fd38d',
    warning: '#e6c35c',
    error: '#ef6f6c',
    info: '#6cc4d9',
    online: '#5fd38d',
    badge: '#e6c35c',
    mine: '#5fd38d',
    userBubble: '#5fd38d',
    authors: ['#e6c35c', '#6cc4d9', '#c39bd3', '#f0a35e', '#9ccc65', '#ef6f6c'],
    gradient: ['#1fa36a', '#5fd38d', '#e6c35c'],
  }),
  build({
    name: 'matrix',
    description: 'Phosphor green raining on black',
    accent: '#00ff41',
    accent2: '#3dffa8',
    glow: '#9dffb0',
    border: '#0d5a1c',
    dim: '#6fbf7e',
    text: '#d4ffd9',
    surface: '#020c04',
    success: '#00ff41',
    warning: '#c8ff00',
    error: '#ff3b3b',
    info: '#3dffa8',
    online: '#00ff41',
    badge: '#c8ff00',
    mine: '#00ff41',
    userBubble: '#00ff41',
    authors: ['#3dffa8', '#c8ff00', '#7dff9a', '#00d4a0', '#a0ff60', '#5effc8'],
    gradient: ['#008f11', '#00ff41', '#9dffb0'],
  }),
]

export const DEFAULT_THEME: Theme = THEMES[0]!

/** Themes from the user's `themes.json`, after the built-in ones. */
let customThemes: readonly Theme[] = []

/** Every theme to choose from: the built-in ones, then the user's own. */
export function allThemes(): readonly Theme[] {
  return [...THEMES, ...customThemes]
}

export function setCustomThemes(themes: readonly Theme[]): void {
  customThemes = themes
}

/** A custom theme: `base`'s tokens with `over` on top, colors exactly as written (no toning), pills re-derived. */
export function customTheme(base: Theme, over: Partial<Base>): Theme {
  const { band: _band, pill: _pill, ...tokens } = base
  return build({ ...tokens, ...over }, false)
}

/** Exact, case-insensitive match over every theme. Unknown names resolve to undefined. */
export function findTheme(name: string): Theme | undefined {
  const wanted = name.trim().toLowerCase()
  return allThemes().find((t) => t.name === wanted)
}

/** `theme` with its accent replaced everywhere the accent shows: text, gutters, bands, accent pills and the logo gradient. */
export function withAccent(theme: Theme, accent: string): Theme {
  return {
    ...theme,
    accent,
    mine: accent,
    userBubble: accent,
    glow: lighten(accent, 0.45),
    // A flat theme stays flat: the new accent replaces its one gradient color.
    gradient: theme.gradient.every((g) => g === theme.gradient[0]) ? [accent, accent] : [accent, theme.accent2],
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
