import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { ALL_KEY, BudgetStore, check, DailyOnce, dayKey, describeCap, describeUse, parseBudget, refusal, usedToday, warning } from './budget.js'
import type { StatRecord } from './stats.js'
import { removeTmpDirs, tmpDir } from '../../testing/testutil.js'

const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime()
const MIN = 60_000
const rec = (extra: Partial<StatRecord> = {}): StatRecord => ({ ts: NOW - 1000, agent: 'omp', cli: 'omp', ms: MIN, files: 1, stop: 'end_turn', ...extra })

test('usedToday counts the agent turns and run time since local midnight', () => {
  const used = usedToday([rec({ ms: 2 * MIN }), rec({ ms: 3 * MIN }), rec({ agent: 'claude', ms: 99 * MIN })], 'omp', NOW)
  assert.deepEqual(used, { turns: 2, ms: 5 * MIN })
  assert.deepEqual(usedToday([], 'omp', NOW), { turns: 0, ms: 0 })
})

test('usedToday respects local day boundaries', () => {
  const midnight = new Date(2026, 5, 15, 0, 0, 0, 0).getTime()
  const nextMidnight = new Date(2026, 5, 16, 0, 0, 0, 0).getTime()
  const records = [rec({ ts: midnight - 1 }), rec({ ts: midnight }), rec({ ts: nextMidnight - 1 }), rec({ ts: nextMidnight })]
  assert.equal(usedToday(records, 'omp', NOW).turns, 2)
  assert.equal(usedToday(records, 'omp', midnight - 1).turns, 1)
  assert.equal(usedToday(records, 'omp', nextMidnight).turns, 1)
})

test('review verdict records are not turns and add no time', () => {
  const used = usedToday([rec(), rec({ stop: 'review', verdict: 'approve', ms: 0 }), rec({ stop: 'review', verdict: 'changes', ms: 5 * MIN })], 'omp', NOW)
  assert.deepEqual(used, { turns: 1, ms: MIN })
})

test('check: no caps is always ok', () => {
  assert.deepEqual(check(undefined, { turns: 999, ms: 999 * MIN }), { status: 'ok', pct: 0, limit: undefined })
  assert.equal(check({}, { turns: 5, ms: 5 }).status, 'ok')
})

test('check: warn from 80%, over at 100% of the turn cap', () => {
  const cap = { turns: 5 }
  assert.equal(check(cap, { turns: 3, ms: 0 }).status, 'ok')
  assert.equal(check(cap, { turns: 4, ms: 0 }).status, 'warn')
  assert.deepEqual(check(cap, { turns: 5, ms: 0 }), { status: 'over', pct: 1, limit: 'turns' })
  assert.equal(check(cap, { turns: 9, ms: 0 }).status, 'over')
})

test('check: the minutes cap and the closest of two caps decide', () => {
  assert.equal(check({ minutes: 10 }, { turns: 100, ms: 7 * MIN }).status, 'ok')
  assert.equal(check({ minutes: 10 }, { turns: 0, ms: 8 * MIN }).status, 'warn')
  assert.equal(check({ minutes: 10 }, { turns: 0, ms: 10 * MIN }).status, 'over')
  const both = check({ turns: 10, minutes: 10 }, { turns: 2, ms: 9 * MIN })
  assert.equal(both.status, 'warn')
  assert.equal(both.limit, 'minutes')
  assert.equal(check({ turns: 10, minutes: 10 }, { turns: 10, ms: 0 }).limit, 'turns')
})

test('messages name the agent and the cap that was hit', () => {
  const cap = { turns: 5, minutes: 30 }
  const over = check(cap, { turns: 5, ms: 0 })
  assert.equal(refusal('omp', cap, over), 'omp hit its daily budget (5 turns); Settings > Agents to lift')
  const mins = check(cap, { turns: 1, ms: 30 * MIN })
  assert.equal(refusal('omp', cap, mins), 'omp hit its daily budget (30 min); Settings > Agents to lift')
  const near = check(cap, { turns: 4, ms: 0 })
  assert.match(warning('omp', cap, { turns: 4, ms: 0 }, near), /omp used 80% of its daily budget \(4\/5 turns, 0\/30 min\)/)
  assert.match(warning('omp', cap, { turns: 5, ms: 0 }, over), /hit its daily budget.*used 5\/5 turns/)
  assert.equal(describeCap(cap), 'turns=5 minutes=30')
  assert.equal(describeUse({ turns: 3 }, { turns: 1, ms: 0 }), '1/3 turns')
})

test('DailyOnce answers true once per key per local day', () => {
  const once = new DailyOnce()
  assert.equal(once.first('omp', NOW), true)
  assert.equal(once.first('omp', NOW + MIN), false)
  assert.equal(once.first('claude', NOW), true)
  const tomorrow = new Date(2026, 5, 16, 0, 0, 1).getTime()
  assert.equal(once.first('omp', tomorrow), true)
  assert.equal(dayKey(NOW), '2026-06-15')
})

test('parseBudget: show, set, per-day suffix, off and errors', () => {
  const names = ['omp', 'claude']
  assert.deepEqual(parseBudget([], names), { kind: 'show' })
  assert.deepEqual(parseBudget(['omp', 'turns=20', 'minutes=60'], names), { kind: 'set', key: 'omp', cap: { turns: 20, minutes: 60 } })
  assert.deepEqual(parseBudget(['Claude', 'turns=5/day'], names), { kind: 'set', key: 'claude', cap: { turns: 5 } })
  assert.deepEqual(parseBudget(['all', 'minutes=15'], names), { kind: 'set', key: ALL_KEY, cap: { minutes: 15 } })
  assert.deepEqual(parseBudget(['omp', 'off'], names), { kind: 'off', key: 'omp' })
  assert.deepEqual(parseBudget(['all', 'OFF'], names), { kind: 'off', key: ALL_KEY })
  for (const bad of [['nobody', 'turns=1'], ['omp'], ['omp', 'turns=0'], ['omp', 'turns=-1'], ['omp', 'turns=x'], ['omp', 'hours=2'], ['omp', 'off', 'turns=1']]) {
    assert.equal(parseBudget(bad, names).kind, 'error', bad.join(' '))
  }
})

test('BudgetStore persists caps, agent caps beat the default, off removes them', () => {
  const file = path.join(tmpDir('pager-budget-'), 'sub', 'agent-budgets.json')
  const store = new BudgetStore(file)
  assert.equal(store.get('omp'), undefined)
  store.set('omp', { turns: 3 })
  store.set(ALL_KEY, { minutes: 20 })
  const again = new BudgetStore(file)
  assert.deepEqual(again.get('omp'), { turns: 3 })
  assert.deepEqual(again.get('claude'), { minutes: 20 })
  assert.equal(again.entries().length, 2)
  assert.equal(again.clear('omp'), true)
  assert.equal(again.clear('omp'), false)
  assert.deepEqual(new BudgetStore(file).get('omp'), { minutes: 20 })
  assert.equal(new BudgetStore(file).clear(ALL_KEY), true)
  assert.equal(new BudgetStore(file).get('omp'), undefined)
})

test('BudgetStore ignores a corrupt file and invalid entries', () => {
  const dir = tmpDir('pager-budget-')
  const file = path.join(dir, 'agent-budgets.json')
  fs.writeFileSync(file, 'not json')
  assert.deepEqual(new BudgetStore(file).entries(), [])
  fs.writeFileSync(file, JSON.stringify({ omp: { turns: 2, minutes: 'x' }, bad: { turns: 0 }, worse: 5, __proto__x: { minutes: 1.5 } }))
  assert.deepEqual(new BudgetStore(file).entries(), [['omp', { turns: 2 }]])
})

after(removeTmpDirs)
