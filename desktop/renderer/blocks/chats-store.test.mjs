// ChatsStore against a fake daemon api: presence merge, older-message pagination, share-card upsert, optimistic send.
// Run alone: node --test desktop/renderer/blocks/chats-store.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatsStore } from './chats-store.js'

const PK = (n) => '0'.repeat(63) + n.toString(16)
const ME = PK(1)
const msg = (key, ts, over = {}) => ({ key, ts, authorName: 'Ada Lovelace', authorKey: PK(2), mine: false, kind: 'text', text: 'm' + key, status: null, reactions: [], ...over })

/** A tiny fake daemon: handlers answer calls; emit() pushes events to the store. */
function fakeApi(state) {
  const subs = new Set()
  return {
    call: async (type, args = {}) => {
      const h = state.handlers[type]
      if (!h) throw new Error('unknown request: ' + type)
      const r = h(args)
      if (r instanceof Error) throw r
      return r
    },
    onEvent: (fn) => (subs.add(fn), () => subs.delete(fn)),
    emit: (ev) => subs.forEach((fn) => fn(ev)),
  }
}

const baseState = () => ({
  handlers: {},
  me: { pk: ME, code: 'pgr1-x', name: 'Mira', badge: '' },
  chats: [
    { id: 'dm:ada', kind: 'dm', title: 'Ada Lovelace', peer: PK(2), online: false, lastSeen: 0, members: [], last: null, unread: 0, pinned: false, muted: false, archived: false },
    { id: 'grp:crew', kind: 'group', title: 'Crew', peer: null, online: null, members: [], people: [{ pk: PK(2), name: 'Ada Lovelace', hue: 200, online: false, lastSeen: 0 }, { pk: PK(3), name: 'Grace Hopper', hue: 280, online: false, lastSeen: 0 }], last: null, unread: 0, pinned: false, muted: false, archived: false },
  ],
  threads: {},
  pending: [],
  caps: { typing: true, edit: true, react: true },
  prefs: { pin: {}, mute: {}, archive: {} },
  openChat: null,
})

async function boot(state) {
  const api = fakeApi(state)
  state.api = api
  state.handlers['chats.state'] = () => ({ me: state.me, chats: state.chats, threads: state.threads, pending: state.pending, caps: state.caps, prefs: state.prefs, openChat: state.openChat })
  const store = new ChatsStore(api)
  await store.init()
  return { store, api }
}

test('presence merge: dm summary, open group people, chats_changed people, list/thread emits', async (t) => {
  const state = baseState()
  state.handlers['chats.open'] = (a) => ({
    chatId: a.chatId,
    messages: [],
    hasMore: false,
    group: a.chatId === 'grp:crew' ? { people: [{ pk: PK(2), name: 'Ada Lovelace', hue: 200, online: false, lastSeen: 0 }, { pk: PK(3), name: 'Grace Hopper', hue: 280, online: false, lastSeen: 0 }] } : null,
  })
  const { store, api } = await boot(state)
  t.after(() => store.dispose())

  // dm: the peer's presence flips the summary (onPresence matches dm chats by peer pk)
  api.emit({ event: 'chat_presence', pk: PK(2), online: true, lastSeen: 123 })
  assert.equal(store.chat('dm:ada').online, true)
  api.emit({ event: 'chat_presence', pk: PK(2), online: false, lastSeen: 456 })
  assert.equal(store.chat('dm:ada').online, false)

  // group: presence lands on the open thread's people; an unknown pk is ignored
  await store.open('grp:crew')
  const events = []
  store.on('list', () => events.push('list'))
  store.on('thread', () => events.push('thread'))
  api.emit({ event: 'chat_presence', pk: PK(3), online: true, lastSeen: 789 })
  const people = store.thread('grp:crew').group.people
  assert.equal(people.find((p) => p.pk === PK(3)).online, true)
  assert.equal(people.find((p) => p.pk === PK(2)).online, false)
  api.emit({ event: 'chat_presence', pk: PK(9), online: true, lastSeen: 0 })
  assert.equal(people.length, 2)
  assert.ok(events.includes('list'), 'list repaints')
  assert.ok(events.includes('thread'), 'open thread repaints')

  // summary presence (chats_changed) merges into the chat's people as well
  api.emit({ event: 'chats_changed', ids: ['grp:crew'], removed: [], chats: [{ id: 'grp:crew', kind: 'group', title: 'Crew', peer: null, online: null, unread: 0, pinned: false, muted: false, archived: false, people: [{ pk: PK(2), name: 'Ada Lovelace', hue: 200, online: true, lastSeen: 5 }, { pk: PK(3), name: 'Grace Hopper', hue: 280, online: false, lastSeen: 0 }] }] })
  assert.equal(store.chat('grp:crew').people.find((p) => p.pk === PK(2)).online, true)
})

test('loadOlder paginates: before key, sorted merge, hasMore flip, loading guard', async (t) => {
  const state = baseState()
  const newer = Array.from({ length: 20 }, (_, i) => msg(`n:${i}`, 1000 + i))
  const older = Array.from({ length: 10 }, (_, i) => msg(`o:${i}`, 500 + i))
  let opened = 0
  state.handlers['chats.open'] = (a) => {
    opened++
    if (a.before) return { chatId: a.chatId, before: a.before, messages: older, hasMore: false }
    return { chatId: a.chatId, messages: newer, hasMore: true }
  }
  const { store } = await boot(state)
  t.after(() => store.dispose())

  await store.open('dm:ada')
  let th = store.thread('dm:ada')
  assert.equal(th.messages.length, 20)
  assert.equal(th.hasMore, true)
  assert.equal(opened, 1)

  // a second load while one is in flight is refused
  th.loading = true
  assert.equal(await store.loadOlder('dm:ada'), false)
  th.loading = false

  assert.equal(await store.loadOlder('dm:ada'), true)
  th = store.thread('dm:ada')
  assert.equal(th.messages.length, 30)
  assert.equal(th.hasMore, false)
  // merged and still sorted by ts; the oldest key is the pagination cursor
  assert.equal(th.messages[0].key, 'o:0')
  assert.equal(th.messages[29].key, 'n:19')
  for (let i = 1; i < th.messages.length; i++) assert.ok(th.messages[i - 1].ts <= th.messages[i].ts, 'sorted')
  assert.equal(opened, 2)

  // no more pages: nothing to load
  assert.equal(await store.loadOlder('dm:ada'), false)
})

test('chat_share upserts the card by shareId and records the ended state', async (t) => {
  const state = baseState()
  state.handlers['chats.open'] = () => ({ chatId: 'dm:ada', messages: [], hasMore: false })
  const { store, api } = await boot(state)
  t.after(() => store.dispose())
  await store.open('dm:ada')

  const card = (title, state2) => ({ shareId: 'sh:1', chatId: 'dm:ada', block: 'canvas', title, hostPk: PK(2), hostName: 'Ada Lovelace', mine: false, mode: 'live', state: state2, joined: true, hostOnline: true, members: [], startedAt: 1 })
  api.emit({ event: 'chat_share', chatId: 'dm:ada', kind: 'offered', share: card('First', 'live') })
  api.emit({ event: 'chat_share', chatId: 'dm:ada', kind: 'presence', share: card('Renamed', 'live') })
  let shares = store.thread('dm:ada').messages.filter((m) => m.kind === 'share')
  assert.equal(shares.length, 1, 'same shareId replaces, does not append')
  assert.equal(shares[0].share.title, 'Renamed')

  api.emit({ event: 'chat_share', chatId: 'dm:ada', kind: 'ended', share: card('Renamed', 'ended') })
  shares = store.thread('dm:ada').messages.filter((m) => m.kind === 'share')
  assert.equal(shares.length, 1)
  assert.equal(shares[0].share.state, 'ended')
})

test('send is optimistic, adopts the server key, ticks status in place', async (t) => {
  const state = baseState()
  state.handlers['chats.open'] = () => ({ chatId: 'dm:ada', messages: [], hasMore: false })
  state.handlers['chats.send'] = (a) => {
    const twin = { key: 'srv:1', ts: Date.now(), authorName: 'Mira', authorKey: ME, mine: true, kind: 'text', text: a.text, status: 'delivered', reactions: [] }
    state.api.emit({ event: 'chat_message', chatId: a.chatId, message: twin, mine: true }) // the daemon echoes the stored twin (the mock does it synchronously)
    return { key: twin.key }
  }
  const { store, api } = await boot(state)
  t.after(() => store.dispose())
  await store.open('dm:ada')

  await store.send('dm:ada', 'hello')
  const th = store.thread('dm:ada')
  assert.equal(th.messages.length, 1, 'no duplicate: the echo adopted the optimistic bubble')
  assert.equal(th.messages[0].key, 'srv:1')
  assert.equal(th.messages[0].status, 'delivered')

  // ticks with the same key update the bubble in place
  const tick = (status) => api.emit({ event: 'chat_message', chatId: 'dm:ada', message: { key: 'srv:1', ts: th.messages[0].ts, authorName: 'Mira', authorKey: ME, mine: true, kind: 'text', text: 'hello', status, reactions: [] }, mine: true })
  tick('read')
  assert.equal(store.thread('dm:ada').messages[0].status, 'read')
  tick('failed')
  const m = store.thread('dm:ada').messages[0]
  assert.equal(m.status, 'failed')
  assert.equal(m.text, 'hello')
})

test('a daemon that cannot answer chats.state leaves the store in error with its text and no conversations', async (t) => {
  const state = baseState()
  state.handlers['chats.state'] = () => new Error('engine_failed: The chat engine could not start: the sodium-native addon is blocked by Smart App Control.')
  const store = new ChatsStore(fakeApi(state))
  t.after(() => store.dispose())
  await assert.rejects(() => store.init(), /sodium-native/)
  assert.equal(store.status, 'error')
  assert.match(store.statusText, /^The chat engine could not start/)
  assert.equal(store.chatsById.size, 0, 'nothing is made up when the daemon fails')

  state.handlers['chats.state'] = () => new Error('locked: Enter your passphrase')
  await assert.rejects(() => store.init())
  assert.equal(store.status, 'locked')
  assert.equal(store.statusText, 'Enter your passphrase')
})
