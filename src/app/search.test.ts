import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { Store, type Conv } from '../chat/db.js'
import type { PagerEvent } from '../chat/events.js'
import { DOC_PREFIX } from '../docs/store.js'
import { formatSearch, formatWhen, readRoomLines, searchDocs, snippetAround, SEARCH_MAX_HITS, type SearchDoc } from './search.js'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'

after(removeTmpDirs)

const doc = (ts: number, text: string, where = 'team', author = 'alice'): SearchDoc => ({ where, author, ts, text })

test('matches are case-insensitive, literal and newest first', () => {
  const docs = [doc(1, 'Deploy FAILED on staging'), doc(3, 'deploy failed again'), doc(2, 'all good'), doc(4, 'failed deploys are fine')]
  const { hits, total } = searchDocs(docs, 'Failed')
  assert.equal(total, 3)
  assert.deepEqual(hits.map((h) => h.ts), [4, 3, 1])
  assert.deepEqual(searchDocs(docs, '  ').hits, [])
})

test('wildcards and regex characters in the query are literal', () => {
  const docs = [doc(1, 'progress is 100% done'), doc(2, 'snake_case'), doc(3, 'snakeXcase'), doc(4, 'a.b'), doc(5, 'axb'), doc(6, 'back\\slash'), doc(7, 'what (now)?')]
  assert.deepEqual(searchDocs(docs, '100%').hits.map((h) => h.ts), [1])
  assert.deepEqual(searchDocs(docs, '%').hits.map((h) => h.ts), [1])
  assert.deepEqual(searchDocs(docs, 'snake_case').hits.map((h) => h.ts), [2])
  assert.deepEqual(searchDocs(docs, '_').hits.map((h) => h.ts), [2])
  assert.deepEqual(searchDocs(docs, 'a.b').hits.map((h) => h.ts), [4])
  assert.deepEqual(searchDocs(docs, '\\').hits.map((h) => h.ts), [6])
  assert.deepEqual(searchDocs(docs, '(now)?').hits.map((h) => h.ts), [7])
})

test('line breaks and runs of spaces do not break a match', () => {
  const { hits } = searchDocs([doc(1, 'fix the\nlogin   bug')], 'the login')
  assert.equal(hits[0]?.snippet, 'fix the login bug')
})

test('at most `limit` hits are returned but the total counts every match; equal timestamps keep later items first', () => {
  const docs = Array.from({ length: 30 }, (_, i) => doc(100, `hit ${i}`))
  const { hits, total } = searchDocs(docs, 'hit')
  assert.equal(total, 30)
  assert.equal(hits.length, SEARCH_MAX_HITS)
  assert.equal(hits[0]?.text, 'hit 29')
  assert.equal(searchDocs(docs, 'hit', { limit: 3 }).hits.length, 3)
})

test('only the newest `scan` documents are searched', () => {
  const docs = Array.from({ length: 50 }, (_, i) => doc(i, i < 10 ? 'needle old' : `hay ${i}`))
  assert.equal(searchDocs(docs, 'needle', { scan: 50 }).total, 10)
  assert.equal(searchDocs(docs, 'needle', { scan: 40 }).total, 0)
  assert.equal(searchDocs(docs, 'needle', { scan: 45 }).total, 5)
})

test('snippets are trimmed to about 80 characters around the match', () => {
  assert.equal(snippetAround('short text', 'text'), 'short text')
  const long = `${'a'.repeat(200)} NEEDLE ${'b'.repeat(200)}`
  const s = snippetAround(long, 'needle')
  assert.ok(s.startsWith('…') && s.endsWith('…'))
  assert.ok(s.toLowerCase().includes('needle'))
  assert.ok(s.length <= 82, `${s.length}`)
  const head = snippetAround(`needle ${'x'.repeat(200)}`, 'needle')
  assert.ok(head.startsWith('needle') && head.endsWith('…') && head.length <= 81)
  const tail = snippetAround(`${'x'.repeat(200)} needle`, 'needle')
  assert.ok(tail.startsWith('…') && tail.endsWith('needle') && tail.length <= 81)
  assert.ok(snippetAround('q'.repeat(300), 'q'.repeat(150)).length <= 82)
})

test('formatSearch prints `[conversation] author, time: snippet` under a header', () => {
  const now = new Date(2026, 9, 17, 15, 0).getTime()
  const today = new Date(2026, 9, 17, 14, 5).getTime()
  const old = new Date(2026, 9, 1, 9, 3).getTime()
  const lines = formatSearch('hi', searchDocs([doc(today, 'oh hi there', '#team', 'alice'), doc(old, 'hi', 'bob', 'bob')], 'hi'), now)
  assert.deepEqual(lines, ['Search "hi": 2 matches', '', '[#team] alice, 14:05: oh hi there', '[bob] bob, 2026-10-01 09:03: hi'])
  assert.equal(formatWhen(today, now), '14:05')
  assert.deepEqual(formatSearch('zzz', searchDocs([], 'zzz'), now), ['No matches for "zzz"'])
  const many = formatSearch('hit', searchDocs(Array.from({ length: 25 }, (_, i) => doc(i, 'hit')), 'hit'), now)
  assert.equal(many[0], 'Search "hit": 25 matches, showing the newest 20')
  assert.equal(many.length, 2 + 20)
})

test('readRoomLines keeps valid entries, skips corrupt lines and tolerates a missing file', () => {
  const dir = tmpDir('pager-search-')
  const file = path.join(dir, 'agents-room.jsonl')
  assert.deepEqual(readRoomLines(file), [])
  const good = { n: 1, ts: 10, author: 'omp', authorKey: '0', kind: 'text', text: 'hello' }
  const guest = { n: 2, ts: 11, author: 'bob', authorKey: '0', kind: 'text', text: 'hi', pk: 'ab' }
  fs.writeFileSync(file, [JSON.stringify(good), 'not json', '{"ts":"x"}', JSON.stringify({ ...good, kind: 'other' }), JSON.stringify(guest), ''].join('\n'))
  assert.deepEqual(readRoomLines(file), [
    { ts: 10, author: 'omp', kind: 'text', text: 'hello' },
    { ts: 11, author: 'bob', kind: 'text', text: 'hi', pk: 'ab' },
  ])
  assert.equal(readRoomLines(file, 1).length, 1)
})

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const G = 'grp:' + '1'.repeat(32)
const group = (): Conv => ({ id: G, kind: 'group', title: 't', creator: A, peer: null, state: 'active', readAt: 0, createdAt: 1 })
const ev = (author: string, seq: number, over: Partial<PagerEvent> = {}): PagerEvent => ({ conv: G, author, seq, ts: seq, kind: 'text', body: `m${seq}`, sig: 'f'.repeat(128), ...over })

test('Store.recentTexts returns the newest text messages only, skipping documents and control events', () => {
  const s = new Store(':memory:')
  s.upsertConv(group())
  s.insertEvent(ev(A, 1), 1)
  s.insertEvent(ev(A, 2, { kind: 'member-add', body: B }), 1)
  s.insertEvent(ev(B, 1, { ts: 3, body: `${DOC_PREFIX}{"op":1}` }), 1)
  s.insertEvent(ev(B, 2, { ts: 4, body: 'from bob' }), 1)
  s.insertEvent(ev(A, 3, { ts: 5 }), 1)
  assert.deepEqual(s.recentTexts(10).map((e) => e.body), ['m3', 'from bob', 'm1'])
  assert.deepEqual(s.recentTexts(2).map((e) => e.body), ['m3', 'from bob'])
  const hit = s.recentTexts(1)[0]
  assert.deepEqual(hit, { conv: G, author: A, ts: 5, body: 'm3' })
  s.close()
})
