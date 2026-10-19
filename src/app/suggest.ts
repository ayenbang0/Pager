/** Words as people type them: letters, digits and in-word apostrophes/hyphens. Punctuation is not part of a word. */
const WORD = /[\p{L}\p{N}'’_-]+/gu
const PARTIAL = /([\p{L}\p{N}'’_-]*)$/u
const MAX_WORD = 40
/** How many words past the completed one a suggestion may run on. */
const MAX_CHAIN = 3

/**
 * Learns from what the user types and suggests the rest of the line. Two layers, most specific first:
 * a whole earlier line with the same start (most-used, then most recent), else the current word
 * completed from the user's own vocabulary and extended by the words they usually put after it.
 */
export class Suggester {
  private readonly lines = new Map<string, { count: number; last: number }>()
  private readonly words = new Map<string, number>()
  /** Most recent spelling of each lowercase word, so suggestions keep the user's capitalisation. */
  private readonly forms = new Map<string, string>()
  private readonly next = new Map<string, Map<string, number>>()
  private tick = 0

  /** Teach it one line the user sent or ran, oldest first. `words: false` learns the whole line only (shell commands). */
  learn(line: string, words = true): void {
    const text = line.trim()
    if (text === '') return
    const entry = this.lines.get(text)
    this.lines.set(text, { count: (entry?.count ?? 0) + 1, last: this.tick++ })
    if (text.startsWith('/') || !words) return
    let prev: string | undefined
    for (const [raw] of text.matchAll(WORD)) {
      if (raw.length > MAX_WORD) {
        prev = undefined
        continue
      }
      const word = raw.toLowerCase()
      this.words.set(word, (this.words.get(word) ?? 0) + 1)
      this.forms.set(word, raw)
      if (prev !== undefined) {
        const after = this.next.get(prev) ?? new Map<string, number>()
        after.set(word, (after.get(word) ?? 0) + 1)
        this.next.set(prev, after)
      }
      prev = word
    }
  }

  /** The text to append after `text`, or '' when it has nothing worth offering. */
  complete(text: string): string {
    if (text === '' || text.trim() === '') return ''
    const line = this.completeLine(text)
    if (line !== '' || text.startsWith('/')) return line
    return this.completeWords(text)
  }

  private completeLine(text: string): string {
    let best: string | undefined
    let bestScore = { count: 0, last: -1 }
    for (const [line, score] of this.lines) {
      if (line.length <= text.length || !line.startsWith(text)) continue
      if (score.count > bestScore.count || (score.count === bestScore.count && score.last > bestScore.last)) {
        best = line
        bestScore = score
      }
    }
    return best === undefined ? '' : best.slice(text.length)
  }

  private completeWords(text: string): string {
    const partial = PARTIAL.exec(text)?.[1] ?? ''
    if (partial === '' && !/\s$/.test(text)) return ''
    const before = text.slice(0, text.length - partial.length)
    const prev = [...before.matchAll(WORD)].at(-1)?.[0].toLowerCase()
    let current = prev
    let out = ''
    if (partial !== '') {
      const lower = partial.toLowerCase()
      const follow = prev === undefined ? undefined : this.next.get(prev)
      let pick: string | undefined
      let pickScore = 0
      for (const [word, count] of this.words) {
        if (word.length <= lower.length || !word.startsWith(lower)) continue
        const score = (follow?.get(word) ?? 0) * 10 + count
        // A word seen once is not a habit unless it also follows the previous word.
        if (count < 2 && (follow?.get(word) ?? 0) === 0) continue
        if (score > pickScore) {
          pick = word
          pickScore = score
        }
      }
      if (pick === undefined) return ''
      out = (this.forms.get(pick) ?? pick).slice(partial.length)
      current = pick
    }
    for (let i = 0; i < MAX_CHAIN && current !== undefined; i++) {
      const succ = this.topSuccessor(current)
      if (succ === undefined) break
      out += `${out === '' && partial === '' ? '' : ' '}${this.forms.get(succ) ?? succ}`
      current = succ
    }
    return out
  }

  /** The word most often typed after `word`, if that has happened at least twice. */
  private topSuccessor(word: string): string | undefined {
    let best: string | undefined
    let bestCount = 1
    for (const [w, count] of this.next.get(word) ?? []) {
      if (count > bestCount) {
        best = w
        bestCount = count
      }
    }
    return best
  }
}
