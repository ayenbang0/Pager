// Chats block store: the one place that talks to the daemon (through `api`), keeps the conversation list, threads,
// requests and call state, applies daemon events, and tells the views what changed. No DOM; tested under node with a fake api.
//
// Emits (store.on(type, fn)):  'list' (summaries/pending/meta changed)  'open' (open chat changed)
//   'thread' ({ id, change:'reset'|'append'|'prepend'|'update', keys? })  'toast' ({ level, text })  'ring' ({ chatId, from })
import { normalizeChat, normalizeMessage, normalizeShare, mergeMessages, firstUnreadKey, isLocal } from './chats-model.js'
import { parseError } from './chats-api.js'

const PAGE = 50
const TYPING_MS = 6000
const NO_CAPS = { edit: false, delete: false, reply: false, attachments: false, typing: false, avatars: false, removeMember: false, lastSeen: false, react: true, groups: true, bots: false, calls: false, agents: false, ai: false, ping: false, docs: false, search: false, pin: true, mute: true, archive: true }

export class ChatsStore {
  /** api: { call(type, args) -> Promise, onEvent(fn) -> unsub, onStatus?(fn) -> unsub } */
  constructor(api, { now = () => Date.now() } = {}) {
    this.api = api
    this.now = now
    this.listeners = new Map()
    this.status = 'starting'
    this.statusText = ''
    this.me = null
    this.online = false
    this.onlineCount = 0
    this.lan = null
    this.encrypted = false
    this.agentsOn = false
    this.caps = { ...NO_CAPS }
    this.chatsById = new Map()
    this.pending = []
    this.call = null
    this.rooms = new Map() // chatId -> [{ room, people, mine }]
    this.openId = null
    this.threads = new Map()
    this.drafts = new Map() // chatId -> { text, replyTo, editing }
    this.windowFocused = true
    this.localSeq = 0
    this.disposed = false
    this.tail = new Map() // chatId -> { running, again }
    this.typing = new Map() // chatId -> Map(name -> timer)
    this.readTimers = new Map()
    this.unsubs = [api.onEvent((ev) => this.onEvent(ev))]
    if (api.onStatus) this.unsubs.push(api.onStatus((s) => (s === 'connected' ? void this.init().catch(() => {}) : null)))
  }

  // ------------------------------------------------------------------------------------------ plumbing
  on(type, fn) {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(fn)
    return () => set.delete(fn)
  }
  emit(type, payload) {
    if (this.disposed) return
    const set = this.listeners.get(type)
    if (set) for (const fn of [...set]) fn(payload)
  }
  toast(level, text) {
    this.emit('toast', { level, text })
  }
  dispose() {
    this.disposed = true
    for (const u of this.unsubs) u()
    for (const t of this.readTimers.values()) clearTimeout(t)
    this.readTimers.clear()
    for (const m of this.typing.values()) for (const t of m.values()) clearTimeout(t)
    this.typing.clear()
    this.api.call('chats.focus', { focused: false, chatId: null }).catch(() => {})
  }

  // ------------------------------------------------------------------------------------------ getters
  /** Summaries in daemon order (pinned first, then newest). */
  get chats() {
    return [...this.chatsById.values()]
  }
  chat(id) {
    return this.chatsById.get(id) || null
  }
  thread(id) {
    return this.threads.get(id) || null
  }
  draft(id) {
    return this.drafts.get(id) || { text: '', replyTo: null, editing: null }
  }
  setDraft(id, d) {
    if (!d.text && !d.replyTo && !d.editing) this.drafts.delete(id)
    else this.drafts.set(id, d)
  }
  get ready() {
    return this.status === 'ready'
  }

  // ------------------------------------------------------------------------------------------ lifecycle
  applyState(s) {
    this.status = s.status || 'error'
    this.statusText = s.statusText || ''
    if (s.me) this.me = s.me
    this.online = !!s.online
    this.onlineCount = Number(s.onlineCount) || 0
    this.lan = s.lan || null
    this.encrypted = !!s.encrypted
    this.agentsOn = !!s.agentsOn
    this.version = s.version || ''
    this.update = s.update || null
    this.caps = { ...NO_CAPS, ...(s.caps || {}) }
    if (Array.isArray(s.chats)) {
      const next = new Map()
      for (const raw of s.chats) {
        const c = normalizeChat(raw)
        if (c.id) next.set(c.id, c)
      }
      this.chatsById = next
    }
    if (Array.isArray(s.pending)) this.pending = s.pending
    this.call = s.call || null
    if (s.openChat && !this.openId) this.openId = s.openChat
    this.emit('list', { reason: 'state' })
  }

  /** Loads (or reloads) the whole state; the first call also starts the engine in the daemon. */
  async init() {
    let s
    try {
      s = await this.api.call('chats.state')
    } catch (e) {
      const p = parseError(e)
      this.status = p.code === 'locked' ? 'locked' : 'error'
      this.statusText = p.text
      this.emit('list', { reason: 'error' })
      throw e
    }
    this.applyState(s)
    if (this.ready && this.openId) void this.refreshTail(this.openId, { markRead: false })
    return s
  }

  async unlock(passphrase) {
    const s = await this.api.call('chats.unlock', { passphrase })
    this.applyState(s)
    return s
  }

  async retry() {
    await this.api.call('chats.retry').catch(() => {})
    return this.init()
  }

  setWindowFocus(focused) {
    if (this.windowFocused === focused) return
    this.windowFocused = focused
    this.reportFocus()
    if (focused && this.openId) this.markRead(this.openId)
  }

  reportFocus() {
    this.api.call('chats.focus', { focused: this.windowFocused, chatId: this.openId }).catch(() => {})
  }

  // ------------------------------------------------------------------------------------------ opening
  /** Shows a chat: cached messages at once, then the daemon's newest page (which also marks it read). */
  async open(id) {
    if (!id || !this.chatsById.has(id)) return null
    const first = this.openId !== id
    this.openId = id
    if (first) {
      this.emit('open', { id })
      this.reportFocus()
    }
    const c = this.chatsById.get(id)
    const cached = this.threads.get(id)
    if (cached && !first) return cached
    const unreadBefore = c.unread
    if (cached) {
      cached.firstUnread = firstUnreadKey(cached.messages, unreadBefore) || cached.firstUnread
      this.emit('thread', { id, change: 'reset' })
    } else {
      this.threads.set(id, { id, messages: [], hasMore: false, loading: true, loaded: false, error: '', group: null, bots: [], call: null, rooms: [], agents: null, firstUnread: '' })
      this.emit('thread', { id, change: 'reset' })
    }
    try {
      const r = await this.api.call('chats.open', { chatId: id, limit: PAGE, markRead: this.windowFocused })
      const t = this.threads.get(id)
      const incoming = (r.messages || []).map(normalizeMessage)
      if (cached) this.applyServerMessages(t, incoming)
      else t.messages = incoming
      t.hasMore = cached ? t.hasMore || !!r.hasMore : !!r.hasMore
      t.loading = false
      t.loaded = true
      t.error = ''
      t.group = r.group || null
      t.bots = r.bots || []
      t.call = r.call || null
      t.rooms = r.rooms || []
      t.agents = r.agents || null
      t.firstUnread = unreadBefore ? firstUnreadKey(t.messages, unreadBefore) : ''
      if (r.chat) this.chatsById.set(id, { ...normalizeChat(r.chat), unread: this.windowFocused ? 0 : normalizeChat(r.chat).unread })
      else if (this.windowFocused) this.chatsById.set(id, { ...this.chatsById.get(id), unread: 0 })
      this.emit('thread', { id, change: 'reset' })
      this.emit('list', { reason: 'open' })
      return t
    } catch (e) {
      const t = this.threads.get(id)
      if (t) {
        t.loading = false
        t.error = parseError(e).text
        this.emit('thread', { id, change: 'reset' })
      }
      throw e
    }
  }

  close() {
    if (this.openId === null) return
    this.openId = null
    this.emit('open', { id: null })
    this.reportFocus()
  }

  async loadOlder(id) {
    const t = this.threads.get(id)
    if (!t || t.loading || !t.hasMore || !t.messages.length) return false
    const oldest = t.messages.find((m) => !isLocal(m))
    if (!oldest) return false
    t.loading = true
    try {
      const r = await this.api.call('chats.open', { chatId: id, before: oldest.key, limit: PAGE })
      const incoming = (r.messages || []).map(normalizeMessage)
      this.applyServerMessages(t, incoming)
      t.hasMore = !!r.hasMore
      this.emit('thread', { id, change: 'prepend', keys: incoming.map((m) => m.key) })
      return true
    } finally {
      t.loading = false
    }
  }

  /** Re-reads the newest page of a chat I have loaded (delivery status changed, a send finished). Coalesced per chat. */
  async refreshTail(id, { markRead = false } = {}) {
    if (!this.threads.has(id)) return
    let slot = this.tail.get(id)
    if (slot?.running) {
      slot.again = true
      return
    }
    slot = { running: true, again: false }
    this.tail.set(id, slot)
    try {
      do {
        slot.again = false
        const r = await this.api.call('chats.open', { chatId: id, limit: 30, markRead })
        const t = this.threads.get(id)
        if (!t) break
        const incoming = (r.messages || []).map(normalizeMessage)
        const known = new Set(t.messages.map((m) => m.key))
        this.applyServerMessages(t, incoming)
        if (r.group) t.group = r.group
        if (r.bots) t.bots = r.bots
        if (r.call !== undefined) t.call = r.call
        if (r.rooms) t.rooms = r.rooms
        if (r.agents) t.agents = r.agents
        const fresh = incoming.filter((m) => !known.has(m.key)).map((m) => m.key)
        this.emit('thread', { id, change: fresh.length ? 'append' : 'update', keys: incoming.map((m) => m.key) })
      } while (slot.again && !this.disposed)
    } catch {
      /* a failed background refresh keeps what we have */
    } finally {
      this.tail.delete(id)
    }
  }

  /** Applies server messages onto a loaded thread: a same-key message replaces in place (delivery/read ticks, edits,
      deletes), the echo of an optimistic local send adopts its server key, everything else merges in order. */
  applyServerMessages(t, msgs) {
    const fresh = []
    for (const m of msgs) {
      const same = t.messages.find((x) => x.key === m.key)
      if (same) {
        Object.assign(same, m)
        continue
      }
      if (m.mine) {
        const twin = t.messages.find((x) => x.mine && x.key.startsWith('local:') && x.text === m.text && Math.abs(x.ts - m.ts) < 10_000)
        if (twin) {
          Object.assign(twin, m)
          continue
        }
      }
      fresh.push(m)
    }
    if (fresh.length) t.messages = mergeMessages(t.messages, fresh)
  }

  // ------------------------------------------------------------------------------------------ messages
  /** Sends text. A pending bubble appears at once; the daemon confirms (or the bubble is marked failed with a retry). */
  async send(id, text, opts = {}) {
    const body = String(text ?? '').trim()
    if (!body && !(opts.attachments && opts.attachments.length)) return null
    const t = this.threads.get(id)
    const local = { key: `local:${++this.localSeq}`, ts: this.now(), authorName: this.me?.name || 'Me', authorKey: this.me?.pk || 'me', mine: true, kind: 'text', text: body, status: 'pending', reactions: [], replyTo: opts.replyTo || null, edited: false, deleted: false, attachments: opts.attachments || [] }
    if (t) {
      t.messages = mergeMessages(t.messages, [local])
      this.emit('thread', { id, change: 'append', keys: [local.key] })
    }
    const c = this.chatsById.get(id)
    if (c) this.chatsById.set(id, { ...c, last: { ts: local.ts, text: body, mine: true, authorName: local.authorName, status: 'pending' } })
    this.emit('list', { reason: 'send' })
    try {
      const args = { chatId: id, text: body }
      if (opts.replyTo?.key) args.replyTo = opts.replyTo.key
      if (opts.attachments?.length) args.attachments = opts.attachments.map((a) => ({ name: a.name, mime: a.mime, size: a.size, data: a.data }))
      const r = await this.api.call('chats.send', args)
      if (t && this.threads.get(id) === t) {
        const keys = [local.key]
        const m = t.messages.find((x) => x.key === local.key)
        if (m) {
          if (r?.key && r.key !== local.key) {
            m.key = r.key // adopt the server key so the stored twin dedupes against this bubble
            keys.push(r.key)
          }
          if (m.status === 'pending') m.status = 'sent'
        }
        this.emit('thread', { id, change: 'update', keys })
        void this.refreshTail(id)
      }
      return r
    } catch (e) {
      const m = t?.messages.find((x) => x.key === local.key)
      if (m) {
        m.status = 'failed'
        m.error = parseError(e).text
        this.emit('thread', { id, change: 'update', keys: [local.key] })
      }
      throw e
    }
  }

  /** Retry a failed local message. */
  async retrySend(id, key) {
    const t = this.threads.get(id)
    const m = t?.messages.find((x) => x.key === key)
    if (!m || m.status !== 'failed') return
    t.messages = t.messages.filter((x) => x.key !== key)
    this.emit('thread', { id, change: 'update', keys: [key] })
    return this.send(id, m.text, { replyTo: m.replyTo, attachments: m.attachments })
  }

  discardLocal(id, key) {
    const t = this.threads.get(id)
    if (!t) return
    t.messages = t.messages.filter((x) => x.key !== key)
    this.emit('thread', { id, change: 'update', keys: [key] })
  }

  async react(id, key, emoji) {
    const t = this.threads.get(id)
    const m = t?.messages.find((x) => x.key === key)
    if (m) {
      const list = m.reactions.map((r) => ({ ...r }))
      const mine = list.find((r) => r.emoji === emoji && r.mine)
      if (mine) {
        mine.count -= 1
        mine.mine = false
      } else {
        const same = list.find((r) => r.emoji === emoji)
        if (same) {
          same.count += 1
          same.mine = true
        } else list.push({ emoji, count: 1, mine: true })
      }
      m.reactions = list.filter((r) => r.count > 0)
      this.emit('thread', { id, change: 'update', keys: [key] })
    }
    try {
      await this.api.call('chats.react', { chatId: id, key, emoji })
    } finally {
      void this.refreshTail(id)
    }
  }

  async editMessage(id, key, text) {
    await this.api.call('chats.edit', { chatId: id, key, text })
    void this.refreshTail(id)
  }

  async deleteMessage(id, key) {
    await this.api.call('chats.delete', { chatId: id, key })
    void this.refreshTail(id)
  }

  /** Marks a chat read (debounced) when the window is focused. */
  markRead(id) {
    const c = this.chatsById.get(id)
    if (!c || !this.windowFocused) return
    if (c.unread) {
      this.chatsById.set(id, { ...c, unread: 0 })
      this.emit('list', { reason: 'read' })
    }
    if (this.readTimers.has(id)) return
    this.readTimers.set(
      id,
      setTimeout(() => {
        this.readTimers.delete(id)
        this.api.call('chats.read', { chatId: id }).catch(() => {})
      }, 250),
    )
  }

  async stopTurn(id) {
    return this.api.call('chats.stop', { chatId: id })
  }

  // ------------------------------------------------------------------------------------------ local view prefs
  async setPref(id, kind, on) {
    const c = this.chatsById.get(id)
    if (!c) return
    const prev = c[kind === 'pin' ? 'pinned' : kind === 'mute' ? 'muted' : 'archived']
    const key = kind === 'pin' ? 'pinned' : kind === 'mute' ? 'muted' : 'archived'
    this.chatsById.set(id, { ...c, [key]: on })
    this.emit('list', { reason: 'pref' })
    try {
      await this.api.call('chats.' + kind, { chatId: id, on })
    } catch (e) {
      this.chatsById.set(id, { ...this.chatsById.get(id), [key]: prev })
      this.emit('list', { reason: 'pref' })
      throw e
    }
  }

  // ------------------------------------------------------------------------------------------ requests, contacts, groups
  async accept(p) {
    const r = await this.api.call('chats.request.accept', { id: p.id })
    this.pending = this.pending.filter((x) => x.id !== p.id)
    this.emit('list', { reason: 'pending' })
    void this.init().catch(() => {})
    return r
  }
  async decline(p) {
    const r = await this.api.call('chats.request.decline', { id: p.id })
    this.pending = this.pending.filter((x) => x.id !== p.id)
    this.emit('list', { reason: 'pending' })
    void this.init().catch(() => {})
    return r
  }
  async addContact(code, note) {
    const r = await this.api.call('chats.contact.add', note ? { code, note } : { code })
    void this.init().catch(() => {})
    return r
  }
  async newGroup(title) {
    const r = await this.api.call('chats.group.new', { title })
    await this.init().catch(() => {})
    return r
  }

  /** Re-reads the group view (members, bots, rooms) of a loaded group chat. */
  async refreshGroup(id) {
    const t = this.threads.get(id)
    if (!t) return null
    const g = await this.api.call('chats.group.members', { chatId: id })
    t.group = g
    this.emit('thread', { id, change: 'update', keys: [] })
    return g
  }

  // ------------------------------------------------------------------------------------------ events
  /** Names typing in a chat right now (only when the daemon reports typing; the real engine has none). */
  typingNames(id) {
    return [...(this.typing.get(id)?.keys() ?? [])]
  }

  setTyping(id, name, on) {
    let m = this.typing.get(id)
    if (!m) this.typing.set(id, (m = new Map()))
    clearTimeout(m.get(name))
    if (on) m.set(name, setTimeout(() => this.setTyping(id, name, false), TYPING_MS))
    else m.delete(name)
    if (!m.size) this.typing.delete(id)
    this.emit('typing', { id })
  }

  onEvent(ev) {
    if (this.disposed || !ev) return
    switch (ev.event) {
      case 'chats_changed':
        return this.onChanged(ev)
      case 'chat_message':
        return this.onMessage(ev)
      case 'chat_presence':
        return this.onPresence(ev)
      case 'chat_call':
        return this.onCall(ev)
      case 'chat_request':
        if (Array.isArray(ev.pending)) {
          this.pending = ev.pending
          this.emit('list', { reason: 'pending' })
        }
        return
      case 'chat_share':
        return this.onShare(ev)
      case 'chat_typing':
        if (this.caps.typing && ev.chatId && ev.name) this.setTyping(ev.chatId, String(ev.name), ev.on !== false)
        return
      case 'chat_toast':
        return this.toast(ev.level || 'info', String(ev.text || ''))
      case 'chat_status': {
        const was = this.status
        this.status = ev.status || this.status
        this.statusText = ev.statusText || ''
        this.emit('list', { reason: 'status' })
        if (this.status === 'ready' && was !== 'ready') void this.init().catch(() => {})
        return
      }
      default:
    }
  }

  /** Runs a slash line in a chat; the daemon's one-line notices become toasts and a text block becomes a local system message. */
  async runCommand(id, line) {
    const r = await this.api.call('chats.command', { chatId: id, line })
    for (const t of r?.toasts || []) this.toast(t.level || 'info', String(t.text || ''))
    if (r?.lines?.length) this.addLocalSystem(id, r.lines.join('\n'))
    return r
  }

  /** A line only this window shows (command output); it is not stored and not sent. */
  addLocalSystem(id, text) {
    const t = this.threads.get(id)
    if (!t) return
    const m = normalizeMessage({ key: `local-sys:${++this.localSeq}`, ts: this.now(), kind: 'system', text })
    t.messages = mergeMessages(t.messages, [m])
    this.emit('thread', { id, change: 'append', keys: [m.key] })
  }

  /** Tells the daemon I am typing (only when it supports typing indicators). */
  sendTyping(id) {
    if (this.caps.typing) this.api.call('chats.typing', { chatId: id, on: true }).catch(() => {})
  }

  // ------------------------------------------------------------------------------------------ shared blocks and agents
  /** Offers a block (or an agent session) to the chat. mode: 'live' | 'snapshot'. extra: { title?, snapshot? }. */
  async shareStart(chatId, block, args = {}, mode = 'live', extra = {}) {
    const p = { chatId, block, mode, args }
    if (extra.title) p.title = extra.title
    if (extra.snapshot) p.snapshot = extra.snapshot
    const r = await this.api.call('chats.share.start', p)
    if (r?.share) this.upsertShare(chatId, normalizeShare(r.share))
    return r
  }
  async shareJoin(share) {
    const r = await this.api.call('chats.share.join', { shareId: share.shareId })
    if (r?.share) this.upsertShare(share.chatId, normalizeShare(r.share))
    return r
  }
  async shareLeave(share) {
    const r = await this.api.call('chats.share.leave', { shareId: share.shareId })
    if (r?.share) this.upsertShare(share.chatId, normalizeShare(r.share))
    return r
  }
  async shareEnd(share) {
    const r = await this.api.call('chats.share.end', { shareId: share.shareId })
    if (r?.share) this.upsertShare(share.chatId, normalizeShare(r.share))
    return r
  }

  /** Answers an agent session's multiple-choice question. */
  async answerAgent(chatId, id, answers) {
    return this.api.call('chats.agent.answer', { chatId, id, answers })
  }

  /** Replaces the share card with this shareId (or appends one); the thread is told what changed. */
  upsertShare(chatId, share) {
    const t = this.threads.get(chatId)
    if (!t || !t.loaded) return
    const at = t.messages.findIndex((m) => m.kind === 'share' && m.share?.shareId === share.shareId)
    if (at >= 0) {
      t.messages[at] = { ...t.messages[at], share }
      this.emit('thread', { id: chatId, change: 'update', keys: [t.messages[at].key] })
    } else {
      const m = normalizeMessage({ key: 'share:' + share.shareId, ts: share.startedAt || this.now(), authorName: share.hostName, authorKey: share.hostPk, mine: share.mine, kind: 'share', share, text: '' })
      t.messages = mergeMessages(t.messages, [m])
      this.emit('thread', { id: chatId, change: 'append', keys: [m.key] })
    }
  }

  onShare(ev) {
    if (!ev.share) return
    const share = normalizeShare(ev.share)
    this.upsertShare(ev.chatId || share.chatId, share)
    this.emit('share', { chatId: ev.chatId || share.chatId, share, kind: ev.kind || 'presence' })
  }

  onChanged(ev) {
    if (typeof ev.online === 'boolean') this.online = ev.online
    if (typeof ev.onlineCount === 'number') this.onlineCount = ev.onlineCount
    for (const id of ev.removed || []) {
      this.chatsById.delete(id)
      this.threads.delete(id)
      if (this.openId === id) this.close()
    }
    if (ev.ids === null) {
      // everything may have changed: replace the list, keep order from the daemon
      if (Array.isArray(ev.chats) && ev.chats.length) {
        const next = new Map()
        for (const raw of ev.chats) {
          const c = normalizeChat(raw)
          if (c.id) next.set(c.id, c)
        }
        this.chatsById = next
      } else void this.init().catch(() => {})
    } else {
      const next = new Map()
      const fresh = new Map((ev.chats || []).map((raw) => [raw.id, normalizeChat(raw)]))
      // keep daemon ordering: changed chats first resorted by the daemon's own sort is not guaranteed, so re-sort pinned/last here
      for (const [id, c] of this.chatsById) next.set(id, fresh.get(id) || c)
      for (const [id, c] of fresh) if (!next.has(id)) next.set(id, c)
      this.chatsById = next
    }
    // status ticks ride chats_changed (contract): reflect them on the open thread's last bubble of mine
    if (this.openId && Array.isArray(ev.chats)) {
      const last = (ev.chats.find((c) => c.id === this.openId) || {}).last
      const t = this.threads.get(this.openId)
      const m = t && t.messages.length ? t.messages[t.messages.length - 1] : null
      if (last?.mine && last.status && m && m.mine && m.status !== last.status && m.text === last.text) {
        m.status = last.status
        this.emit('thread', { id: this.openId, change: 'update', keys: [m.key] })
      }
    }
    if (Array.isArray(ev.pending)) this.pending = ev.pending
    // the open chat is on screen: an ack/read changes statuses, so re-read its tail
    if (this.openId && (ev.ids === null || (ev.ids || []).includes(this.openId))) {
      const c = this.chatsById.get(this.openId)
      if (c && this.windowFocused && c.unread) this.markRead(this.openId)
      void this.refreshTail(this.openId)
    }
    this.emit('list', { reason: ev.reason || 'changed' })
  }

  onMessage(ev) {
    const id = ev.chatId
    const m = normalizeMessage(ev.message)
    if (this.typing.get(id)?.has(m.authorName)) this.setTyping(id, m.authorName, false)
    const t = this.threads.get(id)
    if (t && t.loaded) {
      const had = t.messages.some((x) => x.key === m.key)
      this.applyServerMessages(t, [m])
      this.emit('thread', { id, change: had ? 'update' : 'append', keys: [m.key] })
    }
    const c = this.chatsById.get(id)
    if (c) {
      const incoming = !m.mine && m.kind !== 'system'
      const watching = this.openId === id && this.windowFocused
      this.chatsById.set(id, { ...c, last: { ts: m.ts, text: m.text.slice(0, 140), mine: m.mine, authorName: m.authorName, status: m.status }, unread: incoming && !watching ? c.unread + 1 : c.unread })
      if (watching && incoming) this.markRead(id)
      this.emit('list', { reason: 'message' })
    }
  }

  onPresence(ev) {
    let changed = false
    for (const [id, c] of this.chatsById) {
      if (c.kind === 'dm' && c.peer === ev.pk && c.online !== ev.online) {
        this.chatsById.set(id, { ...c, online: !!ev.online })
        changed = true
      }
    }
    for (const t of this.threads.values()) {
      for (const p of t.group?.people || []) if (p.pk === ev.pk && p.online !== !!ev.online) (p.online = !!ev.online), (changed = true)
    }
    if (changed) {
      this.emit('list', { reason: 'presence' })
      if (this.openId) this.emit('thread', { id: this.openId, change: 'update', keys: [] })
    }
  }

  onCall(ev) {
    if (ev.kind === 'state') this.call = ev.call || null
    if (Array.isArray(ev.rooms)) this.rooms.set(ev.chatId, ev.rooms)
    const t = this.threads.get(ev.chatId)
    if (t) {
      t.rooms = ev.rooms || t.rooms
      if (ev.kind === 'state') t.call = ev.call || null
    }
    this.emit('list', { reason: 'call' })
    if (this.openId) this.emit('thread', { id: this.openId, change: 'update', keys: [] })
    if (ev.kind === 'ring') this.emit('ring', { chatId: ev.chatId, from: ev.from || '' })
  }
}
