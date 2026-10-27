// Pager surface protocol, emitter side. A program asks the desktop terminal to draw a rich block in its scrollback:
//
//   ESC ] 7777 ; pager-surface ; <base64 of a UTF-8 JSON object> ESC \
//
// The desktop renderer's decoder is desktop/renderer/surface/protocol.js; the two must stay in step (the renderer's
// protocol.test.mjs round-trips this module's output through it). `height` counts terminal rows.

export const SURFACE_KINDS = ['mermaid', 'math', 'diff', 'image', 'html-sandbox'] as const
export type SurfaceKind = (typeof SURFACE_KINDS)[number]

export interface SurfaceMessage {
  kind: SurfaceKind
  id: string
  source: string
  title?: string
  height?: number
}

export const OSC_CODE = 7777
export const OSC_TAG = 'pager-surface'
/** Decoded JSON above this is refused by emitter and renderer alike. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024
export const MAX_BASE64_CHARS = Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4
export const MIN_ROWS = 1
export const MAX_ROWS = 60
export const MAX_TITLE = 200
export const DEFAULT_ROWS: Record<SurfaceKind, number> = { mermaid: 16, math: 5, diff: 18, image: 14, 'html-sandbox': 14 }

const ID = /^[A-Za-z0-9._:-]{1,64}$/
const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

export type Checked = { ok: true; msg: SurfaceMessage } | { ok: false; error: string }

/** The image container a data URL claims, checked against the bytes it carries. */
export function imageMagicOk(mime: string, b64: string): boolean {
  const head = b64.slice(0, 24)
  const bytes = Buffer.from(head.slice(0, head.length - (head.length % 4)), 'base64')
  const at = (i: number, s: string): boolean => [...s].every((c, k) => bytes[i + k] === c.charCodeAt(0))
  switch (mime) {
    case 'png': return bytes[0] === 0x89 && at(1, 'PNG')
    case 'jpeg': return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'gif': return at(0, 'GIF8')
    case 'webp': return at(0, 'RIFF') && at(8, 'WEBP')
    default: return false
  }
}

export function validateSurface(raw: unknown): Checked {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'payload is not a JSON object' }
  const { kind, id, source, title, height } = raw as Record<string, unknown>
  if (typeof kind !== 'string' || !(SURFACE_KINDS as readonly string[]).includes(kind)) return { ok: false, error: 'unknown kind' }
  if (typeof id !== 'string' || !ID.test(id)) return { ok: false, error: 'id must be 1-64 characters of letters, digits and . _ : -' }
  if (typeof source !== 'string') return { ok: false, error: 'source must be a string' }
  if (source.length === 0) return { ok: false, error: 'source is empty' }
  const msg: SurfaceMessage = { kind: kind as SurfaceKind, id, source }
  if (title !== undefined) {
    if (typeof title !== 'string') return { ok: false, error: 'title must be a string' }
    msg.title = title.replace(CONTROL, ' ').trim().slice(0, MAX_TITLE)
  }
  if (height !== undefined) {
    if (typeof height !== 'number' || !Number.isInteger(height) || height < MIN_ROWS || height > MAX_ROWS) return { ok: false, error: `height must be a whole number of rows from ${MIN_ROWS} to ${MAX_ROWS}` }
    msg.height = height
  }
  if (kind === 'image') {
    const m = IMAGE_URL.exec(source)
    if (!m) return { ok: false, error: 'image source must be a base64 data URL of a png, jpeg, gif or webp' }
    if (!imageMagicOk(m[1]!, m[2]!)) return { ok: false, error: 'image bytes do not match their declared type' }
  }
  return { ok: true, msg }
}

export const rowsOf = (msg: SurfaceMessage): number => msg.height ?? DEFAULT_ROWS[msg.kind]

/** The escape sequence for `msg`; throws on an invalid or oversized message. The caller prints `rowsOf(msg)` line feeds after it. */
export function encodeSurface(msg: SurfaceMessage): string {
  const v = validateSurface(msg)
  if (!v.ok) throw new Error(v.error)
  const bytes = Buffer.from(JSON.stringify(v.msg), 'utf8')
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error(`payload is ${bytes.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`)
  return `\x1b]${OSC_CODE};${OSC_TAG};${bytes.toString('base64')}\x1b\\`
}

/** What a terminal's OSC 7777 handler receives (everything after `7777;`). null: some other 7777 sub-protocol. */
export function decodeOsc(data: string): Checked | null {
  const cut = data.indexOf(';')
  if ((cut < 0 ? data : data.slice(0, cut)) !== OSC_TAG) return null
  const b64 = cut < 0 ? '' : data.slice(cut + 1)
  if (b64.length > MAX_BASE64_CHARS) return { ok: false, error: `payload is larger than ${MAX_PAYLOAD_BYTES} bytes` }
  if (b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { ok: false, error: 'payload is not base64' }
  let json: string
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(b64, 'base64'))
  } catch {
    return { ok: false, error: 'payload is not UTF-8 text' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { ok: false, error: 'payload is not JSON' }
  }
  return validateSurface(raw)
}
