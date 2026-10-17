import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { QuestionField, QuestionView } from '../agents/questions.js'
import type { Press } from './pickerNav.js'
import { answersOf, initPicker, PICKER_BORDER_ROWS, pickerHeight, pickerKey, pickerRows, type PickerEffect, type PickerState } from './questionState.js'

const choice = (key: string, extra: Partial<QuestionField> = {}): QuestionField => ({
  key,
  label: `Pick ${key}`,
  options: [
    { value: 'a', label: 'Apple', description: 'red' },
    { value: 'b', label: 'Banana' },
    { value: 'c', label: 'Cherry' },
  ],
  multi: false,
  allowOther: true,
  kind: 'choice',
  ...extra,
})

const view = (...fields: QuestionField[]): QuestionView => ({ id: 'q1', agent: 'omp', message: 'Which fruit?', fields })

const press = (input: string, extra: Partial<Press> = {}): Press => ({ input, ...extra })
const ENTER = press('', { return: true })
const DOWN = press('', { downArrow: true })

function run(v: QuestionView, keys: Press[], from = initPicker(v)): { state: PickerState; effect?: PickerEffect } {
  let state = from
  let effect: PickerEffect | undefined
  for (const k of keys) {
    const out = pickerKey(v, state, k)
    state = out.state
    effect = out.effect
    if (effect !== undefined) break
  }
  return { state, ...(effect === undefined ? {} : { effect }) }
}

test('Enter picks the highlighted option and, on the last field, submits it', () => {
  const v = view(choice('q0'))
  assert.deepEqual(run(v, [DOWN, ENTER]).effect, { kind: 'submit', answers: { q0: 'b' } })
})

test('the cursor starts on the recommended option', () => {
  const v = view(choice('q0', { recommended: 'c' }))
  assert.deepEqual(run(v, [ENTER]).effect, { kind: 'submit', answers: { q0: 'c' } })
})

test('Space toggles in a multi field and Enter advances to the next field, submitting after the last', () => {
  const v = view(choice('q0', { multi: true }), choice('q1'))
  const mid = run(v, [press(' '), DOWN, DOWN, press(' '), ENTER])
  assert.equal(mid.effect, undefined)
  assert.equal(mid.state.field, 1)
  assert.deepEqual(mid.state.picked[0], ['a', 'c'])
  assert.deepEqual(run(v, [ENTER], mid.state).effect, { kind: 'submit', answers: { q0: ['a', 'c'], q1: 'a' } })
})

test('Space toggles an option off again', () => {
  const v = view(choice('q0', { multi: true }))
  assert.deepEqual(run(v, [press(' '), press(' ')]).state.picked[0], [])
})

test('the Other row is a text field: every printable key types, including Space and the letters that are shortcuts elsewhere', () => {
  const v = view(choice('q0'))
  const out = run(v, [DOWN, DOWN, DOWN, press('r'), press('q'), press(' '), press('x')])
  assert.equal(out.state.text[0], 'rq x')
  assert.equal(out.effect, undefined)
  assert.deepEqual(run(v, [ENTER], out.state).effect, { kind: 'submit', answers: { q0__other: 'rq x' } })
})

test('Enter on an empty Other row does nothing, and Backspace edits the typed text', () => {
  const v = view(choice('q0'))
  const onOther = run(v, [DOWN, DOWN, DOWN, ENTER])
  assert.equal(onOther.effect, undefined)
  assert.equal(onOther.state.field, 0)
  assert.equal(run(v, [DOWN, DOWN, DOWN, press('a'), press('b'), press('', { backspace: true })]).state.text[0], 'a')
})

test('typing Other deselects an earlier pick of a single field', () => {
  const v = view(choice('q0'))
  const out = run(v, [press(' '), DOWN, DOWN, DOWN, press('z')])
  assert.deepEqual(out.state.picked[0], [])
  assert.equal(out.state.text[0], 'z')
})

test('a free-text field answers under its own key', () => {
  const v = view({ key: 'name', label: 'Name', options: [], multi: false, allowOther: false, kind: 'text' })
  assert.deepEqual(run(v, [press('h'), press('i'), ENTER]).effect, { kind: 'submit', answers: { name: 'hi' } })
})

test('a confirm field answers true or false', () => {
  const v = view({
    key: 'ok',
    label: 'Go?',
    options: [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ],
    multi: false,
    allowOther: false,
    kind: 'confirm',
  })
  assert.deepEqual(run(v, [DOWN, ENTER]).effect, { kind: 'submit', answers: { ok: 'false' } })
})

test('Esc cancels', () => {
  assert.deepEqual(run(view(choice('q0')), [press('', { escape: true })]).effect, { kind: 'cancel' })
})

test('Tab and Shift+Tab change field without leaving the question', () => {
  const v = view(choice('q0'), choice('q1'))
  const next = run(v, [press('', { tab: true })])
  assert.equal(next.state.field, 1)
  assert.equal(run(v, [press('', { tab: true, shift: true })], next.state).state.field, 0)
})

test('answersOf reports a multi field as a list even when nothing is picked', () => {
  const v = view(choice('q0', { multi: true }))
  assert.deepEqual(answersOf(v, initPicker(v)), { q0: [] })
})

test('rows: headline, message, one row per field with the current one expanded, recommended marked, descriptions kept', () => {
  const v = view(choice('q0', { recommended: 'b' }), choice('q1'))
  const s = initPicker(v)
  const height = pickerHeight(v, 40)
  const rows = pickerRows(v, s, height - PICKER_BORDER_ROWS)
  assert.equal(rows.length, height - PICKER_BORDER_ROWS)
  assert.equal(rows[0]?.kind === 'head' && rows[0].agent, 'omp')
  assert.equal(rows.filter((r) => r.kind === 'field').length, 2)
  const options = rows.filter((r) => r.kind === 'option')
  assert.equal(options.length, 3)
  assert.equal(options[1]?.kind === 'option' && options[1].recommended, true)
  assert.equal(options[1]?.kind === 'option' && options[1].here, true)
  assert.equal(options[0]?.kind === 'option' && options[0].description, 'red')
  assert.equal(rows.at(-1)?.kind, 'hint')
})

test('rows: single choices use ● and ○, multi uses [x] and [ ]', () => {
  const single = view(choice('q0'))
  const rows1 = pickerRows(single, run(single, [press(' ')]).state, 20)
  assert.deepEqual(
    rows1.filter((r) => r.kind === 'option').map((r) => r.kind === 'option' && r.marker),
    ['●', '○', '○'],
  )
  const multi = view(choice('q0', { multi: true }))
  const rows = pickerRows(multi, run(multi, [press(' ')]).state, 20)
  assert.deepEqual(
    rows.filter((r) => r.kind === 'option').map((r) => r.kind === 'option' && r.marker),
    ['[x]', '[ ]', '[ ]'],
  )
})

test('rows: a long list scrolls to keep the cursor visible and the height stays constant', () => {
  const options = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }))
  const v = view(choice('q0', { options, allowOther: false }))
  const height = pickerHeight(v, 9)
  assert.equal(height, 9)
  const state = run(v, Array.from({ length: 9 }, () => DOWN)).state
  const rows = pickerRows(v, state, height)
  assert.equal(rows.length, height)
  assert.equal(rows.some((r) => r.kind === 'option' && r.label === 'Option 9' && r.here), true)
})
