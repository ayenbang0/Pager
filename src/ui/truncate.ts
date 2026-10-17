import stringWidth from 'string-width'

/** `text` cut to at most `max` display columns, with a trailing `…` when anything was removed (CJK and emoji count by width). */
export function truncateWidth(text: string, max: number): string {
  if (max <= 0) return ''
  if (stringWidth(text) <= max) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = stringWidth(ch)
    if (used + w > max - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}
