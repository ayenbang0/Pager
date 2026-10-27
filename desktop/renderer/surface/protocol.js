// Pager surface protocol: a program asks the terminal to draw a rich block in the scrollback.
//
//   ESC ] 7777 ; pager-surface ; <base64 of a UTF-8 JSON object> ESC \          (BEL also ends it)
//   { kind: 'mermaid'|'math'|'diff'|'image'|'html-sandbox', id, source, title?, height? }
//
// `height` is the number of terminal rows the block covers. The emitter prints that many line feeds after the sequence so the
// scrollback has real lines under the block; the block is anchored to the line the sequence arrived on and scrolls and
// reflows with it. This module is pure (no DOM, no xterm): the encoder here and src/surface/protocol.ts must agree, which
// protocol.test.mjs checks both ways.

export const OSC_CODE = 7777
export const OSC_TAG = 'pager-surface'
export const KINDS = ['mermaid', 'math', 'diff', 'image', 'html-sandbox']

/** Decoded JSON above this is refused. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024
/** Base64 text for MAX_PAYLOAD_BYTES (4 chars per 3 bytes, padded). */
export const MAX_BASE64_CHARS = Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4
/** Live blocks per terminal; the oldest is dropped for a newer one. */
export const MAX_BLOCKS = 100
export const MIN_ROWS = 1
export const MAX_ROWS = 60
export const DEFAULT_ROWS = { mermaid: 16, math: 5, diff: 18, image: 14, 'html-sandbox': 14 }
export const MAX_TITLE = 200

const ID = /^[A-Za-z0-9._:-]{1,64}$/
const B64 = /^[A-Za-z0-9+/]*={0,2}$/
const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

const err = (error) => ({ ok: false, error })

function toBase64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(text) {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The container format a data URL claims, checked against the first bytes it carries. */
export function imageMagicOk(mime, b64) {
  let bytes
  try {
    const head = b64.slice(0, 24)
    bytes = fromBase64(head.slice(0, head.length - (head.length % 4)))
  } catch {
    return false
  }
  const at = (i, s) => [...s].every((c, k) => bytes[i + k] === c.charCodeAt(0))
  switch (mime) {
    case 'png': return bytes[0] === 0x89 && at(1, 'PNG')
    case 'jpeg': return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'gif': return at(0, 'GIF8')
    case 'webp': return at(0, 'RIFF') && at(8, 'WEBP')
    default: return false
  }
}

/** Check and normalise a message. Returns { ok: true, msg } (a fresh object holding only known fields) or { ok: false, error }. */
export function validateSurface(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return err('payload is not a JSON object')
  const { kind, id, source, title, height } = raw
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return err('unknown kind')
  if (typeof id !== 'string' || !ID.test(id)) return err('id must be 1-64 characters of letters, digits and . _ : -')
  if (typeof source !== 'string') return err('source must be a string')
  if (source.length === 0) return err('source is empty')
  const msg = { kind, id, source }
  if (title !== undefined) {
    if (typeof title !== 'string') return err('title must be a string')
    msg.title = title.replace(CONTROL, ' ').trim().slice(0, MAX_TITLE)
  }
  if (height !== undefined) {
    if (!Number.isInteger(height) || height < MIN_ROWS || height > MAX_ROWS) return err(`height must be a whole number of rows from ${MIN_ROWS} to ${MAX_ROWS}`)
    msg.height = height
  }
  if (kind === 'image') {
    const m = IMAGE_URL.exec(source)
    if (!m) return err('image source must be a base64 data URL of a png, jpeg, gif or webp')
    if (!imageMagicOk(m[1], m[2])) return err('image bytes do not match their declared type')
  }
  return { ok: true, msg }
}

/** The rows a block covers: its own height, else its kind's default. */
export const rowsOf = (msg) => msg.height ?? DEFAULT_ROWS[msg.kind]

/** The escape sequence for `msg` (throws on an invalid or oversized message). Line feeds for the block's rows are the caller's. */
export function encodeSurface(msg) {
  const v = validateSurface(msg)
  if (!v.ok) throw new Error(v.error)
  const bytes = enc.encode(JSON.stringify(v.msg))
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error(`payload is ${bytes.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`)
  return `\x1b]${OSC_CODE};${OSC_TAG};${toBase64(bytes)}\x1b\\`
}

/**
 * What xterm hands a registered OSC 7777 handler: everything after `7777;`. Returns { ok: true, msg },
 * { ok: false, error }, or null when the data is some other 7777 sub-protocol (leave it to others).
 */
export function decodeOsc(data) {
  if (typeof data !== 'string') return null
  const cut = data.indexOf(';')
  if ((cut < 0 ? data : data.slice(0, cut)) !== OSC_TAG) return null
  const b64 = cut < 0 ? '' : data.slice(cut + 1)
  if (b64.length > MAX_BASE64_CHARS) return err(`payload is larger than ${MAX_PAYLOAD_BYTES} bytes`)
  if (b64.length === 0 || b64.length % 4 !== 0 || !B64.test(b64)) return err('payload is not base64')
  let json
  try {
    const bytes = fromBase64(b64)
    if (bytes.length > MAX_PAYLOAD_BYTES) return err(`payload is larger than ${MAX_PAYLOAD_BYTES} bytes`)
    json = dec.decode(bytes)
  } catch {
    return err('payload is not UTF-8 text')
  }
  let raw
  try {
    raw = JSON.parse(json)
  } catch {
    return err('payload is not JSON')
  }
  return validateSurface(raw)
}
