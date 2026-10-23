import type { Place } from './chrome.js'

export type TitleState = 'idle' | 'working' | 'attention'
export const TITLE_FRAME_MS = 80
/** Braille spinner; every frame is one column wide so the title never reflows. */
export const TITLE_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const MAX_LABEL = 40

export interface TitleInput {
  state: TitleState
  frame: number
  unread: number
  label: string
}

/** Where you are, with the glyph the tab bar and sidebar already use for it. */
export function titleLabel(place: Place, online: boolean): string {
  switch (place.kind) {
    case 'home':
      return '⌂ home'
    case 'dm':
      return `${online ? '●' : '○'} ${place.title}`
    case 'group':
      return `# ${place.title}`
    case 'hub':
      return '⌁ agents'
    case 'agent':
      return `⌁ ${place.title}`
    case 'terminal':
      return '▸ terminal'
    case 'docs':
      return `▤ ${place.title === '' ? 'docs' : place.title}`
    case 'shared':
      return `◈ ${place.title}'s agents`
    case 'settings':
      return '⚙ settings'
    case 'ai':
      return '✦ ai'
  }
}

/** `(3) ◆ pager ⠹ ● bob`: unread count (99+ above 99), brand, the run-state separator (spinner / `!` / `>`), then where you are. Control characters are replaced and the label is cut to 40 characters. */
export function buildTitle(i: TitleInput): string {
  const sep = i.state === 'working' ? (TITLE_SPINNER[i.frame % TITLE_SPINNER.length] ?? '>') : i.state === 'attention' ? '!' : '>'
  const unread = i.unread > 0 ? `(${i.unread > 99 ? '99+' : i.unread}) ` : ''
  const label = [...i.label.replace(/\p{Cc}/gu, ' ').trim()].slice(0, MAX_LABEL).join('')
  return `${unread}◆ pager ${sep}${label === '' ? '' : ` ${label}`}`
}

let held = false
let last = ''
let original = ''

/** Writes the title (repeats are dropped). Windows: `process.title`, which becomes SetConsoleTitleW and sends nothing through the terminal stream; elsewhere (or if that throws) OSC 0. */
export function setWindowTitle(title: string): void {
  if (!held || title === last) return
  last = title
  if (process.platform === 'win32') {
    try {
      process.title = title
      return
    } catch {
      // fall through to the escape sequence
    }
  }
  process.stdout.write(`\x1b]0;${title}\x07`)
}

/** Takes the title over: remembers the console title (Windows) and pushes the terminal's title stack (xterm window op 22). */
export function holdWindowTitle(): void {
  if (held || !process.stdout.isTTY) return
  held = true
  last = ''
  original = process.platform === 'win32' ? process.title : ''
  process.stdout.write('\x1b[22;2t')
}

/** Gives the title back: the saved console title on Windows, else an empty title, then pops the title stack (xterm window op 23) where supported. */
export function restoreWindowTitle(): void {
  if (!held) return
  held = false
  if (process.platform === 'win32' && original !== '') {
    try {
      process.title = original
    } catch {
      process.stdout.write('\x1b]0;\x07')
    }
  } else process.stdout.write('\x1b]0;\x07')
  process.stdout.write('\x1b[23;2t')
}
