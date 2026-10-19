import { useEffect, useState } from 'react'
import { FOCUS_OFF, FOCUS_ON, focusEvents } from '../input/focus.js'

export interface TerminalFocus {
  focused: boolean
  /** At least one focus report arrived: the terminal does report focus, so `focused` can be believed. */
  reported: boolean
}

/**
 * Whether the terminal has focus. Terminals that do not report focus never send an event, so this stays focused and
 * `reported` stays false (callers must not act on `focused` alone). PAGER_NO_NOTIFY=1 disables the subscription.
 */
export function useTerminalFocus(): TerminalFocus {
  const [state, setState] = useState<TerminalFocus>({ focused: true, reported: false })
  useEffect(() => {
    if (process.env.PAGER_NO_NOTIFY === '1') return
    const onData = (chunk: Buffer | string): void => {
      const last = focusEvents(String(chunk)).at(-1)
      if (last !== undefined) setState({ focused: last, reported: true })
    }
    process.stdout.write(FOCUS_ON)
    process.stdin.on('data', onData)
    return () => {
      process.stdin.off('data', onData)
      process.stdout.write(FOCUS_OFF)
    }
  }, [])
  return state
}
