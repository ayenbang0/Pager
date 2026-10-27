// Chats block: small pure helpers (time, size, colour, search). No DOM, no daemon: everything here runs under plain node tests.

const pad = (n) => String(n).padStart(2, '0')
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const DAY_MS = 86_400_000

/** 24h clock `14:05` in local time. */
export function fmtClock(ts) {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Local calendar day number (days since epoch in local time) so DST changes never split or merge a day. */
export function dayNumber(ts) {
  const d = new Date(ts)
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS)
}
export const dayKey = (ts) => String(dayNumber(ts))

/** Day separator label: Today, Yesterday, a weekday inside the last week, `12 March`, `12 March 2024`. */
export function fmtDay(ts, now = Date.now()) {
  const diff = dayNumber(now) - dayNumber(ts)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  const d = new Date(ts)
  if (diff > 1 && diff < 7) return WEEKDAYS[d.getDay()]
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`
}

/** Conversation-list time: clock today, Yesterday, a short weekday, `12 Mar`, `12 Mar 24`. */
export function fmtListTime(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const diff = dayNumber(now) - dayNumber(ts)
  if (diff <= 0) return fmtClock(ts)
  if (diff === 1) return 'Yesterday'
  const d = new Date(ts)
  if (diff < 7) return WEEKDAYS[d.getDay()].slice(0, 3)
  const base = `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${String(d.getFullYear()).slice(2)}`
}

/** `last seen 5 min ago`, `last seen yesterday`, ... */
export function lastSeenText(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return 'offline'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'last seen just now'
  const m = Math.round(s / 60)
  if (m < 60) return `last seen ${m} min ago`
  const hrs = Math.round(m / 60)
  if (hrs < 24) return `last seen ${hrs} h ago`
  const diff = dayNumber(now) - dayNumber(ts)
  if (diff === 1) return 'last seen yesterday'
  return `last seen ${fmtDay(ts, now)}`
}

export function fmtSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** Stable colour index 0..n-1 for a string (avatar tint). */
export function hueIndex(s, n = 8) {
  let h = 2166136261
  const str = String(s ?? '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h % n
}

/** One or two letters for an avatar; emoji and astral characters stay whole. */
export function initials(name) {
  const clean = String(name ?? '').replace(/^[#@]+/, '').trim()
  if (!clean) return '?'
  const words = clean.split(/[\s._-]+/).filter(Boolean)
  const first = (w) => Array.from(w)[0] ?? ''
  return (words.length > 1 ? first(words[0]) + first(words[1]) : first(words[0] ?? '')).toUpperCase()
}

export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

export function clip(s, n) {
  const a = Array.from(String(s ?? ''))
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join('')
}

/** Collapses whitespace and newlines so a message fits one preview line. */
export const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** Case-insensitive AND-of-words match. 0 = every word starts a field, 1 = a word starts inside a field, 2 = substring; -1 = no match. The worst word decides. */
export function rankMatch(query, ...fields) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return 0
  const hay = fields.filter(Boolean).map((f) => String(f).toLowerCase())
  if (!hay.length) return -1
  let worst = 0
  for (const w of q.split(/\s+/)) {
    let rank = -1
    for (const f of hay) {
      const r = f.startsWith(w) ? 0 : f.includes(' ' + w) ? 1 : f.includes(w) ? 2 : -1
      if (r >= 0 && (rank < 0 || r < rank)) rank = r
    }
    if (rank < 0) return -1
    worst = Math.max(worst, rank)
  }
  return worst
}

/** http(s) only; returns the normalised href or null. */
export function safeHref(raw) {
  try {
    const u = new URL(String(raw))
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

const IMG_DATA = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/
/** An image source we are willing to put in an <img>: https, blob, or a base64 raster data URL (never svg). */
export function safeImageSrc(raw) {
  const s = String(raw ?? '')
  if (IMG_DATA.test(s)) return s
  if (s.startsWith('blob:')) return s
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

/** Splits text into extended grapheme clusters when the runtime can; falls back to code points. */
export function graphemes(s) {
  const str = String(s ?? '')
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str), (x) => x.segment)
  }
  return Array.from(str)
}

/** 1..3 emoji and nothing else: the message is drawn large without a bubble tint. */
export function isEmojiOnly(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length > 40) return false
  const g = graphemes(t).filter((x) => !/^\s+$/.test(x))
  return g.length > 0 && g.length <= 3 && g.every((x) => /\p{Extended_Pictographic}/u.test(x) || /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(x))
}
