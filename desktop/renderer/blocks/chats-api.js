// Chats block: the daemon connection. Requests are `chats.*` over window.pager.d.call; events are the daemon's `chat*` events
// from d.onEvent (the window already subscribes to every event name, so there is nothing to subscribe here).
// See local://chats-contract.md for the request and event shapes.

/** `"<code>: <text>"` (the daemon's error shape) -> { code, text }. */
export function parseError(e) {
  const msg = String((e && e.message) || e || 'failed')
  const m = /^([a-z_]+): ([\s\S]*)$/.exec(msg)
  return m ? { code: m[1], text: m[2] } : { code: 'failed', text: msg }
}

export class ChatsError extends Error {
  constructor(e) {
    const p = parseError(e)
    super(p.text)
    this.code = p.code
  }
}

/** Wraps window.pager.d (or any object with call/onEvent/onStatus) as the store's api. */
export function daemonApi(d) {
  return {
    call: (type, args) => d.call(type, args ?? {}).catch((e) => Promise.reject(new ChatsError(e))),
    onEvent: (fn) => d.onEvent((ev) => ev && typeof ev.event === 'string' && ev.event.startsWith('chat') && fn(ev)),
    onStatus: typeof d.onStatus === 'function' ? (fn) => d.onStatus(fn) : null,
  }
}

/** Is a request/event name one this block understands (used by the mock and tests). */
export const CHAT_EVENTS = ['chats_changed', 'chat_message', 'chat_presence', 'chat_call', 'chat_request', 'chat_toast', 'chat_status', 'chat_typing']
