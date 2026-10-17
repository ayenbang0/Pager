import { useEffect, useRef } from 'react'
import { buildTitle, holdWindowTitle, restoreWindowTitle, setWindowTitle, TITLE_FRAME_MS, type TitleInput } from './windowTitle.js'

/** Keeps the window title current; while `state` is `working` it advances the spinner every TITLE_FRAME_MS without re-rendering anything. */
export function useWindowTitle({ state, unread, label }: Omit<TitleInput, 'frame'>): void {
  const frame = useRef(0)
  useEffect(() => {
    holdWindowTitle()
    return restoreWindowTitle
  }, [])
  useEffect(() => {
    const show = (): void => setWindowTitle(buildTitle({ state, unread, label, frame: frame.current }))
    show()
    if (state !== 'working') return
    const timer = setInterval(() => {
      frame.current += 1
      show()
    }, TITLE_FRAME_MS)
    timer.unref()
    return () => clearInterval(timer)
  }, [state, unread, label])
}
