import { cleanText } from '../net/wire.js'
import { BOT_PREFIX } from './ops.js'

/** The longest event body a peer accepts (see wire.ts). */
const MAX_BODY = 4000
/** A bot's name: what `@name` calls it. Lowercase, 2-24 characters, starting with a letter. */
export const BOT_NAME_RE = /^[a-z][a-z0-9_-]{1,23}$/

export interface BotMessage {
  name: string
  text: string
}

/**
 * The event body of a bot's chat message, sent as its host. Terminal control characters are dropped (newlines and tabs
 * stay) and a reply too long for one event is cut with an ellipsis.
 */
export function encodeBotMessage(name: string, raw: string): string {
  let text = cleanText(raw).trim()
  for (;;) {
    // JSON keeps newlines off the wire (event bodies refuse control characters); the C1 range is escaped by hand.
    const body = BOT_PREFIX + JSON.stringify({ n: name, t: text }).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    if (body.length <= MAX_BODY || text === '') return body
    text = `${text.slice(0, Math.max(0, text.length - (body.length - MAX_BODY) - 2)).replace(/[\uD800-\uDBFF]$/, '')}…`
  }
}

/** `body` is a whole event body (prefix included). Undefined when it is not a well-formed bot message. The text comes back without control characters. */
export function parseBotMessage(body: string): BotMessage | undefined {
  if (!body.startsWith(BOT_PREFIX)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(body.slice(BOT_PREFIX.length))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { n, t } = raw as { n?: unknown; t?: unknown }
  if (typeof n !== 'string' || !BOT_NAME_RE.test(n) || typeof t !== 'string') return undefined
  const text = cleanText(t).trim()
  return text === '' ? undefined : { name: n, text }
}
