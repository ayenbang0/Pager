// Chats block: pure data logic over the daemon's chats.* shapes (see local://chats-contract.md). No DOM, no daemon.
import { dayKey, fmtDay, oneLine, rankMatch, clip } from './chats-util.js'
import { plainText } from './chats-rich.js'

export const GAP_MS = 5 * 60_000

const KINDS = new Set(['dm', 'group', 'room', 'agent', 'ai', 'shared'])

/** Fills defaults so the UI never checks for undefined. Unknown fields are kept. */
export function normalizeChat(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const kind = KINDS.has(r.kind) ? r.kind : 'dm'
  return {
    ...r,
    id: String(r.id ?? ''),
    kind,
    title: String(r.title ?? ''),
    peer: typeof r.peer === 'string' ? r.peer : null,
    online: typeof r.online === 'boolean' ? r.online : null,
    unread: Math.max(0, Number(r.unread) || 0),
    last: r.last && typeof r.last === 'object' ? { ts: Number(r.last.ts) || 0, text: String(r.last.text ?? ''), mine: !!r.last.mine, authorName: String(r.last.authorName ?? ''), status: r.last.status ?? null } : null,
    call: Number(r.call) || 0,
    thinking: !!r.thinking,
    badge: typeof r.badge === 'string' ? r.badge : '',
    pinned: !!r.pinned,
    muted: !!r.muted,
    archived: !!r.archived,
    folder: typeof r.folder === 'string' && r.folder ? r.folder : '',
    creator: !!r.creator,
    members: Number(r.members) || 0,
    asking: !!r.asking,
  }
}

/** Which list section a chat belongs to. */
export const bucketOf = (c) => (c.kind === 'dm' ? 'people' : c.kind === 'group' ? 'groups' : 'agents')

export const isAgentChat = (c) => c.kind === 'room' || c.kind === 'agent' || c.kind === 'ai' || c.kind === 'shared'

const byRecent = (a, b) => (b.last?.ts ?? 0) - (a.last?.ts ?? 0) || a.title.localeCompare(b.title)

export const FILTERS = ['all', 'unread', 'groups', 'agents']

/**
 * The conversation list as sections. query/filter narrow it; with a query it is one ranked "Results" section.
 * opts: { query, filter, collapsed:Set<string> }  -> [{ id, title, items:Chat[], count, collapsed? }]
 */
export function sectionize(chats, opts = {}) {
  const query = String(opts.query ?? '').trim()
  const filter = FILTERS.includes(opts.filter) ? opts.filter : 'all'
  const collapsed = opts.collapsed ?? new Set()
  const all = [...chats]

  if (query) {
    const ranked = []
    for (const c of all) {
      const rank = rankMatch(query, c.title, c.last?.text)
      if (rank >= 0) ranked.push({ c, rank: c.title.toLowerCase().includes(query.toLowerCase()) ? rank : rank + 3 })
    }
    ranked.sort((a, b) => a.rank - b.rank || byRecent(a.c, b.c))
    return ranked.length ? [{ id: 'results', title: 'Results', items: ranked.map((x) => x.c), count: ranked.length }] : []
  }

  const live = all.filter((c) => !c.archived)
  const match = (c) => (filter === 'unread' ? c.unread > 0 || c.asking : filter === 'groups' ? c.kind === 'group' : filter === 'agents' ? isAgentChat(c) : true)
  const out = []
  const push = (id, title, items, extra = {}) => {
    if (!items.length) return
    out.push({ id, title, items, count: items.length, collapsed: collapsed.has(id), ...extra })
  }

  const visible = live.filter(match)
  push('pinned', 'Pinned', visible.filter((c) => c.pinned).sort(byRecent))
  const rest = visible.filter((c) => !c.pinned)

  const folders = []
  for (const c of rest) if (c.folder && !folders.includes(c.folder)) folders.push(c.folder)
  for (const f of folders) push('folder:' + f, f, rest.filter((c) => c.folder === f).sort(byRecent), { folder: true })
  const loose = rest.filter((c) => !c.folder)

  if (filter === 'unread') push('unread', 'Unread', loose.sort(byRecent))
  else {
    push('people', 'People', loose.filter((c) => bucketOf(c) === 'people').sort(byRecent))
    push('groups', 'Groups', loose.filter((c) => bucketOf(c) === 'groups').sort(byRecent))
    push('agents', 'Agents', loose.filter((c) => bucketOf(c) === 'agents').sort(byRecent))
  }
  if (filter === 'all') push('archived', 'Archived', all.filter((c) => c.archived).sort(byRecent), { archived: true, collapsed: !collapsed.has('archived:open') })
  return out
}

/** The one-line preview under a conversation title. */
export function previewOf(chat) {
  if (chat.thinking) return { text: 'thinking', kind: 'thinking' }
  const l = chat.last
  if (!l) return { text: chat.kind === 'dm' ? 'No messages yet' : 'Nothing here yet', kind: 'empty' }
  const body = oneLine(l.text)
  if (l.mine) return { text: 'You: ' + body, kind: 'mine' }
  if (chat.kind !== 'dm' && l.authorName) return { text: `${l.authorName}: ${body}`, kind: 'theirs' }
  return { text: body, kind: 'theirs' }
}

export const unreadLabel = (n) => (n > 99 ? '99+' : String(n))

/** Total unread across chats that are not muted/archived (the tab badge). */
export function totalUnread(chats) {
  let n = 0
  for (const c of chats) if (!c.archived && !c.muted) n += c.unread
  return n
}

export function normalizeShare(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    ...s,
    shareId: String(s.shareId ?? ''),
    chatId: String(s.chatId ?? ''),
    block: String(s.block ?? ''),
    title: String(s.title ?? ''),
    hostPk: String(s.hostPk ?? ''),
    hostName: String(s.hostName ?? ''),
    mine: !!s.mine,
    mode: s.mode === 'live' ? 'live' : s.mode === 'readonly' ? 'readonly' : 'snapshot',
    state: s.state === 'ended' ? 'ended' : 'live',
    joined: !!s.joined || !!s.mine,
    hostOnline: s.hostOnline !== false,
    openChatId: typeof s.openChatId === 'string' ? s.openChatId : '',
    asking: !!s.asking,
    members: Array.isArray(s.members) ? s.members.filter((m) => m && m.pk).map((m) => ({ pk: String(m.pk), name: String(m.name ?? ''), me: !!m.me, hue: Number(m.hue) || 0, active: m.active !== false })) : [],
    startedAt: Number(s.startedAt) || 0,
    endedAt: Number(s.endedAt) || 0,
    agent: s.agent && typeof s.agent === 'object' ? { name: String(s.agent.name ?? ''), state: ['idle', 'working', 'asking'].includes(s.agent.state) ? s.agent.state : 'idle', summary: String(s.agent.summary ?? '') } : null,
  }
}

// ---------------------------------------------------------------------------------------------- messages

const seqOf = (key) => {
  const m = /:(\d+)$/.exec(String(key))
  return m ? Number(m[1]) : 0
}

/** Local optimistic messages carry keys like `local:3`. */
export const isLocal = (m) => typeof m.key === 'string' && m.key.startsWith('local:')

export function normalizeMessage(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const att = Array.isArray(r.attachments) ? r.attachments.filter((a) => a && typeof a === 'object').map((a) => ({ ...a, name: String(a.name ?? 'file'), size: Number(a.size) || 0, mime: String(a.mime ?? '') })) : []
  return {
    ...r,
    key: String(r.key ?? ''),
    ts: Number(r.ts) || 0,
    authorName: String(r.authorName ?? ''),
    authorKey: String(r.authorKey ?? ''),
    mine: !!r.mine,
    kind: r.kind === 'system' ? 'system' : r.kind === 'share' ? 'share' : 'text',
    share: r.kind === 'share' ? normalizeShare(r.share) : null,
    text: String(r.text ?? ''),
    status: r.status ?? null,
    reactions: Array.isArray(r.reactions) ? r.reactions.filter((x) => x && x.emoji && x.count > 0).map((x) => ({ emoji: String(x.emoji), count: Number(x.count) || 0, mine: !!x.mine })) : [],
    replyTo: r.replyTo && typeof r.replyTo === 'object' ? { key: String(r.replyTo.key ?? ''), authorName: String(r.replyTo.authorName ?? ''), text: String(r.replyTo.text ?? '') } : null,
    edited: !!r.edited,
    deleted: !!r.deleted,
    attachments: att,
  }
}

/** Union by key (incoming wins), a pending local message is replaced by its server twin, oldest first. */
export function mergeMessages(existing, incoming) {
  const map = new Map()
  for (const m of existing) map.set(m.key, m)
  const locals = existing.filter((m) => isLocal(m) && m.status === 'pending')
  for (const raw of incoming) {
    const m = raw
    if (m.kind === 'share' && m.share) for (const [k, x] of map) if (x.kind === 'share' && x.share?.shareId === m.share.shareId && k !== m.key) map.delete(k)
    if (m.mine && !isLocal(m)) {
      const twin = locals.find((l) => l.text === m.text && map.has(l.key))
      if (twin) {
        map.delete(twin.key)
        locals.splice(locals.indexOf(twin), 1)
      }
    }
    map.set(m.key, m)
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts || seqOf(a.key) - seqOf(b.key) || (isLocal(a) ? 1 : 0) - (isLocal(b) ? 1 : 0))
}

/** Delivery tick state for a message I sent: 'clock' | 'sent' | 'delivered' | 'read' | 'failed' | null. */
export function tickOf(m) {
  if (!m.mine || m.kind !== 'text') return null
  if (m.status === 'failed') return 'failed'
  if (m.status === 'pending') return 'clock'
  return m.status === 'sent' || m.status === 'delivered' || m.status === 'read' ? m.status : null
}

/**
 * Flat render list for the thread: day separators, an unread divider, system lines and message bubbles with their position
 * inside a run (single|first|mid|last) by the same sender within GAP_MS.
 * opts: { now, unreadFromKey, showNames, showAvatars }
 */
export function buildTimeline(messages, opts = {}) {
  const now = opts.now ?? Date.now()
  const items = []
  let prev = null
  let prevDay = ''
  for (const m of messages) {
    const day = dayKey(m.ts)
    if (day !== prevDay) {
      items.push({ type: 'day', key: 'day:' + day, label: fmtDay(m.ts, now), ts: m.ts })
      prevDay = day
      prev = null
    }
    if (opts.unreadFromKey && m.key === opts.unreadFromKey && items.length && items[items.length - 1].type !== 'unread') {
      items.push({ type: 'unread', key: 'unread:' + m.key })
      prev = null
    }
    if (m.kind === 'system' || m.kind === 'share') {
      items.push({ type: m.kind, key: m.key, msg: m })
      prev = null
      continue
    }
    const item = { type: 'msg', key: m.key, msg: m, pos: 'single', showName: false, showAvatar: false, newRun: true }
    if (prev && prev.msg.authorKey === m.authorKey && prev.msg.mine === m.mine && m.ts - prev.msg.ts <= GAP_MS) {
      item.newRun = false
      prev.pos = prev.pos === 'single' ? 'first' : 'mid'
      item.pos = 'last'
    }
    items.push(item)
    prev = item
  }
  // names on the first bubble of an incoming run; avatars on the last
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.type !== 'msg' || it.msg.mine) continue
    if (opts.showNames && (it.pos === 'single' || it.pos === 'first')) it.showName = true
    if (opts.showAvatars && (it.pos === 'single' || it.pos === 'last')) it.showAvatar = true
  }
  return items
}

/** The key of the first message that arrived after the chat was last read, given the unread count (newest N incoming). */
export function firstUnreadKey(messages, unread) {
  if (!unread) return ''
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.mine || m.kind !== 'text') continue
    seen++
    if (seen === unread) return m.key
  }
  return ''
}

/** A reply quote: the replied-to text as one clipped plain line. */
export const quoteText = (r, n = 140) => clip(plainText(r?.text ?? ''), n)

/** Slash-command suggestions for composer text like `/gr`; subcommands once the command is complete (`/group n`). */
export function commandSuggestions(commands, text, limit = 8) {
  const m = /^\/(\S*)(\s+(\S*))?$/.exec(text)
  if (!m) return []
  const name = m[1].toLowerCase()
  if (m[2] === undefined) {
    return commands
      .filter((c) => c.name.startsWith(name))
      .slice(0, limit)
      .map((c) => ({ insert: '/' + c.name + ' ', name: '/' + c.name, usage: c.usage, summary: c.summary, disabled: c.hostOnly || '' }))
  }
  const cmd = commands.find((c) => c.name === name)
  if (!cmd?.subs?.length) return []
  const sub = (m[3] ?? '').toLowerCase()
  return cmd.subs
    .filter((s) => s.name.startsWith(sub))
    .slice(0, limit)
    .map((s) => ({ insert: `/${cmd.name} ${s.name} `, name: s.name, usage: s.usage, summary: s.summary, disabled: '' }))
}

/** `@na` at the caret -> { query, start } (start = index of the @), or null. */
export function mentionAt(text, caret) {
  const before = text.slice(0, caret)
  const m = /(?:^|[\s(])@([^\s@]{0,32})$/.exec(before)
  if (!m) return null
  return { query: m[1], start: caret - m[1].length - 1 }
}

