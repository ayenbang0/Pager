/** xterm mouse reporting (press events only) in SGR encoding; terminals that lack it ignore both. */
export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h'
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l'

// ESC [ < button ; column ; row M
const SGR_PRESS = /\x1b\[<(\d+);(\d+);(\d+)M/g

/** Wheel events in a chunk of terminal input: +1 = wheel up (toward older), -1 = wheel down. */
export function wheelEvents(chunk: string): (1 | -1)[] {
  const out: (1 | -1)[] = []
  for (const m of chunk.matchAll(SGR_PRESS)) {
    const button = Number(m[1])
    // Wheel buttons set bit 6 (64 up, 65 down); 66/67 are horizontal. Modifier bits (4, 8, 16) are ignored.
    if ((button & 64) === 0 || (button & 2) !== 0) continue
    out.push((button & 1) === 0 ? 1 : -1)
  }
  return out
}

/** A left-button press at a 1-based terminal cell. */
export interface Click {
  x: number
  y: number
}

/** Left clicks in a chunk of terminal input (wheel, other buttons, motion and releases are ignored). */
export function clickEvents(chunk: string): Click[] {
  const out: Click[] = []
  for (const m of chunk.matchAll(SGR_PRESS)) {
    const button = Number(m[1])
    // Left button is 0; bit 6 is wheel, bit 5 is motion. Modifier bits (4, 8, 16) are ignored.
    if ((button & 64) !== 0 || (button & 32) !== 0 || (button & 3) !== 0) continue
    out.push({ x: Number(m[2]), y: Number(m[3]) })
  }
  return out
}
