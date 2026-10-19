import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Store, type Conv } from '../chat/db.js'
import type { PagerEvent } from '../chat/events.js'
import { DOC_PREFIX } from '../docs/store.js'
import { agentActivity, buildRecap, formatAgo } from './recap.js'
import type { RoomLine } from './search.js'
import { loadLastSeen, saveLastSeen } from './settings.js'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'
import fs from 'node:fs'
import path from 'node:path'

after(removeTmpDirs)

const HOUR = 3_600_000
const NOW = 100 * HOUR
const SINCE = NOW - 2 * HOUR

const reply = (ts: number, text = 'done', author = 'omp'): RoomLine => ({ ts, author, kind: 'text', text })
const sys = (ts: number, text: string): RoomLine => ({ ts, author: 'pager', kind: 'system', text })

test('a first run has nothing to recap', () => {
  assert.equal(buildRecap({ now: NOW, lastSeen: undefined, chats: [{ title: 'team', count: 9 }], room: [reply(NOW - 1)] }), undefined)
})

test('nothing happened, or only old things, or a clock that went backwards: no recap', () => {
  assert.equal(buildRecap({ now: NOW, lastSeen: SINCE, chats: [], room: [] }), undefined)
  assert.equal(buildRecap({ now: NOW, lastSeen: SINCE, chats: [{ title: 'team', count: 0 }], room: [reply(SINCE - 5), reply(SINCE)] }), undefined)
  assert.equal(buildRecap({ now: NOW, lastSeen: NOW + 1, chats: [{ title: 'team', count: 3 }], room: [] }), undefined)
})

test('messages and agent activity are summarised in one line', () => {
  const room: RoomLine[] = [
    reply(SINCE + 1),
    reply(SINCE + 2),
    reply(SINCE + 3),
    reply(SINCE + 4, 'partial\n(failed: boom)'),
    reply(SINCE + 5, '(failed: no binary)', 'omp-2'),
    reply(SINCE - 10),
    sys(SINCE + 6, 'merged omp'),
    sys(SINCE + 7, 'run-3 changed 2 file(s): a.ts, b.ts'),
    { ts: SINCE + 8, author: 'you', kind: 'text', text: '@omp do it' },
    { ts: SINCE + 9, author: 'omp', kind: 'text', text: '→ @omp-2 look at this' },
    { ts: SINCE + 10, author: 'bob', kind: 'text', text: 'guest talk', pk: 'ab' },
  ]
  const chats = [{ title: 'alice', count: 3 }, { title: '#team', count: 14 }]
  assert.equal(buildRecap({ now: NOW, lastSeen: SINCE, chats, room }), 'Since you left (2h ago): 14 messages in #team, 3 in alice; agents: 5 turns, 2 failed, 1 merged')
})

test('chats only, agents only, singular forms, and the long tail of chats', () => {
  assert.equal(buildRecap({ now: NOW, lastSeen: SINCE, chats: [{ title: 'alice', count: 1 }], room: [] }), 'Since you left (2h ago): 1 message in alice')
  assert.equal(buildRecap({ now: NOW, lastSeen: NOW - 5 * 60_000, chats: [], room: [reply(NOW - 1000), sys(NOW - 500, 'merge of omp failed; conflicts: a.ts')] }), 'Since you left (5m ago): agents: 1 turn, 1 merge failure')
  const chats = ['a', 'b', 'c', 'd', 'e', 'f'].map((title, i) => ({ title, count: 10 - i }))
  assert.equal(buildRecap({ now: NOW, lastSeen: SINCE, chats, room: [] }), 'Since you left (2h ago): 10 messages in a, 9 in b, 8 in c, 7 in d, 11 elsewhere')
})

test('agentActivity ignores everything at or before the stamp', () => {
  assert.deepEqual(agentActivity([reply(5), sys(5, 'merged omp')], 5), { turns: 0, failed: 0, merged: 0, mergeFailed: 0 })
})

test('formatAgo picks minutes, hours or days', () => {
  assert.equal(formatAgo(10_000), 'just now')
  assert.equal(formatAgo(59 * 60_000), '59m ago')
  assert.equal(formatAgo(3 * HOUR), '3h ago')
  assert.equal(formatAgo(72 * HOUR), '3d ago')
})

test('last-seen survives a round trip, is missing on a first run, and ignores junk', () => {
  const dir = tmpDir('pager-recap-')
  assert.equal(loadLastSeen(dir), undefined)
  saveLastSeen(dir, 12345)
  assert.equal(loadLastSeen(dir), 12345)
  assert.deepEqual(fs.readdirSync(dir), ['last-seen.json'])
  fs.writeFileSync(path.join(dir, 'last-seen.json'), '{"at":"soon"}')
  assert.equal(loadLastSeen(dir), undefined)
  fs.writeFileSync(path.join(dir, 'last-seen.json'), 'garbage')
  assert.equal(loadLastSeen(dir), undefined)
  assert.doesNotThrow(() => saveLastSeen(path.join(dir, 'nope', 'deeper'), 1))
})

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const G = 'grp:' + '1'.repeat(32)
const group = (): Conv => ({ id: G, kind: 'group', title: 't', creator: A, peer: null, state: 'active', readAt: 0, createdAt: 1 })
const ev = (author: string, seq: number, over: Partial<PagerEvent> = {}): PagerEvent => ({ conv: G, author, seq, ts: seq, kind: 'text', body: `m${seq}`, sig: 'f'.repeat(128), ...over })

test('Store.textCountsSince counts only others\' text messages received after the stamp', () => {
  const s = new Store(':memory:')
  s.upsertConv(group())
  s.insertEvent(ev(B, 1), 10)
  s.insertEvent(ev(B, 2), 20)
  s.insertEvent(ev(B, 3, { body: `${DOC_PREFIX}{}` }), 21)
  s.insertEvent(ev(B, 4, { kind: 'member-leave', body: '' }), 22)
  s.insertEvent(ev(A, 1), 23)
  assert.deepEqual([...s.textCountsSince(A, 10)], [[G, 1]])
  assert.deepEqual([...s.textCountsSince(A, 0)], [[G, 2]])
  assert.equal(s.textCountsSince(A, 99).size, 0)
  s.close()
})
