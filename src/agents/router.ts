/** A message is forwarded to a busy teammate when its relevance reaches this score. */
export const FORWARD_THRESHOLD = 2

const FILE_WEIGHT = 3
const REASON_ITEMS = 3
const MENTION_RE = /(?<![\w@])@([a-z][a-z0-9_-]{1,23})\b/gi
const CODE_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g
const WORD_RE = /[\p{L}\p{N}_]+/gu

const STOPWORDS: Record<string, true> = Object.fromEntries(
  (
    'that this with from have will would could should there their they them then than what when where which while about after before ' +
    'been being were your yours just like make made more most much need only other some such take into over also here does done going ' +
    'want please still very well work working thing things because every each again'
  )
    .split(' ')
    .map((w) => [w, true]),
)

/**
 * Teammates named with `@name` anywhere in the text. `@all` means every name. Mentions inside code are ignored,
 * and so is the chain syntax `@a>b`, which the caller parses itself.
 */
export function parseMentions(text: string, names: string[]): { targets: string[]; unknown: string[] } {
  const prose = text.replace(CODE_RE, (code) => ' '.repeat(code.length))
  const targets: string[] = []
  const unknown: string[] = []
  for (const m of prose.matchAll(MENTION_RE)) {
    const word = (m[1] ?? '').toLowerCase()
    const next = prose.slice(m.index + m[0].length, m.index + m[0].length + 2)
    if (next[0] === '>' && /\w/.test(next[1] ?? '')) continue
    if (word === 'all') {
      for (const name of names) if (!targets.includes(name)) targets.push(name)
    } else if (names.includes(word)) {
      if (!targets.includes(word)) targets.push(word)
    } else if (!unknown.includes(word)) {
      unknown.push(word)
    }
  }
  return { targets, unknown }
}

function keywords(text: string): Set<string> {
  const out = new Set<string>()
  for (const [word] of text.toLowerCase().matchAll(WORD_RE)) {
    if (word.length >= 4 && !/^\d+$/.test(word) && !Object.hasOwn(STOPWORDS, word)) out.add(word)
  }
  return out
}

/**
 * How much a message touches what a teammate is working on: 3 per changed file it names, plus 1 per
 * meaningful word it shares with the teammate's task. `reason` says what matched, for the forwarded note.
 */
export function relevance(text: string, w: { task: string; files: string[] }): { score: number; reason: string } {
  const lower = text.toLowerCase()
  const hitFiles: string[] = []
  for (const file of w.files) {
    const base = file.split(/[\\/]/).pop() ?? ''
    if (base !== '' && !hitFiles.includes(base) && lower.includes(base.toLowerCase())) hitFiles.push(base)
  }
  const mine = keywords(w.task)
  const shared = [...keywords(text)].filter((word) => mine.has(word))
  const parts: string[] = []
  if (hitFiles.length > 0) parts.push(`file ${hitFiles.slice(0, REASON_ITEMS).join(', ')}`)
  if (shared.length > 0) parts.push(`task words ${shared.slice(0, REASON_ITEMS).join(', ')}`)
  return { score: FILE_WEIGHT * hitFiles.length + shared.length, reason: parts.join('; ') }
}
