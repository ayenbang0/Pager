/** xterm focus reporting: the terminal sends ESC [ I on focus and ESC [ O on blur. */
export const FOCUS_ON = '\x1b[?1004h'
export const FOCUS_OFF = '\x1b[?1004l'

/** Focus changes in a chunk of terminal input, in order (true = gained focus). */
export function focusEvents(chunk: string): boolean[] {
  return [...chunk.matchAll(/\x1b\[([IO])/g)].map((m) => m[1] === 'I')
}

const clean = (s: string): string => s.replace(/[\p{Cc};]/gu, ' ').slice(0, 120)

/**
 * The desktop-notification escape sequence for this terminal, or '' when it has none that is known to
 * work (Windows Terminal relies on the bell and taskbar flash instead).
 */
export function notifySequence(env: NodeJS.ProcessEnv, title: string, body: string): string {
  const program = env.TERM_PROGRAM ?? ''
  if (program === 'iTerm.app') return `\x1b]9;${clean(`${title}: ${body}`)}\x07`
  if (program === 'ghostty' || program === 'WezTerm') return `\x1b]777;notify;${clean(title)};${clean(body)}\x07`
  return ''
}
