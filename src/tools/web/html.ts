const MAX_TEXT = 20_000

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, name: string) => {
    const lower = name.toLowerCase()
    if (Object.hasOwn(NAMED, lower)) return NAMED[lower] ?? all
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : lower.startsWith('#') ? Number.parseInt(lower.slice(1), 10) : NaN
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all
    return String.fromCodePoint(code)
  })
}

/** Page HTML as plain text: scripts and styles dropped, block tags become newlines, entities decoded, control characters removed, 20,000 characters at most. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(text)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\p{Cc}/gu, (c) => (c === '\n' ? c : ''))
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT)
}

/** Text from the web with control characters replaced, for one line of output. */
export const scrub = (s: string): string => s.replace(/\p{Cc}/gu, ' ')
