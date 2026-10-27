// Chats block: one timeline row (day separator, unread divider, system line, message bubble) as DOM. Pure construction: all state
// and actions come in through `ctx` so the same code runs in the block and in the fake-DOM tests.
//   ctx = { b, caps, names:Iterable<string>, me:string, showName, openLink(href), copy(text), react(key,emoji), reply(msg),
//           actions(msg, anchor), openImage(att), openFile(att), retry(key), discard(key), pickReaction(msg, anchor), openShare?(share) }
import { fmtClock, fmtSize, isEmojiOnly, safeImageSrc } from './chats-util.js'
import { parseRich, renderRich } from './chats-rich.js'
import { quoteText, tickOf } from './chats-model.js'
import { avatar } from './chats-ui.js'
import { shareCard } from './chats-share.js'

export const MAX_IMG_W = 320
export const MAX_IMG_H = 300

/** Display size of an image attachment inside the caps (never upscaled). */
export function fitImage(w, h, maxW = MAX_IMG_W, maxH = MAX_IMG_H) {
  const W = Number(w) > 0 ? Number(w) : maxW
  const H = Number(h) > 0 ? Number(h) : Math.round(maxW * 0.625)
  const k = Math.min(1, maxW / W, maxH / H)
  return { w: Math.max(40, Math.round(W * k)), h: Math.max(40, Math.round(H * k)) }
}

/** What changes the look of a row; used to skip rebuilding rows that did not change. */
export function rowSig(item, ctx) {
  switch (item.type) {
    case 'day':
      return item.label
    case 'unread':
      return 'u'
    case 'system':
      return item.msg.text
    case 'share':
      return JSON.stringify(item.msg.share) + (ctx.openShareIds?.has(item.msg.share?.shareId) ? '*' : '')
    default: {
      const m = item.msg
      return [item.pos, item.showName ? 1 : 0, item.showAvatar ? 1 : 0, m.status, m.text, m.edited ? 1 : 0, m.deleted ? 1 : 0, m.error || '', JSON.stringify(m.reactions), m.attachments.map((a) => a.id || a.name).join(','), m.replyTo?.key || '', ctx.caps.reply ? 1 : 0].join('\u0001')
    }
  }
}

const tickIcon = (b, t) => {
  switch (t) {
    case 'clock':
      return b.h('span', { class: 'cm-tick clock', title: 'Sending' }, b.icon('clock', 11))
    case 'sent':
      return b.h('span', { class: 'cm-tick sent', title: 'Sent' }, b.icon('check', 12))
    case 'delivered':
      return b.h('span', { class: 'cm-tick delivered', title: 'Delivered' }, b.icon('check-double', 13))
    case 'read':
      return b.h('span', { class: 'cm-tick read', title: 'Read' }, b.icon('check-double', 13))
    case 'failed':
      return b.h('span', { class: 'cm-tick failed', title: 'Not sent' }, b.icon('warn', 12))
    default:
      return null
  }
}

function attachments(b, m, ctx) {
  const { h, icon } = b
  const out = []
  for (const a of m.attachments) {
    const src = a.mime.startsWith('image/') ? safeImageSrc(a.dataUrl || a.url) : null
    if (src) {
      const d = fitImage(a.w, a.h)
      out.push(
        h(
          'button',
          { class: 'cm-img', type: 'button', title: `${a.name} · ${fmtSize(a.size)}`, 'aria-label': `Open image ${a.name}`, style: { '--w': d.w + 'px', '--h': d.h + 'px' }, on: { click: (e) => (e.stopPropagation(), ctx.openImage?.(a)) } },
          h('img', { src, alt: a.name, width: d.w, height: d.h, loading: 'lazy', decoding: 'async', draggable: false }),
        ),
      )
    } else {
      out.push(
        h(
          'button',
          { class: 'cm-file', type: 'button', title: a.name, on: { click: (e) => (e.stopPropagation(), ctx.openFile?.(a)) } },
          h('span', { class: 'cm-file-ic' }, icon(a.mime.startsWith('image/') ? 'image' : a.mime.includes('pdf') ? 'file' : a.mime.startsWith('text/') ? 'file-code' : 'file', 18)),
          h('span', { class: 'cm-file-t' }, h('span', { class: 'cm-file-n' }, a.name), h('span', { class: 'cm-file-s' }, fmtSize(a.size) || a.mime || 'file')),
        ),
      )
    }
  }
  return out.length ? h('div', { class: 'cm-atts' }, out) : null
}

function reactions(b, m, ctx) {
  const { h } = b
  if (!m.reactions.length) return null
  return h(
    'div',
    { class: 'cm-reacts' },
    m.reactions.map((r) =>
      h('button', { class: 'cm-pill' + (r.mine ? ' mine' : ''), type: 'button', title: r.mine ? 'Remove your reaction' : 'React', 'aria-pressed': r.mine ? 'true' : 'false', on: { click: (e) => (e.stopPropagation(), ctx.react?.(m.key, r.emoji)) } }, h('span', { class: 'cm-pill-e' }, r.emoji), r.count > 1 ? h('span', { class: 'cm-pill-n' }, r.count) : null),
    ),
  )
}

function quote(b, m, ctx) {
  const { h } = b
  if (!m.replyTo) return null
  return h(
    'button',
    { class: 'cm-quote', type: 'button', title: 'Jump to the message', on: { click: (e) => (e.stopPropagation(), ctx.jump?.(m.replyTo.key)) } },
    h('span', { class: 'cm-quote-n' }, m.replyTo.authorName || 'Message'),
    h('span', { class: 'cm-quote-t' }, quoteText(m.replyTo)),
  )
}

function toolbar(b, m, ctx) {
  const { h, icon } = b
  const btn = (name, label, fn, cls = '') => h('button', { class: 'cm-act ' + cls, type: 'button', title: label, 'aria-label': label, on: { click: (e) => (e.stopPropagation(), fn(e.currentTarget)) } }, icon(name, 15))
  return h('div', { class: 'cm-acts' }, btn('smile', 'React', (a) => ctx.pickReaction?.(m, a)), ctx.caps.reply ? btn('reply', 'Reply', () => ctx.reply?.(m)) : null, btn('more', 'More', (a) => ctx.actions?.(m, a)))
}

export function buildMessage(ctx, item) {
  const { h, icon } = ctx.b
  const b = ctx.b
  const m = item.msg
  const mine = m.mine
  const only = !m.deleted && !m.attachments.length && !m.replyTo && isEmojiOnly(m.text)
  const cls = ['cm-msg', mine ? 'mine' : 'theirs', 'pos-' + item.pos]
  if (item.newRun) cls.push('run')
  if (only) cls.push('big')
  if (m.deleted) cls.push('deleted')
  if (m.status === 'failed') cls.push('failed')
  if (m.status === 'pending') cls.push('sending')
  if (m.agent) cls.push('agent')

  const body = m.deleted
    ? h('div', { class: 'cm-body' }, h('span', { class: 'cm-gone' }, icon('ban', 13), 'This message was deleted'))
    : m.text
      ? h('div', { class: 'cm-body' }, renderRich(b, parseRich(m.text, { markdown: m.markdown, names: ctx.names, me: ctx.me }), { openLink: ctx.openLink, copy: ctx.copy }))
      : null

  const meta = h(
    'span',
    { class: 'cm-meta' },
    m.edited && !m.deleted ? h('span', { class: 'cm-edited' }, 'edited') : null,
    h('time', { class: 'cm-time' }, fmtClock(m.ts)),
    tickIcon(b, tickOf(m)),
  )

  const bub = h('div', { class: 'cm-bub' }, quote(b, m, ctx), body, m.deleted ? null : attachments(b, m, ctx), meta)
  const wrap = h('div', { class: 'cm-bwrap', on: { contextmenu: (e) => (e.preventDefault(), ctx.actions?.(m, { x: e.clientX, y: e.clientY, left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY })) } }, bub, m.deleted || m.status === 'pending' || m.status === 'failed' ? null : toolbar(b, m, ctx))

  const col = h('div', { class: 'cm-col' }, item.showName ? h('div', { class: 'cm-name' }, m.authorName) : null, wrap, reactions(b, m, ctx))
  if (m.status === 'failed') {
    col.append(
      h('div', { class: 'cm-fail' }, h('span', null, m.error ? `Not sent: ${m.error}` : 'Not sent'), h('button', { type: 'button', class: 'cm-link-btn', on: { click: () => ctx.retry?.(m.key) } }, 'Retry'), h('button', { type: 'button', class: 'cm-link-btn', on: { click: () => ctx.discard?.(m.key) } }, 'Discard')),
    )
  }
  const gut = mine ? null : h('div', { class: 'cm-gut' }, item.showAvatar ? avatar(b, { title: m.authorName, pk: m.authorKey, agent: m.agent }, { size: 28, dot: false }) : null)
  return h('div', { class: cls.join(' ') }, gut, col)
}

/** The row element for a timeline item. */
export function buildRow(ctx, item) {
  const { h, icon } = ctx.b
  switch (item.type) {
    case 'day':
      return h('div', { class: 'cm-day' }, h('span', { class: 'cm-day-chip' }, item.label))
    case 'unread':
      return h('div', { class: 'cm-unread' }, h('span', { class: 'cm-unread-chip' }, icon('arrow-down', 12), 'New messages'))
    case 'system':
      return h('div', { class: 'cm-sys' }, h('span', { class: 'cm-sys-t' }, item.msg.text))
    case 'share':
      return shareCard(ctx, item.msg)
    default:
      return buildMessage(ctx, item)
  }
}
