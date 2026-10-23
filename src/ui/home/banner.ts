/** Wordmark, tagline and sparkline for the Home screen; the colored rows are built in homeRows.ts. */

/** The Pager wordmark: plain letters, spaced out, drawn in the theme gradient. */
export const WORDMARK = 'P A G E R'
/** Frames the left-to-right reveal takes. */
export const REVEAL_FRAMES = 24
export const TAGLINE = 'a simpler way to chat'

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
