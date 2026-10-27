import { ChatsError, type ChatToast, type Ctx } from './chats.js'

export type Args = Record<string, unknown>
export type Handler = {
  run(c: Ctx, a: Args): unknown
  /** Works with no engine at all (`chats.caps`). */
  needsEngine?: false
  /** Runs, and answers with the status, while the engine is stopped, locked or in conflict. */
  allowNotReady?: true
}

export const MAX_TEXT = 4000
export const KEY_RE = /^[0-9a-f]{64}:\d{1,9}$/

export function str(a: Args, k: string, max = MAX_TEXT): string {
  const v = a[k]
  if (typeof v !== 'string' || v.trim() === '') throw new ChatsError('invalid', `${k} is required`)
  if (v.length > max) throw new ChatsError('invalid', `${k} is too long (max ${max})`)
  return v
}
export const opt = (a: Args, k: string, max = MAX_TEXT): string | undefined => (a[k] === undefined || a[k] === null ? undefined : str(a, k, max))
export const bool = (a: Args, k: string): boolean => {
  if (typeof a[k] !== 'boolean') throw new ChatsError('invalid', `${k} must be true or false`)
  return a[k]
}
export const oneLine = (s: string, k: string): string => {
  if (/[\r\n]/.test(s) || /\p{Cc}/u.test(s)) throw new ChatsError('invalid', `${k} must be one line`)
  return s.trim()
}
export const chatId = (a: Args): string => oneLine(str(a, 'chatId', 100), 'chatId')
export const int = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d)

export const done = (toasts: ChatToast[], extra: Args = {}): Args => ({ ...(toasts.length > 0 ? { message: toasts[toasts.length - 1]!.text } : {}), toasts, ...extra })

/** Runs `fn` against the engine, optionally with a chat open first, and returns what the engine said. */
export async function action(c: Ctx, open: string | undefined, fn: () => unknown, extra: (() => Args) | undefined = undefined): Promise<Args> {
  c.settle()
  if (open !== undefined) c.activate(open)
  const { toasts, messageKey } = await c.act(async () => void (await fn()))
  return done(toasts, { ...(messageKey === undefined ? {} : { key: messageKey }), ...(extra?.() ?? {}) })
}

export const slash = (name: string, ...words: (string | undefined)[]): string => `/${name} ${words.filter((w) => w !== undefined && w !== '').join(' ')}`.trimEnd()
