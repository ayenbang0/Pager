import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Store, type Conv } from './db.js'
import type { PagerEvent } from './events.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const G = 'grp:' + '1'.repeat(32)

const group = (): Conv => ({ id: G, kind: 'group', title: 't', creator: A, peer: null, state: 'active', readAt: 0, createdAt: 1 })
const ev = (author: string, seq: number, over: Partial<PagerEvent> = {}): PagerEvent => ({
  conv: G, author, seq, ts: seq, kind: 'text', body: `m${seq}`, sig: 'f'.repeat(128), ...over,
})

test('members: creator always, adds, leave wins over a later add', () => {
  const s = new Store(':memory:')
  s.upsertConv(group())
  s.insertEvent(ev(A, 1, { kind: 'member-add', body: B }), 1)
  s.insertEvent(ev(A, 2, { kind: 'member-add', body: C }), 1)
  s.insertEvent(ev(C, 1, { kind: 'member-leave', body: '' }), 1)
  s.insertEvent(ev(A, 3, { kind: 'member-add', body: C }), 1)
  const m = s.members(G)
  assert.deepEqual([...m.ever].sort(), [A, B, C])
  assert.deepEqual([...m.current].sort(), [A, B])
  s.upsertConv({ ...group(), id: 'dm:' + '2'.repeat(32), kind: 'dm' })
  assert.throws(() => s.members('dm:' + '2'.repeat(32)))
})

test('insertEvent dedups; haveVector and eventsAfter are contiguous ascending', () => {
  const s = new Store(':memory:')
  s.upsertConv(group())
  assert.equal(s.insertEvent(ev(A, 1), 1), true)
  assert.equal(s.insertEvent(ev(A, 1, { body: 'other' }), 1), false)
  s.insertEvent(ev(A, 2), 1)
  s.insertEvent(ev(A, 3), 1)
  s.insertEvent(ev(B, 1), 1)
  assert.deepEqual(s.haveVector(G), { [A]: 3, [B]: 1 })
  assert.deepEqual(s.eventsAfter(G, A, 1, 10).map((e) => e.seq), [2, 3])
  assert.equal(s.lastSeq(G, C), 0)
})

test('setAck never decreases', () => {
  const s = new Store(':memory:')
  s.setAck(G, B, A, 5)
  s.setAck(G, B, A, 3)
  assert.equal(s.getAck(G, B, A), 5)
})

test('unreadCount counts only others\' text after read_at; listMessages ordering', () => {
  const s = new Store(':memory:')
  s.upsertConv(group())
  s.insertEvent(ev(A, 1, { ts: 5 }), 10)
  s.insertEvent(ev(B, 1, { ts: 5 }), 10)
  s.insertEvent(ev(B, 2, { ts: 4 }), 20)
  s.insertEvent(ev(B, 3, { kind: 'member-leave', body: '' }), 30)
  assert.equal(s.unreadCount(G, A), 2)
  assert.deepEqual(s.listMessages(G, 10).map((e) => `${e.ts}${e.author[0]}${e.seq}`), ['3b3', '4b2', '5a1', '5b1'])
  s.markRead(G, 15)
  assert.equal(s.unreadCount(G, A), 1)
  assert.equal(s.listMessages(G, 2).length, 2)
})

test('upsertPeer updates only given fields', () => {
  const s = new Store(':memory:')
  s.upsertPeer(A, { name: 'ann', state: 'outgoing' }, 1)
  s.upsertPeer(A, { requestSent: true }, 2)
  assert.deepEqual(s.getPeer(A), { pk: A, name: 'ann', state: 'outgoing', note: '', requestSent: true, acceptSent: false, createdAt: 1 })
})
