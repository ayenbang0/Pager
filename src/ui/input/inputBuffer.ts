/** Immutable single-line edit buffer. `cursor` is a UTF-16 index always on a grapheme boundary. */
export interface InputBuffer {
  text: string
  cursor: number
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function prevBoundary(text: string, cursor: number): number {
  let prev = 0
  for (const { index } of segmenter.segment(text)) {
    if (index >= cursor) break
    prev = index
  }
  return prev
}

function nextBoundary(text: string, cursor: number): number {
  for (const { index } of segmenter.segment(text)) {
    if (index > cursor) return index
  }
  return text.length
}

export const emptyInput: InputBuffer = { text: '', cursor: 0 }

/** Newlines and tabs become one space; other control characters are dropped. */
export function insert(buf: InputBuffer, s: string): InputBuffer {
  const clean = s.replace(/\r\n|[\r\n\t]/g, ' ').replace(/\p{Cc}/gu, '')
  if (clean === '') return buf
  return { text: buf.text.slice(0, buf.cursor) + clean + buf.text.slice(buf.cursor), cursor: buf.cursor + clean.length }
}

export function backspace(buf: InputBuffer): InputBuffer {
  if (buf.cursor === 0) return buf
  const start = prevBoundary(buf.text, buf.cursor)
  return { text: buf.text.slice(0, start) + buf.text.slice(buf.cursor), cursor: start }
}

export function deleteForward(buf: InputBuffer): InputBuffer {
  if (buf.cursor >= buf.text.length) return buf
  const end = nextBoundary(buf.text, buf.cursor)
  return { text: buf.text.slice(0, buf.cursor) + buf.text.slice(end), cursor: buf.cursor }
}

export function moveLeft(buf: InputBuffer): InputBuffer {
  return { ...buf, cursor: prevBoundary(buf.text, buf.cursor) }
}

export function moveRight(buf: InputBuffer): InputBuffer {
  return { ...buf, cursor: nextBoundary(buf.text, buf.cursor) }
}

export function home(buf: InputBuffer): InputBuffer {
  return { ...buf, cursor: 0 }
}

export function end(buf: InputBuffer): InputBuffer {
  return { ...buf, cursor: buf.text.length }
}

export function deleteWordBack(buf: InputBuffer): InputBuffer {
  let i = buf.cursor
  while (i > 0 && /\s/.test(buf.text[i - 1] ?? '')) i--
  while (i > 0 && !/\s/.test(buf.text[i - 1] ?? '')) i--
  return { text: buf.text.slice(0, i) + buf.text.slice(buf.cursor), cursor: i }
}

/** Replaces the whole line, cursor at the end. */
export function setText(text: string): InputBuffer {
  return { text, cursor: text.length }
}

/** Swaps `text[from, to)` for `insertion`, cursor just after it; the text on either side stays. */
export function replaceRange(buf: InputBuffer, from: number, to: number, insertion: string): InputBuffer {
  return { text: buf.text.slice(0, from) + insertion + buf.text.slice(to), cursor: from + insertion.length }
}

/** The text before the cursor, the grapheme under it ('' at end), and the rest. */
export function splitAtCursor(buf: InputBuffer): { before: string; at: string; after: string } {
  const stop = nextBoundary(buf.text, buf.cursor)
  return { before: buf.text.slice(0, buf.cursor), at: buf.text.slice(buf.cursor, stop), after: buf.text.slice(stop) }
}

/** Cursor to the start of the previous word. */
export function moveWordLeft(buf: InputBuffer): InputBuffer {
  let i = buf.cursor
  while (i > 0 && /\s/.test(buf.text[i - 1] ?? '')) i--
  while (i > 0 && !/\s/.test(buf.text[i - 1] ?? '')) i--
  return { ...buf, cursor: i }
}

/** Cursor to the end of the next word. */
export function moveWordRight(buf: InputBuffer): InputBuffer {
  let i = buf.cursor
  while (i < buf.text.length && /\s/.test(buf.text[i] ?? '')) i++
  while (i < buf.text.length && !/\s/.test(buf.text[i] ?? '')) i++
  return { ...buf, cursor: i }
}

export function deleteToEnd(buf: InputBuffer): InputBuffer {
  return { text: buf.text.slice(0, buf.cursor), cursor: buf.cursor }
}

export function deleteToStart(buf: InputBuffer): InputBuffer {
  return { text: buf.text.slice(buf.cursor), cursor: 0 }
}
