import { useEffect, useRef } from 'react'
import { MOUSE_OFF, MOUSE_ON, mouseEvents, wheelEvents, type Point } from './mouse.js'

export interface MouseHandlers {
  /** +1 = wheel up (toward older), -1 = wheel down. */
  onWheel(direction: 1 | -1): void
  /** Left button went down at this cell. */
  onPress(at: Point): void
  /** The pointer moved to this cell with the left button held. */
  onDrag(at: Point): void
  /** Left button came up at this cell. */
  onRelease(at: Point): void
}

/**
 * Turns the mouse wheel / trackpad scroll and the left button (press, drag, release) into handler calls.
 * Enabling mouse reporting means the terminal stops selecting text on a plain drag; pager draws its own
 * selection and copies it, and the terminal's own selection still works with Shift (Option in iTerm2).
 * PAGER_NO_MOUSE=1 leaves the terminal's own behavior alone.
 */
export function useMouse(handlers: MouseHandlers): void {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    if (process.env.PAGER_NO_MOUSE === '1') return
    const onData = (chunk: Buffer | string): void => {
      const text = String(chunk)
      for (const direction of wheelEvents(text)) latest.current.onWheel(direction)
      for (const action of mouseEvents(text)) {
        if (action.kind === 'down') latest.current.onPress(action)
        else if (action.kind === 'drag') latest.current.onDrag(action)
        else latest.current.onRelease(action)
      }
    }
    process.stdout.write(MOUSE_ON)
    process.stdin.on('data', onData)
    return () => {
      process.stdin.off('data', onData)
      process.stdout.write(MOUSE_OFF)
    }
  }, [])
}
