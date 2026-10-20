export type Chord = 'prev' | 'next' | 'palette' | 'blocks'
export type Input = { chord: Chord } | { pty: string }
export interface InputModes {
  /** The child enabled application cursor keys (DECCKM). */
  appCursor: boolean
  /** The child asked for focus in/out reports. */
  focus: boolean
}

const CHORDS: Readonly<Record<string, Chord>> = {
  '\x1b[1;3A': 'prev',
  '\x1b\x1b[A': 'prev',
  '\x1b[1;3B': 'next',
  '\x1b\x1b[B': 'next',
  '\x1bp': 'palette',
  '\x1bk': 'blocks',
}

const MOUSE = /\x1b\[<\d+;\d+;\d+[Mm]/g
const FOCUS = /\x1b\[[IO]/g
const CURSOR = /\x1b\[([ABCDHF])/g

/** Splits one raw stdin chunk into a Pager chord or bytes for the shell. Only four Alt chords belong to Pager. */
export function classifyInput(chunk: string, modes: InputModes): Input {
  const chord = CHORDS[chunk]
  if (chord !== undefined) return { chord }
  let out = chunk.replace(MOUSE, '')
  if (!modes.focus) out = out.replace(FOCUS, '')
  if (modes.appCursor) out = out.replace(CURSOR, '\x1bO$1')
  return { pty: out }
}

/** SGR mouse report; x and y are 1-based cells. */
export function encodeMouse(kind: 'press' | 'release' | 'wheelUp' | 'wheelDown', x: number, y: number): string {
  const b = kind === 'wheelUp' ? 64 : kind === 'wheelDown' ? 65 : 0
  return `\x1b[<${b};${x};${y}${kind === 'release' ? 'm' : 'M'}`
}
