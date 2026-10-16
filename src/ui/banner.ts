/** Pure frame renderer for the home-screen PAGER logo. */

const LETTERS: readonly (readonly string[])[] = [
  ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔═══╝ ', '██║     ', '╚═╝     '],
  [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  [' ██████╗ ', '██╔════╝ ', '██║  ███╗', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
]

export const LOGO: readonly string[] = Array.from({ length: 6 }, (_, row) => LETTERS.map((l) => l[row] ?? '').join(''))
export const LOGO_WIDTH = LOGO[0]?.length ?? 0
/** Frames the left-to-right reveal takes. */
export const REVEAL_FRAMES = 24
export const TAGLINE = 'a simpler way to chat'

export interface Seg {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
}

const HEX = /^#[0-9a-f]{6}$/i

/** Blends `#rrggbb` toward `target` by `t` (0..1). */
export function mix(hex: string, target: readonly [number, number, number], t: number): string {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  return `#${channels
    .map((c, i) =>
      Math.round(c + ((target[i] ?? 0) - c) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/**
 * One frame of the logo. The logo is revealed left to right, then a bright diagonal band sweeps across it.
 * Solid blocks use `accent`; the box-drawing shadow is darker. Non-hex accents (ANSI names) fall back to bold/dim.
 * `animate: false` gives the final, static frame.
 */
export function bannerRows(frame: number, accent: string, animate: boolean): Seg[][] {
  const hex = HEX.test(accent)
  const revealed = animate ? Math.floor(LOGO_WIDTH * Math.min(1, frame / REVEAL_FRAMES)) : LOGO_WIDTH
  const band = animate && frame >= REVEAL_FRAMES ? ((frame - REVEAL_FRAMES) * 2) % (LOGO_WIDTH + 30) - 12 : -100
  return LOGO.map((row, r) => {
    const segs: Seg[] = []
    for (let c = 0; c < row.length; c++) {
      const ch = c < revealed ? (row[c] ?? ' ') : ' '
      const edge = animate && frame < REVEAL_FRAMES && c === revealed - 1
      const glow = edge ? 1 : Math.max(0, 1 - Math.abs(c + r - band) / 6)
      const solid = ch === '█'
      const seg: Seg = { text: ch }
      if (ch !== ' ') {
        if (hex) seg.color = solid ? mix(accent, [255, 255, 255], glow * 0.85) : mix(accent, [0, 0, 0], 0.5 - glow * 0.4)
        else {
          seg.color = accent
          seg.bold = glow > 0.5
          seg.dim = !solid && glow <= 0.5
        }
      }
      const last = segs.at(-1)
      if (last && last.color === seg.color && last.bold === seg.bold && last.dim === seg.dim) last.text += ch
      else segs.push(seg)
    }
    return segs
  })
}

/** The tagline typed out after the reveal, with a blinking cursor while animating. */
export function tagline(frame: number, animate: boolean): string {
  if (!animate) return TAGLINE
  const typed = Math.min(TAGLINE.length, Math.max(0, Math.floor((frame - REVEAL_FRAMES) * 1.5)))
  const cursor = Math.floor(frame / 6) % 2 === 0 ? '▌' : ' '
  return TAGLINE.slice(0, typed) + (typed < TAGLINE.length || frame >= REVEAL_FRAMES ? cursor : '')
}

const BARS = '▁▂▃▄▅▆▇█'

/** One bar per value, scaled to the largest; zeros stay on the lowest bar so the row never has gaps. */
export function sparkline(values: readonly number[]): string {
  const max = Math.max(0, ...values)
  return values.map((v) => (max === 0 ? BARS[0] : BARS[Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))])).join('')
}
