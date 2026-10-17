/** Shared key handling for the picker overlays (agent setup, model, questions). Pure so the reducers can be tested without a terminal. */

/** The part of Ink's `Key` the pickers read; Ink's own object is assignable to it. */
export interface Press {
  input: string
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  return?: boolean
  escape?: boolean
  tab?: boolean
  shift?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  meta?: boolean
}

/** Moves `index` by `delta` inside a list of `count` rows, wrapping at both ends. */
export function wrapIndex(index: number, delta: number, count: number): number {
  return count <= 0 ? 0 : (((index + delta) % count) + count) % count
}

/** Move up/down for a key press: -1, 1, or 0 when the key is neither. Shift+Tab counts as up and Tab as down only when `tabs` is set. */
export function stepOf(p: Press, tabs = false): -1 | 0 | 1 {
  if (p.upArrow === true) return -1
  if (p.downArrow === true) return 1
  if (tabs && p.tab === true) return p.shift === true ? -1 : 1
  return 0
}

/** The characters this press types, or '' for chords and control keys. */
export function typed(p: Press): string {
  if (p.ctrl === true || p.meta === true || p.input === '') return ''
  // Escape sequences and control bytes never type.
  return /[\u0000-\u001f\u007f]/.test(p.input) ? '' : p.input
}

/**
 * The text after applying a text-field edit key: printable characters append, Backspace removes the last character,
 * Ctrl+U clears. Undefined when the key does not edit, so callers can fall through to navigation.
 */
export function editedText(text: string, p: Press): string | undefined {
  if (p.backspace === true || p.delete === true) return [...text].slice(0, -1).join('')
  if (p.ctrl === true && p.input === 'u') return ''
  const chars = typed(p)
  return chars === '' ? undefined : text + chars
}
