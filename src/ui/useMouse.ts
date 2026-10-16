import { useEffect, useRef } from 'react'
import { type Click, clickEvents, MOUSE_OFF, MOUSE_ON, wheelEvents } from './mouse.js'

export interface MouseHandlers {
  /** +1 = wheel up (toward older), -1 = wheel down. */
  onWheel(direction: 1 | -1): void
  onClick(click: Click): void
}

/**
 * Turns the mouse wheel / trackpad scroll and left clicks into handler calls.
 * Enabling mouse reporting means the terminal stops selecting text on a plain drag; hold Shift
 * (Option in iTerm2) to select. PAGER_NO_MOUSE=1 leaves the terminal's own behavior alone.
 */
export function useMouse(handlers: MouseHandlers): void {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    if (process.env.PAGER_NO_MOUSE === '1') return
    const onData = (chunk: Buffer | string): void => {
      const text = String(chunk)
      for (const direction of wheelEvents(text)) latest.current.onWheel(direction)
      for (const click of clickEvents(text)) latest.current.onClick(click)
    }
    process.stdout.write(MOUSE_ON)
    process.stdin.on('data', onData)
    return () => {
      process.stdin.off('data', onData)
      process.stdout.write(MOUSE_OFF)
    }
  }, [])
}
