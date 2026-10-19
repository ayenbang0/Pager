import assert from 'node:assert/strict'
import { test } from 'node:test'
import { columnRows, initModelPicker, modelPickerKey, pendingChanges, pickAgentKey, type ModelPickerEffect, type ModelPickerState, type PickerPair } from './modelState.js'
import type { Press } from '../input/pickerNav.js'

const press = (input: string, extra: Partial<Press> = {}): Press => ({ input, ...extra })
const DOWN = press('', { downArrow: true })
const ENTER = press('', { return: true })
const TAB = press('', { tab: true })

const pair = (over: Partial<PickerPair> = {}): PickerPair => ({
  model: { kind: 'model', settable: true, choices: [{ value: 'gpt-5', label: 'GPT-5' }, { value: 'sonnet', label: 'Sonnet' }], current: 'sonnet' },
  effort: { kind: 'effort', settable: true, choices: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }] },
  ...over,
})

function run(p: PickerPair, keys: Press[], from = initModelPicker(p)): { state: ModelPickerState; effect?: ModelPickerEffect } {
  let state = from
  let effect: ModelPickerEffect | undefined
  for (const k of keys) {
    const out = modelPickerKey(p, state, k)
    state = out.state
    effect = out.effect
    if (effect !== undefined) break
  }
  return { state, ...(effect === undefined ? {} : { effect }) }
}

test('each column is default plus what the agent offers; the cursor starts on the value in effect', () => {
  const p = pair()
  assert.deepEqual(columnRows(p.model).map((r) => r.kind), ['default', 'choice', 'choice'])
  assert.deepEqual(initModelPicker(p).row, [2, 0])
})

test('Enter with nothing moved applies nothing', () => {
  assert.deepEqual(run(pair(), [ENTER]).effect, { kind: 'apply', changes: [] })
})

test('moving in both columns and pressing Enter applies both changes', () => {
  // model wraps from sonnet (row 2) to default; effort moves default -> low
  const out = run(pair(), [DOWN, TAB, DOWN, ENTER])
  assert.deepEqual(out.effect, { kind: 'apply', changes: [{ kind: 'model', value: 'default' }, { kind: 'effort', value: 'low' }] })
  const both = run(pair(), [press('', { upArrow: true }), TAB, DOWN, DOWN, ENTER])
  assert.deepEqual(both.effect, { kind: 'apply', changes: [{ kind: 'model', value: 'gpt-5' }, { kind: 'effort', value: 'high' }] })
})

test('choosing the default row clears a setting that is in effect', () => {
  const out = run(pair(), [DOWN, ENTER])
  assert.deepEqual(out.effect, { kind: 'apply', changes: [{ kind: 'model', value: 'default' }] })
})

test('Esc closes without applying', () => {
  assert.deepEqual(run(pair(), [DOWN, press('', { escape: true })]).effect, { kind: 'close' })
})

test('an agent that advertises no list gets a free-text row that types every printable key', () => {
  const p = pair({ model: { kind: 'model', settable: true, choices: [] } })
  assert.deepEqual(columnRows(p.model).map((r) => r.kind), ['default', 'text'])
  const out = run(p, [DOWN, press('g'), press('p'), press('t'), press('-'), press('5'), press('q')])
  assert.equal(out.state.text[0], 'gpt-5q')
  assert.deepEqual(modelPickerKey(p, out.state, ENTER).effect, { kind: 'apply', changes: [{ kind: 'model', value: 'gpt-5q' }] })
})

test('printable keys do nothing on a list row', () => {
  const out = run(pair(), [press('j'), press('q')])
  assert.deepEqual(out.state, initModelPicker(pair()))
})

test('a column that cannot be set has no rows, is never applied, and the picker starts on the one that can', () => {
  const p = pair({ model: { kind: 'model', settable: false, choices: [] } })
  assert.deepEqual(columnRows(p.model), [])
  assert.equal(initModelPicker(p).col, 1)
  assert.deepEqual(pendingChanges(p, run(p, [DOWN]).state), [{ kind: 'effort', value: 'low' }])
  assert.deepEqual(run(p, [TAB, DOWN]).state.row[0], 0)
})

test('the agent chooser wraps, picks and closes', () => {
  assert.deepEqual(pickAgentKey(['omp', 'claude'], 0, press('', { upArrow: true })), { row: 1 })
  assert.deepEqual(pickAgentKey(['omp', 'claude'], 1, ENTER), { row: 1, pick: 'claude' })
  assert.deepEqual(pickAgentKey(['omp'], 0, press('', { escape: true })), { row: 0, close: true })
  assert.deepEqual(pickAgentKey(['omp'], 0, press('x')), { row: 0 })
})
