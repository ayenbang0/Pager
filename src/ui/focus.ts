/** xterm focus reporting: the terminal sends ESC [ I on focus and ESC [ O on blur. */
export const FOCUS_ON = '\x1b[?1004h'
export const FOCUS_OFF = '\x1b[?1004l'

/** Focus changes in a chunk of terminal input, in order (true = gained focus). */
export function focusEvents(chunk: string): boolean[] {
  return [...chunk.matchAll(/\x1b\[([IO])/g)].map((m) => m[1] === 'I')
}
