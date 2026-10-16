import assert from 'node:assert/strict'
import { test } from 'node:test'
import DHT, { type KeyPair } from 'hyperdht'
import { Store } from './db.js'
import { dmConvId, signEvent, type EventKind, type PagerEvent } from './events.js'
import { checkEvent, MAX_GROUP_MEMBERS, type IngestVerdict } from './ingest.js'

const hex = (kp: KeyPair): string => kp.publicKey.toString('hex')
const me = DHT.keyPair()
const bob = DHT.keyPair()
const carol = DHT.keyPair()
const ME = hex(me)
const BOB = hex(bob)
const CAROL = hex(carol)
const DM = dmConvId(ME, BOB)
const G = 'grp:' + '9'.repeat(32)

function mk(kp: KeyPair, conv: string, seq: number, kind: EventKind = 'text', body = 'hi'): PagerEvent {
  return signEvent({ conv, author: hex(kp), seq, ts: seq, kind, body }, kp.secretKey)
}

function setup(): Store {
  const s = new Store(':memory:')
  s.upsertPeer(BOB, { state: 'accepted' }, 1)
  s.upsertConv({ id: DM, kind: 'dm', title: '', creator: null, peer: BOB, state: 'active', readAt: 0, createdAt: 1 })
  // group created by `me`, with bob as member
  s.upsertConv({ id: G, kind: 'group', title: 'g', creator: ME, peer: null, state: 'active', readAt: 0, createdAt: 1 })
  s.insertEvent(mk(me, G, 1, 'member-add', BOB), 1)
  return s
}

const reason = (v: IngestVerdict): string => (v.ok ? 'ok' : v.reason)

test('conv gating', () => {
  const s = setup()
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, 'dm:' + '0'.repeat(32), 1))), 'unknown-conv')
  s.upsertConv({ ...s.getConv(G)!, state: 'invited' })
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, G, 1))), 'unknown-conv')
  s.upsertConv({ ...s.getConv(G)!, state: 'left' })
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, G, 1))), 'conv-left')
})

test('dm entitlement', () => {
  const s = setup()
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, DM, 1))), 'ok')
  assert.equal(reason(checkEvent(s, ME, CAROL, mk(bob, DM, 1))), 'not-entitled')
  assert.equal(reason(checkEvent(s, ME, BOB, mk(carol, DM, 1))), 'author-not-member')
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, DM, 1, 'member-leave', ''))), 'bad-kind')
  s.upsertPeer(BOB, { state: 'blocked' }, 2)
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, DM, 1))), 'not-entitled')
})

test('group membership, signatures, sequencing', () => {
  const s = setup()
  assert.equal(reason(checkEvent(s, ME, CAROL, mk(carol, G, 1))), 'not-entitled')
  assert.equal(reason(checkEvent(s, ME, BOB, mk(carol, G, 1))), 'author-not-member')
  const forged = { ...mk(bob, G, 1), body: 'tampered' }
  assert.equal(reason(checkEvent(s, ME, BOB, forged)), 'bad-sig')
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, G, 2))), 'seq-gap')
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, G, 1))), 'ok')
  s.insertEvent(mk(bob, G, 1), 1)
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, G, 1))), 'duplicate')
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, G, 2, 'text', ''))), 'bad-kind')
})

test('relayed event: author is a third member, sender another member', () => {
  const s = setup()
  s.insertEvent(mk(me, G, 2, 'member-add', CAROL), 1)
  assert.equal(reason(checkEvent(s, ME, BOB, mk(carol, G, 1))), 'ok')
})

test('membership event rules', () => {
  const s = setup()
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, G, 1, 'member-add', CAROL))), 'not-creator')
  s.upsertConv({ ...s.getConv(G)!, creator: BOB })
  s.insertEvent(mk(bob, G, 1, 'member-leave', ''), 1)
  // creator is now bob who left; a creator add from bob (seq 2) is still structurally valid
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, G, 2, 'member-add', 'xyz'))), 'bad-kind')
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, G, 2, 'member-add', CAROL))), 'ok')
  assert.equal(reason(checkEvent(s, ME, BOB, mk(bob, G, 2, 'member-leave', 'why'))), 'bad-kind')
})

test('group-full at 16', () => {
  const s = new Store(':memory:')
  s.upsertConv({ id: G, kind: 'group', title: 'g', creator: ME, peer: null, state: 'active', readAt: 0, createdAt: 1 })
  for (let i = 1; i < MAX_GROUP_MEMBERS; i++) s.insertEvent(mk(me, G, i, 'member-add', i.toString(16).padStart(64, '0')), 1)
  assert.equal(s.members(G).ever.size, MAX_GROUP_MEMBERS)
  assert.equal(reason(checkEvent(s, ME, ME, mk(me, G, MAX_GROUP_MEMBERS, 'member-add', 'f'.repeat(64)))), 'group-full')
  assert.equal(reason(checkEvent(s, ME, ME, mk(me, G, MAX_GROUP_MEMBERS, 'member-add', '1'.padStart(64, '0')))), 'ok')
})
