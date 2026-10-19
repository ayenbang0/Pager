/** Color parsing and math shared by themes, settings and the UI. Colors are Ink strings: an ANSI name (`cyan`, `redBright`) or `#rrggbb`. */
export type Rgb = readonly [number, number, number]

/** The names Ink (chalk) accepts, with the approximate RGB of a stock xterm palette (terminals differ; used for contrast and snapping only). */
const ANSI_RGB: Record<string, Rgb> = {
  black: [0, 0, 0],
  red: [205, 0, 0],
  green: [0, 205, 0],
  yellow: [205, 205, 0],
  blue: [0, 0, 238],
  magenta: [205, 0, 205],
  cyan: [0, 205, 205],
  white: [229, 229, 229],
  gray: [127, 127, 127],
  grey: [127, 127, 127],
  blackBright: [127, 127, 127],
  redBright: [255, 0, 0],
  greenBright: [0, 255, 0],
  yellowBright: [255, 255, 0],
  blueBright: [92, 92, 255],
  magentaBright: [255, 0, 255],
  cyanBright: [0, 255, 255],
  whiteBright: [255, 255, 255],
}

/** Friendly names for `/accent` and `/agent color`; they resolve to a hex value. */
const FRIENDLY: Record<string, string> = {
  orange: '#ff8a00',
  pink: '#ff4fa3',
  hotpink: '#ff2e93',
  purple: '#a855f7',
  violet: '#8b5cf6',
  lime: '#a3ff12',
  teal: '#14d8c4',
  gold: '#ffc400',
  coral: '#ff6b57',
  mint: '#3dffb0',
  sky: '#4cc9ff',
  indigo: '#6366f1',
  crimson: '#ff3355',
  rose: '#ff5c8a',
  aqua: '#00f0ff',
  amber: '#ffbf00',
}

const SIXTEEN = Object.keys(ANSI_RGB).filter((n) => n !== 'grey')
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/** Every name `/accent` and `/agent color` understand, for menus and error messages. */
export const COLOR_WORDS: readonly string[] = [...Object.keys(FRIENDLY), 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

/** A user-supplied color to its stored form (`#rrggbb` or an Ink name), or undefined when it is not a color. */
export function parseColor(input: string): string | undefined {
  const raw = input.trim()
  const hex = HEX.exec(raw)?.[1]
  if (hex !== undefined && (raw.startsWith('#') || hex.length === 6)) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
    return `#${full.toLowerCase()}`
  }
  const lower = raw.toLowerCase()
  if (Object.hasOwn(FRIENDLY, lower)) return FRIENDLY[lower]
  return SIXTEEN.find((n) => n.toLowerCase() === lower) ?? (lower === 'grey' ? 'gray' : undefined)
}

export function toRgb(color: string): Rgb | undefined {
  if (color.startsWith('#') && color.length === 7) {
    const n = Number.parseInt(color.slice(1), 16)
    return Number.isNaN(n) ? undefined : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  return Object.hasOwn(ANSI_RGB, color) ? ANSI_RGB[color] : undefined
}

export const toHex = ([r, g, b]: Rgb): string => `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`

/** WCAG relative luminance, 0..1. */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio, 1..21. Unknown colors compare as 1. */
export function contrast(a: string, b: string): number {
  const ra = toRgb(a)
  const rb = toRgb(b)
  if (ra === undefined || rb === undefined) return 1
  const [hi, lo] = [luminance(ra), luminance(rb)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

/** Text color that reads on `bg`: near-black or white (Ink names when `bg` is a name, so 16-color terminals keep their own black and white). */
export function readableOn(bg: string): string {
  const [darkFg = 'black', lightFg = 'white'] = bg.startsWith('#') ? ['#06080c', '#ffffff'] : ['black', 'white']
  return contrast(bg, darkFg) >= contrast(bg, lightFg) ? darkFg : lightFg
}

/** `t` of the way from `a` to `b` (0..1). If either is not a known color the nearer one is returned unchanged. */
export function mix(a: string, b: string, t: number): string {
  const ra = toRgb(a)
  const rb = toRgb(b)
  if (ra === undefined || rb === undefined) return t < 0.5 ? a : b
  return toHex([ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t, ra[2] + (rb[2] - ra[2]) * t])
}

/** The color at `t` (0..1) along evenly spaced stops. Named stops blend through their stock palette values; a stop that is not a color switches at the midpoint. */
export function gradientAt(stops: readonly string[], t: number): string {
  const first = stops[0] ?? 'white'
  if (stops.length < 2) return first
  const scaled = Math.min(1, Math.max(0, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(scaled))
  return mix(stops[i] ?? first, stops[i + 1] ?? first, scaled - i)
}

/** The nearest of the 16 ANSI colors, for terminals that cannot show more. */
export function snapAnsi(color: string): string {
  const rgb = toRgb(color)
  if (rgb === undefined) return color
  let best = 'white'
  let bestDistance = Number.POSITIVE_INFINITY
  for (const name of SIXTEEN) {
    const c = ANSI_RGB[name]
    if (c === undefined) continue
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2
    if (d < bestDistance) {
      best = name
      bestDistance = d
    }
  }
  return best
}

/** Brighter by `amount` (0..1) toward white; names are returned as given. */
export const lighten = (color: string, amount: number): string => (toRgb(color) === undefined || !color.startsWith('#') ? color : mix(color, '#ffffff', amount))
