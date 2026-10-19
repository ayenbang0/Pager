/** xterm button-event mouse reporting (press, release and drag motion) in SGR encoding; terminals that lack it ignore both. */
export const MOUSE_ON = '\x1b[?1002h\x1b[?1006h'
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l'

// ESC [ < button ; column ; row (M = press or motion, m = release)
const SGR_EVENT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g

/** A 1-based terminal cell. */
export interface Point {
  x: number
  y: number
}

/** A wheel notch and where the pointer was. */
export interface WheelEvent {
  dir: 1 | -1
  at: Point
}

/** Wheel events in a chunk of terminal input: dir +1 = wheel up (toward older), -1 = wheel down. */
export function wheelEvents(chunk: string): WheelEvent[] {
  const out: WheelEvent[] = []
  for (const m of chunk.matchAll(SGR_EVENT)) {
    const button = Number(m[1])
    // Wheel buttons set bit 6 (64 up, 65 down); 66/67 are horizontal. Modifier bits (4, 8, 16) are ignored.
    if (m[4] !== 'M' || (button & 64) === 0 || (button & 2) !== 0) continue
    out.push({ dir: (button & 1) === 0 ? 1 : -1, at: { x: Number(m[2]), y: Number(m[3]) } })
  }
  return out
}

/** A left-button transition at a cell: pressed, moved while held, or released. */
export interface MouseAction extends Point {
  kind: 'down' | 'drag' | 'up'
}

/** Left-button presses, drags and releases in a chunk of terminal input, in order (wheel, other buttons and plain motion are ignored). */
export function mouseEvents(chunk: string): MouseAction[] {
  const out: MouseAction[] = []
  for (const m of chunk.matchAll(SGR_EVENT)) {
    const button = Number(m[1])
    // Left button is 0 in the low two bits; bit 6 is wheel, bit 5 is motion. Modifier bits (4, 8, 16) are ignored.
    if ((button & 64) !== 0 || (button & 3) !== 0) continue
    const x = Number(m[2])
    const y = Number(m[3])
    if (m[4] === 'm') out.push({ kind: 'up', x, y })
    else out.push({ kind: (button & 32) !== 0 ? 'drag' : 'down', x, y })
  }
  return out
}
