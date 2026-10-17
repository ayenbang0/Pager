import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { type StatRecord, StatsLog, STATS_MAX_LINES, summarize } from './stats.js'
import { removeTmpDirs, tmpDir } from '../testutil.js'

const tmpFile = (): string => path.join(tmpDir('pager-stats-'), 'sub', 'agent-stats.jsonl')
const rec = (extra: Partial<StatRecord> = {}): StatRecord => ({ ts: 1000, agent: 'omp', cli: 'omp', ms: 10, files: 1, stop: 'end_turn', ...extra })

test('append creates the directory and read returns records in order with optional fields', () => {
  const log = new StatsLog(tmpFile())
  assert.deepEqual(log.read(), [])
  const a = rec({ tokensIn: 5, tokensOut: 7, verdict: 'approve' })
  const b = rec({ ts: 2000, agent: 'claude', cli: 'claude' })
  log.append(a)
  log.append(b)
  assert.deepEqual(log.read(), [a, b])
})

test('bad lines, wrong shapes and a torn last line are skipped', () => {
  const file = tmpFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const good = JSON.stringify(rec())
  fs.writeFileSync(
    file,
    [
      'not json',
      good,
      '[1]',
      '',
      JSON.stringify({ ...rec(), ts: 'x' }),
      JSON.stringify({ ...rec(), files: null }),
      JSON.stringify({ ...rec(), agent: 3 }),
      JSON.stringify({ ...rec(), verdict: 'maybe', tokensIn: 'many' }),
      '{"ts":1,"agent":"omp"',
    ].join('\n'),
  )
  assert.deepEqual(new StatsLog(file).read(), [rec(), rec()])
})

test('the reader keeps only the last 5000 lines', () => {
  const file = tmpFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = Array.from({ length: STATS_MAX_LINES + 20 }, (_, i) => JSON.stringify(rec({ ts: i + 1 })))
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  const got = new StatsLog(file).read()
  assert.equal(got.length, STATS_MAX_LINES)
  assert.equal(got[0]?.ts, 21)
  assert.equal(got.at(-1)?.ts, STATS_MAX_LINES + 20)
})

test('append never throws when the file cannot be written', () => {
  const file = tmpFile()
  fs.mkdirSync(file, { recursive: true })
  assert.doesNotThrow(() => new StatsLog(file).append(rec()))
})

const NOW = new Date(2026, 9, 16, 12, 0, 0).getTime()
const daysAgo = (n: number, hour = 9): number => new Date(2026, 9, 16 - n, hour, 0, 0).getTime()

test('totals add turns, files, time and track the latest turn', () => {
  const { perAgent } = summarize(
    [rec({ ts: daysAgo(1), files: 2, ms: 100 }), rec({ ts: daysAgo(0), files: 3, ms: 50 }), rec({ ts: daysAgo(2), agent: 'claude', files: 0, ms: 5 })],
    NOW,
  )
  assert.deepEqual(perAgent['omp'], { turns: 2, files: 5, ms: 150, approved: 0, changes: 0, lastTs: daysAgo(0) })
  assert.deepEqual(perAgent['claude'], { turns: 1, files: 0, ms: 5, approved: 0, changes: 0, lastTs: daysAgo(2) })
})

test('review records count verdicts for the author but are not turns', () => {
  const { perAgent, week } = summarize(
    [
      rec({ ts: daysAgo(0) }),
      rec({ ts: daysAgo(0, 10), stop: 'review', verdict: 'approve', files: 9, ms: 999 }),
      rec({ ts: daysAgo(0, 11), stop: 'review', verdict: 'changes' }),
      rec({ ts: daysAgo(0, 11), stop: 'review', verdict: 'unknown' }),
      rec({ ts: daysAgo(0, 11), stop: 'review', verdict: 'changes', agent: 'ghost' }),
    ],
    NOW,
  )
  assert.deepEqual(perAgent['omp'], { turns: 1, files: 1, ms: 10, approved: 1, changes: 1, lastTs: daysAgo(0) })
  assert.deepEqual(perAgent['ghost'], { turns: 0, files: 0, ms: 0, approved: 0, changes: 1, lastTs: 0 })
  assert.equal(week[13], 1)
})

test('week has 14 local days, oldest first, today last; older and future turns are ignored', () => {
  const { week } = summarize(
    [
      rec({ ts: daysAgo(0, 0) }),
      rec({ ts: daysAgo(0, 23) }),
      rec({ ts: daysAgo(1) }),
      rec({ ts: daysAgo(13) }),
      rec({ ts: daysAgo(14) }),
      rec({ ts: daysAgo(40) }),
      rec({ ts: NOW + 3 * 86_400_000 }),
    ],
    NOW,
  )
  assert.equal(week.length, 14)
  assert.deepEqual(week, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2])
})

test('no records gives empty totals and a zero week', () => {
  assert.deepEqual(summarize([], NOW), { perAgent: {}, week: Array.from({ length: 14 }, () => 0) })
})

test('an agent called __proto__ is stored as data, not as a prototype', () => {
  const { perAgent } = summarize([rec({ agent: '__proto__' })], NOW)
  assert.equal(Object.keys(perAgent).length, 1)
  assert.equal(Object.getPrototypeOf(perAgent), Object.prototype)
})

after(removeTmpDirs)
