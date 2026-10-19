import type { Store } from './db.js'
import { verifyEvent, type PagerEvent } from './events.js'
import { RENAME_PREFIX } from './ops.js'

export const MAX_GROUP_MEMBERS = 16
/** Longest group title a rename may carry. */
export const MAX_TITLE = 64

export type IngestVerdict =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'unknown-conv'
        | 'conv-left'
        | 'not-entitled'
        | 'author-not-member'
        | 'bad-sig'
        | 'duplicate'
        | 'seq-gap'
        | 'not-creator'
        | 'group-full'
        | 'bad-kind'
    }

type Reason = Extract<IngestVerdict, { ok: false }>['reason']

const fail = (reason: Reason): IngestVerdict => ({ ok: false, reason })

/** The only place that decides whether a received event is stored. */
export function checkEvent(store: Store, me: string, sender: string, ev: PagerEvent): IngestVerdict {
  const conv = store.getConv(ev.conv)
  if (!conv || conv.state === 'invited') return fail('unknown-conv')
  if (conv.state === 'left') return fail('conv-left')

  let ever: Set<string> | undefined
  if (conv.kind === 'dm') {
    if (sender !== conv.peer || store.getPeer(sender)?.state !== 'accepted') return fail('not-entitled')
    if (ev.author !== sender && ev.author !== me) return fail('author-not-member')
    if (ev.kind !== 'text') return fail('bad-kind')
    // Only a group has a creator to rename it.
    if (ev.body.startsWith(RENAME_PREFIX)) return fail('bad-kind')
  } else {
    ever = store.members(conv.id).ever
    if (!ever.has(sender)) return fail('not-entitled')
    if (!ever.has(ev.author)) return fail('author-not-member')
  }

  if (!verifyEvent(ev)) return fail('bad-sig')

  const last = store.lastSeq(ev.conv, ev.author)
  if (ev.seq <= last) return fail('duplicate')
  if (ev.seq > last + 1) return fail('seq-gap')

  if (ever) {
    if (ev.kind === 'text' && ev.body.startsWith(RENAME_PREFIX)) {
      if (ev.author !== conv.creator) return fail('not-creator')
      const title = ev.body.slice(RENAME_PREFIX.length)
      if (title.length < 1 || title.length > MAX_TITLE || /\p{Cc}/u.test(title)) return fail('bad-kind')
    } else if (ev.kind === 'member-add') {
      if (ev.author !== conv.creator) return fail('not-creator')
      if (!/^[0-9a-f]{64}$/.test(ev.body)) return fail('bad-kind')
      if (!ever.has(ev.body) && ever.size >= MAX_GROUP_MEMBERS) return fail('group-full')
    } else if (ev.kind === 'member-leave') {
      if (ev.body !== '') return fail('bad-kind')
    } else if (ev.body.length < 1) {
      return fail('bad-kind')
    }
  } else if (ev.body.length < 1) {
    return fail('bad-kind')
  }
  return { ok: true }
}
