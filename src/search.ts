import fs from 'node:fs'
import { isRecord } from './guards.js'

/** Only the newest this-many messages are scanned, however big the history is. */
export const SEARCH_SCAN_LIMIT = 20_000
/** How many hits `/search` shows (newest first). */
export const SEARCH_MAX_HITS = 20
/** Width of the text around a match. */
export const SNIPPET_WIDTH = 80
/** The agent room transcript is read from its last this-many lines. */
const ROOM_SCAN_LINES = 2000

/** A searchable message: `where` is the conversation label (`team`, `alice`, `agents`). */
export interface SearchDoc {
  where: string
  author: string
  ts: number
  text: string
}

export interface SearchHit extends SearchDoc {
  snippet: string
}

export interface SearchResult {
  /** The newest matches, newest first, at most `limit`. */
  hits: SearchHit[]
  /** Every match inside the scanned window. */
  total: number
}

/** One line of `agents-room.jsonl`, reduced to what search and recap read. */
export interface RoomLine {
  ts: number
  author: string
  kind: 'text' | 'system'
  text: string
  /** Set for a guest of a shared session. */
  pk?: string
}

/** Whitespace runs collapsed to one space: search ignores line breaks. */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** `text` around the first match of `query` (case-insensitive), at most `width` characters plus an ellipsis at each cut end. */
export function snippetAround(text: string, query: string, width = SNIPPET_WIDTH): string {
  const flat = squash(text)
  const q = squash(query).toLowerCase()
  if (flat.length <= width) return flat
  const at = Math.max(0, flat.toLowerCase().indexOf(q))
  let start = Math.max(0, at - Math.floor(Math.max(0, width - q.length) / 2))
  const end = Math.min(flat.length, start + width)
  start = Math.max(0, end - width)
  const cut = (i: number): number => (i > 0 && i < flat.length && /[\uDC00-\uDFFF]/.test(flat[i] ?? '') ? i + 1 : i)
  const from = cut(start)
  const to = cut(end)
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`
}

/**
 * Case-insensitive substring search, newest first. The wanted text is literal (`%`, `_`, `\` and regex characters mean nothing).
 * Only the newest `scan` documents are looked at, so a huge history stays cheap.
 */
export function searchDocs(docs: Iterable<SearchDoc>, query: string, opts: { limit?: number; scan?: number } = {}): SearchResult {
  const limit = opts.limit ?? SEARCH_MAX_HITS
  const scan = opts.scan ?? SEARCH_SCAN_LIMIT
  const q = squash(query).toLowerCase()
  if (q === '') return { hits: [], total: 0 }
  const window = [...docs].map((doc, i) => ({ doc, i })).sort((a, b) => b.doc.ts - a.doc.ts || b.i - a.i).slice(0, scan)
  const hits: SearchHit[] = []
  let total = 0
  for (const { doc } of window) {
    if (!squash(doc.text).toLowerCase().includes(q)) continue
    total++
    if (hits.length < limit) hits.push({ ...doc, snippet: snippetAround(doc.text, query) })
  }
  return { hits, total }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `14:05` for today, `2026-10-17 14:05` for any other day (local time). */
export function formatWhen(ts: number, now: number): string {
  const d = new Date(ts)
  const n = new Date(now)
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return clock
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`
}

/** The `/search` result block: a header, then `[conversation] author, time: snippet` per hit. */
export function formatSearch(query: string, result: SearchResult, now: number): string[] {
  const q = squash(query)
  if (result.total === 0) return [`No matches for "${q}"`]
  const more = result.total > result.hits.length ? `, showing the newest ${result.hits.length}` : ''
  return [
    `Search "${q}": ${result.total} ${result.total === 1 ? 'match' : 'matches'}${more}`,
    '',
    ...result.hits.map((h) => `[${h.where}] ${h.author}, ${formatWhen(h.ts, now)}: ${h.snippet}`),
  ]
}

/** The tail of the agent room transcript; unreadable files and corrupt lines yield nothing. */
export function readRoomLines(file: string, maxLines = ROOM_SCAN_LINES): RoomLine[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: RoomLine[] = []
  for (const line of raw.split('\n').filter((l) => l.trim() !== '').slice(-maxLines)) {
    let x: unknown
    try {
      x = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(x)) continue
    const { ts, author, kind, text, pk } = x
    if (typeof ts !== 'number' || !Number.isFinite(ts) || typeof author !== 'string' || typeof text !== 'string') continue
    if (kind !== 'text' && kind !== 'system') continue
    out.push({ ts, author, kind, text, ...(typeof pk === 'string' ? { pk } : {}) })
  }
  return out
}
