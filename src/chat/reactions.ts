import { REACT_PREFIX } from './ops.js'

export const QUICK_REACTIONS = ['👍', '👎', '😂', '🔥', '🎉', '😮', '👀', '💯'] as const

export interface ReactionTarget {
  author: string
  seq: number
}

export interface ParsedReaction extends ReactionTarget {
  op: '+' | '-'
  emoji: string
}

export interface ReactionCount {
  emoji: string
  count: number
  mine: boolean
}

const BODY = /^([+-]):([0-9a-f]{64}):(\d{1,9}):(.+)$/su
const MAX_EMOJI_UNITS = 16
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** One grapheme, at most 16 UTF-16 units, and not a letter, digit, space or control character. */
export function isReactionEmoji(emoji: string): boolean {
  if (emoji.length === 0 || emoji.length > MAX_EMOJI_UNITS) return false
  if ([...segmenter.segment(emoji)].length !== 1) return false
  return !/^[\p{L}\p{N}\s]$/u.test(emoji) && !/\p{Cc}/u.test(emoji)
}

export function encodeReaction(op: '+' | '-', target: ReactionTarget, emoji: string): string {
  return `${REACT_PREFIX}${op}:${target.author}:${target.seq}:${emoji}`
}

/** `body` is a whole event body (prefix included). Undefined when it is not a well-formed reaction. */
export function parseReaction(body: string): ParsedReaction | undefined {
  if (!body.startsWith(REACT_PREFIX)) return undefined
  const m = BODY.exec(body.slice(REACT_PREFIX.length))
  if (m === null) return undefined
  const emoji = m[4] ?? ''
  if (!isReactionEmoji(emoji)) return undefined
  return { op: m[1] as '+' | '-', author: m[2] ?? '', seq: Number(m[3]), emoji }
}

/**
 * Folds reaction events (ordered by author, then seq) into what each message shows: `+` adds the reactor to an emoji, `-` removes
 * them. Keys are `${author}:${seq}` of the message reacted to; each list is sorted by count (high first), then emoji.
 */
export function foldReactions(events: readonly { author: string; seq: number; body: string }[], me: string): Map<string, ReactionCount[]> {
  const sets = new Map<string, Map<string, Set<string>>>()
  for (const ev of events) {
    const r = parseReaction(ev.body)
    if (r === undefined) continue
    const key = `${r.author}:${r.seq}`
    let byEmoji = sets.get(key)
    if (byEmoji === undefined) sets.set(key, (byEmoji = new Map()))
    let who = byEmoji.get(r.emoji)
    if (who === undefined) byEmoji.set(r.emoji, (who = new Set()))
    if (r.op === '+') who.add(ev.author)
    else who.delete(ev.author)
  }
  const out = new Map<string, ReactionCount[]>()
  for (const [key, byEmoji] of sets) {
    const list = [...byEmoji].filter(([, who]) => who.size > 0).map(([emoji, who]): ReactionCount => ({ emoji, count: who.size, mine: who.has(me) }))
    if (list.length === 0) continue
    list.sort((a, b) => b.count - a.count || (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0))
    out.set(key, list)
  }
  return out
}
