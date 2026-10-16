import { useEffect, useRef } from 'react'
import { MOUSE_OFF, MOUSE_ON, wheelEvents } from './mouse.js'

/**
 * Turns the mouse wheel / trackpad scroll into `onWheel(+1 older | -1 newer)` calls.
 * Enabling mouse reporting means the terminal stops selecting text on a plain drag; hold Shift
 * (Option in iTerm2) to select. PAGER_NO_MOUSE=1 leaves the terminal's own behavior alone.
 */
export function useMouseWheel(onWheel: (direction: 1 | -1) => void): void {
  const latest = useRef(onWheel)
  latest.current = onWheel
  useEffect(() => {
    if (process.env.PAGER_NO_MOUSE === '1') return
    const onData = (chunk: Buffer | string): void => {
      for (const direction of wheelEvents(String(chunk))) latest.current(direction)
    }
    process.stdout.write(MOUSE_ON)
    process.stdin.on('data', onData)
    return () => {
      process.stdin.off('data', onData)
      process.stdout.write(MOUSE_OFF)
    }
  }, [])
}
