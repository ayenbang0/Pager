// node --test desktop/renderer/blocks/chats-model.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTimeline, commandSuggestions, firstUnreadKey, mentionAt, mergeMessages, normalizeChat, normalizeMessage, previewOf, sectionize, tickOf, totalUnread, unreadLabel } from './chats-model.js'

const at = (d, h, mi = 0) => new Date(2026, 9, d, h, mi).getTime()
const msg = (n, o = {}) => normalizeMessage({ key: `a:${n}`, ts: at(23, 9, n), authorName: 'A', authorKey: 'a', mine: false, kind: 'text', text: `m${n}`, ...o })
const chat = (id, o = {}) => normalizeChat({ id, kind: 'dm', title: id, ...o })

test('normalizeChat fills defaults and ignores junk', () => {
  const c = normalizeChat({ id: 'x', kind: 'bogus', unread: -3, last: { ts: 5, text: 't' } })
  assert.equal(c.kind, 'dm')
  assert.equal(c.unread, 0)
  assert.equal(c.pinned, false)
  assert.equal(c.last.authorName, '')
  assert.equal(normalizeChat(null).id, '')
})

test('sectionize: pinned, folders, buckets, archived, filters, query', () => {
  const chats = [
    chat('ada', { pinned: true, last: { ts: 5, text: 'x' } }),
    chat('bob', { last: { ts: 9, text: 'y' }, unread: 2 }),
    chat('crew', { kind: 'group', last: { ts: 7, text: 'z' } }),
    chat('work', { kind: 'group', folder: 'Work', last: { ts: 6, text: 'z' } }),
    chat('agents', { kind: 'room' }),
    chat('old', { archived: true }),
  ]
  const ids = (s) => s.map((x) => `${x.id}:${x.items.map((c) => c.id).join(',')}`)
  assert.deepEqual(ids(sectionize(chats)), ['pinned:ada', 'folder:Work:work', 'people:bob', 'groups:crew', 'agents:agents', 'archived:old'])
  assert.deepEqual(ids(sectionize(chats, { filter: 'unread' })), ['unread:bob'])
  assert.deepEqual(ids(sectionize(chats, { filter: 'groups' })), ['folder:Work:work', 'groups:crew'])
  assert.deepEqual(ids(sectionize(chats, { filter: 'agents' })), ['agents:agents'])
  assert.equal(sectionize(chats)[5].collapsed, true)
  assert.deepEqual(ids(sectionize(chats, { query: 'b' })), ['results:bob'])
  assert.deepEqual(sectionize(chats, { query: 'nothing at all' }), [])
  assert.equal(sectionize(chats, { query: 'y' })[0].items[0].id, 'bob', 'matches the last message too')
})

test('preview text', () => {
  assert.deepEqual(previewOf(chat('a', { thinking: true })), { text: 'thinking', kind: 'thinking' })
  assert.equal(previewOf(chat('a')).kind, 'empty')
  assert.equal(previewOf(chat('a', { last: { ts: 1, text: 'hi\nthere', mine: true } })).text, 'You: hi there')
  assert.equal(previewOf(chat('g', { kind: 'group', last: { ts: 1, text: 'hi', authorName: 'Bo' } })).text, 'Bo: hi')
  assert.equal(previewOf(chat('a', { last: { ts: 1, text: 'hi', authorName: 'Bo' } })).text, 'hi')
})

test('unread totals skip muted and archived', () => {
  assert.equal(totalUnread([chat('a', { unread: 2 }), chat('b', { unread: 5, muted: true }), chat('c', { unread: 1, archived: true })]), 2)
  assert.equal(unreadLabel(120), '99+')
})

test('mergeMessages: dedupe, order, optimistic twin replaced', () => {
  const a = msg(1)
  const b = msg(2)
  const local = normalizeMessage({ key: 'local:1', ts: at(23, 9, 5), authorKey: 'me', mine: true, text: 'hello', status: 'pending' })
  let list = mergeMessages([a], [b])
  assert.deepEqual(list.map((m) => m.key), ['a:1', 'a:2'])
  list = mergeMessages(list, [local])
  assert.equal(list.at(-1).key, 'local:1')
  const real = normalizeMessage({ key: 'me:7', ts: at(23, 9, 5), authorKey: 'me', mine: true, text: 'hello', status: 'sent' })
  list = mergeMessages(list, [real])
  assert.deepEqual(list.map((m) => m.key), ['a:1', 'a:2', 'me:7'])
  list = mergeMessages(list, [{ ...b, status: 'read' }])
  assert.equal(list.filter((m) => m.key === 'a:2').length, 1)
  assert.equal(list.find((m) => m.key === 'a:2').status, 'read')
})

test('ticks', () => {
  assert.equal(tickOf(msg(1)), null)
  assert.equal(tickOf(msg(1, { mine: true, status: 'pending' })), 'clock')
  assert.equal(tickOf(msg(1, { mine: true, status: 'read' })), 'read')
  assert.equal(tickOf(msg(1, { mine: true, status: 'failed' })), 'failed')
  assert.equal(tickOf(msg(1, { mine: true, status: null })), null)
})

test('timeline: day separators, runs, names, avatars, unread divider, system lines', () => {
  const now = at(23, 18)
  const list = [
    msg(1, { ts: at(22, 23, 50) }),
    msg(2, { ts: at(23, 9, 0) }),
    msg(3, { ts: at(23, 9, 2) }),
    msg(4, { ts: at(23, 9, 3) }),
    msg(5, { ts: at(23, 9, 30) }),
    msg(6, { ts: at(23, 9, 31), mine: true, authorKey: 'me' }),
    msg(7, { ts: at(23, 9, 32), kind: 'system' }),
    msg(8, { ts: at(23, 9, 33) }),
  ]
  const tl = buildTimeline(list, { now, unreadFromKey: 'a:5', showNames: true, showAvatars: true })
  assert.deepEqual(tl.map((i) => i.type + (i.pos ? ':' + i.pos : '')), ['day', 'msg:single', 'day', 'msg:first', 'msg:mid', 'msg:last', 'unread', 'msg:single', 'msg:single', 'system', 'msg:single'])
  assert.equal(tl[0].label, 'Yesterday')
  assert.equal(tl[2].label, 'Today')
  assert.equal(tl[3].showName, true)
  assert.equal(tl[4].showName, false)
  assert.equal(tl[5].showAvatar, true)
  assert.equal(tl[4].showAvatar, false)
  assert.equal(tl[8].showName, false, 'my own messages carry no name')
  const dm = buildTimeline(list, { now })
  assert.ok(dm.every((i) => !i.showName && !i.showAvatar))
})

test('firstUnreadKey counts newest incoming', () => {
  const list = [msg(1), msg(2), msg(3, { mine: true }), msg(4), msg(5)]
  assert.equal(firstUnreadKey(list, 0), '')
  assert.equal(firstUnreadKey(list, 1), 'a:5')
  assert.equal(firstUnreadKey(list, 3), 'a:2')
})

test('command suggestions and subcommands, mention trigger', () => {
  const cmds = [
    { name: 'group', usage: '/group', summary: 'g', subs: [{ name: 'new', usage: '/group new', summary: '' }, { name: 'leave', usage: '/group leave', summary: '' }] },
    { name: 'help', usage: '/help', summary: 'h' },
    { name: 'terminal', usage: '/terminal', summary: 't', hostOnly: 'real terminals' },
  ]
  assert.deepEqual(commandSuggestions(cmds, '/g').map((s) => s.name), ['/group'])
  assert.equal(commandSuggestions(cmds, '/').length, 3)
  assert.deepEqual(commandSuggestions(cmds, '/group n').map((s) => s.insert), ['/group new '])
  assert.deepEqual(commandSuggestions(cmds, '/help x'), [])
  assert.deepEqual(commandSuggestions(cmds, 'hello'), [])
  assert.equal(commandSuggestions(cmds, '/t')[0].disabled, 'real terminals')
  assert.deepEqual(mentionAt('hi @Mi', 6), { query: 'Mi', start: 3 })
  assert.equal(mentionAt('mail a@b', 8), null)
  assert.deepEqual(mentionAt('@', 1), { query: '', start: 0 })
})
