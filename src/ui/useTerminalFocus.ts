import { useEffect, useState } from 'react'
import { FOCUS_OFF, FOCUS_ON, focusEvents } from './focus.js'

/**
 * Whether the terminal has focus. Terminals that do not report focus never send an event, so this
 * stays true and nothing downstream rings. PAGER_NO_NOTIFY=1 disables the subscription.
 */
export function useTerminalFocus(): boolean {
  const [focused, setFocused] = useState(true)
  useEffect(() => {
    if (process.env.PAGER_NO_NOTIFY === '1') return
    const onData = (chunk: Buffer | string): void => {
      const last = focusEvents(String(chunk)).at(-1)
      if (last !== undefined) setFocused(last)
    }
    process.stdout.write(FOCUS_ON)
    process.stdin.on('data', onData)
    return () => {
      process.stdin.off('data', onData)
      process.stdout.write(FOCUS_OFF)
    }
  }, [])
  return focused
}
