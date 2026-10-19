import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DOC_PREFIX } from '../docs/store.js'
import { REACT_PREFIX, RENAME_PREFIX } from './ops.js'
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

const V1_SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE peers(
  pk TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
  state TEXT CHECK(state IN ('outgoing','incoming','accepted','blocked')),
  note TEXT NOT NULL DEFAULT '', request_sent INTEGER NOT NULL DEFAULT 0, accept_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE TABLE convs(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('dm','group')), title TEXT NOT NULL DEFAULT '',
  creator TEXT, peer TEXT, state TEXT NOT NULL CHECK(state IN ('active','invited','left')),
  read_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE events(
  conv TEXT NOT NULL, author TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text','member-add','member-leave')), body TEXT NOT NULL, sig TEXT NOT NULL,
  recv_at INTEGER NOT NULL, PRIMARY KEY(conv, author, seq)) WITHOUT ROWID;
CREATE INDEX events_conv_ts ON events(conv, ts);
CREATE TABLE acks(conv TEXT NOT NULL, peer TEXT NOT NULL, author TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(conv, peer, author)) WITHOUT ROWID;
CREATE TABLE joined(conv TEXT NOT NULL, peer TEXT NOT NULL, PRIMARY KEY(conv, peer)) WITHOUT ROWID;
INSERT INTO meta(key, value) VALUES('schema_version', '1');
`

test('a v1 database migrates to v2: documents are classified, chat text is kept, reopening is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-db-'))
  const file = path.join(dir, 'pager.db')
  try {
    const raw = new DatabaseSync(file)
    raw.exec(V1_SCHEMA)
    const put = raw.prepare('INSERT INTO events(conv, author, seq, ts, kind, body, sig, recv_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
    put.run(G, A, 1, 1, 'text', 'hello', 'f'.repeat(128), 1)
    put.run(G, A, 2, 2, 'text', DOC_PREFIX + '{"x":1}', 'f'.repeat(128), 2)
    raw.close()
    for (let i = 0; i < 2; i++) {
      const s = new Store(file)
      assert.deepEqual(s.listMessages(G, 10).map((e) => e.body), ['hello'])
      assert.equal(s.docEvents().length, 1)
      s.close()
    }
    const check = new DatabaseSync(file)
    assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value, '2')
    check.close()
    const newer = new DatabaseSync(file)
    newer.exec("UPDATE meta SET value = '3' WHERE key = 'schema_version'")
    newer.close()
    assert.throws(() => new Store(file), /newer pager/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rename events show as messages; reactions are listed separately and never counted as unread', () => {
  const s = new Store(':memory:')
  s.upsertConv(group())
  s.insertEvent(ev(A, 1, { body: RENAME_PREFIX + 'crew' }), 10)
  s.insertEvent(ev(B, 1, { body: REACT_PREFIX + '+:' + A + ':1:🔥' }), 10)
  assert.equal(s.unreadCount(G, A), 0)
  assert.deepEqual(s.listMessages(G, 10).map((e) => e.body), [RENAME_PREFIX + 'crew'])
  assert.deepEqual(s.reactionEvents(G).map((r) => r.author), [B])
  assert.equal(s.getEvent(G, A, 1)?.body, RENAME_PREFIX + 'crew')
  assert.equal(s.getEvent(G, A, 9), undefined)
})

test('an encrypted Store seals bodies, titles and peer fields on disk and reads them back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-db-'))
  const file = path.join(dir, 'pager.db')
  const key = Buffer.alloc(32, 5)
  try {
    const s = new Store(file, key)
    s.upsertConv(group())
    s.upsertPeer(B, { name: 'bob', note: 'friend', state: 'accepted' }, 1)
    s.insertEvent(ev(A, 1, { body: 'top secret' }), 1)
    s.insertEvent(ev(A, 2, { body: DOC_PREFIX + '{}' }), 1)
    s.insertEvent(ev(A, 3, { kind: 'member-add', body: B }), 1)
    assert.deepEqual(s.listMessages(G, 10).filter((e) => e.kind === 'text').map((e) => e.body), ['top secret'])
    assert.equal(s.docEvents().length, 1)
    assert.equal(s.docEvents()[0]?.body, DOC_PREFIX + '{}')
    assert.deepEqual(s.sentTexts(A, 5), ['top secret'])
    assert.equal(s.getPeer(B)?.name, 'bob')
    assert.equal(s.getConv(G)?.title, 't')
    assert.deepEqual([...s.members(G).current].sort(), [A, B])
    assert.equal(s.recentTexts(5)[0]?.body, 'top secret')
    s.close()
    const raw = new DatabaseSync(file)
    for (const r of raw.prepare('SELECT body FROM events').all()) assert.match(r.body as string, /^pgrenc1:/)
    assert.match(raw.prepare('SELECT title FROM convs').get()?.title as string, /^pgrenc1:/)
    assert.match(raw.prepare('SELECT name FROM peers').get()?.name as string, /^pgrenc1:/)
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM events WHERE op = 'doc'").get()?.n, 1)
    raw.close()
    assert.throws(() => new Store(file).listMessages(G, 5), /passphrase is required/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('encryptAll then decryptAll round-trips; mixed plaintext and sealed rows read fine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-db-'))
  const file = path.join(dir, 'pager.db')
  const key = Buffer.alloc(32, 6)
  try {
    const plain = new Store(file)
    plain.upsertConv(group())
    plain.upsertPeer(B, { name: 'bob' }, 1)
    plain.insertEvent(ev(A, 1, { body: 'one' }), 1)
    plain.close()
    const mixed = new Store(file, key)
    mixed.insertEvent(ev(A, 2, { body: 'two' }), 1)
    assert.deepEqual(mixed.listMessages(G, 10).map((e) => e.body), ['one', 'two'])
    mixed.encryptAll()
    mixed.encryptAll()
    mixed.close()
    const raw = new DatabaseSync(file)
    assert.ok(raw.prepare('SELECT body FROM events').all().every((r) => String(r.body).startsWith('pgrenc1:')))
    raw.close()
    const again = new Store(file, key)
    assert.deepEqual(again.listMessages(G, 10).map((e) => e.body), ['one', 'two'])
    again.decryptAll()
    again.close()
    const raw2 = new DatabaseSync(file)
    assert.deepEqual(raw2.prepare('SELECT body FROM events ORDER BY seq').all().map((r) => r.body), ['one', 'two'])
    assert.equal(raw2.prepare('SELECT name FROM peers').get()?.name, 'bob')
    raw2.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
