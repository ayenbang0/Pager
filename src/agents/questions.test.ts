import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  askUserResult,
  contentFromAnswers,
  fieldsFromAskUser,
  fieldsFromElicitation,
  type QuestionField,
  Questions,
} from './questions.js'

// The shapes omp's multiple-choice `ask` sends (see the plan's grounded facts).
const ompAsk = {
  mode: 'form',
  sessionId: 's1',
  message: 'Need input',
  requestedSchema: {
    type: 'object',
    properties: {
      q0: {
        type: 'string',
        title: 'Which DB?',
        description: 'pick one',
        oneOf: [
          { const: 'pg', title: 'Postgres', description: 'robust' },
          { const: 'sqlite', title: 'SQLite' },
        ],
        default: 'sqlite',
      },
      q0__other: { type: 'string', title: 'Other…' },
      q1: {
        type: 'array',
        title: 'Which features?',
        items: { anyOf: [{ const: 'a', title: 'Auth' }, { const: 'b', title: 'Billing', description: 'money' }] },
      },
      q1__other: { type: 'string', title: 'Other…' },
    },
  },
}

test('omp single choice maps to a choice field with the default as recommended and Other folded in', () => {
  const got = fieldsFromElicitation(ompAsk)
  assert.equal(got?.message, 'Need input')
  assert.equal(got?.fields.length, 2)
  assert.deepEqual(got?.fields[0], {
    key: 'q0',
    label: 'Which DB?',
    options: [
      { value: 'pg', label: 'Postgres', description: 'robust' },
      { value: 'sqlite', label: 'SQLite' },
    ],
    multi: false,
    recommended: 'sqlite',
    allowOther: true,
    kind: 'choice',
  })
})

test('omp multi choice maps items.anyOf to a multi field', () => {
  const field = fieldsFromElicitation(ompAsk)?.fields[1]
  assert.equal(field?.key, 'q1')
  assert.equal(field?.multi, true)
  assert.equal(field?.kind, 'choice')
  assert.equal(field?.allowOther, true)
  assert.equal(field?.recommended, undefined)
  assert.deepEqual(field?.options, [
    { value: 'a', label: 'Auth' },
    { value: 'b', label: 'Billing', description: 'money' },
  ])
})

test('a choice without a __other property does not allow Other; a default that is no option is ignored', () => {
  const got = fieldsFromElicitation({
    message: 'm',
    requestedSchema: { type: 'object', properties: { q0: { type: 'string', title: 't', oneOf: [{ const: 'x', title: 'X' }, { const: 'y', title: 'Y' }], default: 'zzz' } } },
  })
  assert.equal(got?.fields[0]?.allowOther, false)
  assert.equal(got?.fields[0]?.recommended, undefined)
})

test('select (enum under value), confirm (boolean) and input (string) map to choice, confirm and text', () => {
  const select = fieldsFromElicitation({ message: 'Pick', requestedSchema: { type: 'object', properties: { value: { type: 'string', enum: ['red', 'green'] } } } })
  assert.deepEqual(select?.fields[0], {
    key: 'value',
    label: 'value',
    options: [
      { value: 'red', label: 'red' },
      { value: 'green', label: 'green' },
    ],
    multi: false,
    allowOther: false,
    kind: 'choice',
  })
  const confirm = fieldsFromElicitation({ message: 'Sure?', requestedSchema: { type: 'object', properties: { value: { type: 'boolean', default: true } } } })
  assert.deepEqual(confirm?.fields[0]?.options, [
    { value: 'true', label: 'Yes' },
    { value: 'false', label: 'No' },
  ])
  assert.equal(confirm?.fields[0]?.kind, 'confirm')
  assert.equal(confirm?.fields[0]?.recommended, 'true')
  const input = fieldsFromElicitation({ message: 'Name?', requestedSchema: { type: 'object', properties: { value: { type: 'string', description: 'Your name' } } } })
  assert.deepEqual(input?.fields[0], { key: 'value', label: 'Your name', options: [], multi: false, allowOther: false, kind: 'text' })
})

test('confirm options are not shared between fields', () => {
  const got = fieldsFromElicitation({ message: '', requestedSchema: { properties: { a: { type: 'boolean' }, b: { type: 'boolean' } } } })
  got?.fields[0]?.options.push({ value: 'x', label: 'x' })
  assert.equal(got?.fields[1]?.options.length, 2)
})

test('unusable schemas give undefined: no properties, unsupported types, empty choices, non-records', () => {
  assert.equal(fieldsFromElicitation({}), undefined)
  assert.equal(fieldsFromElicitation({ message: 'x', requestedSchema: { type: 'object', properties: {} } }), undefined)
  assert.equal(fieldsFromElicitation({ message: 'x', requestedSchema: { properties: { n: { type: 'number' } } } }), undefined)
  assert.equal(fieldsFromElicitation({ message: 'x', requestedSchema: { properties: { n: { type: 'array', items: { anyOf: [] } } } } }), undefined)
  assert.equal(fieldsFromElicitation({ message: 'x', requestedSchema: { properties: { n: 'junk' } } }), undefined)
})

test('an __other property without its base field stays a text field of its own', () => {
  const got = fieldsFromElicitation({ message: '', requestedSchema: { properties: { solo__other: { type: 'string', title: 'Other…' } } } })
  assert.equal(got?.fields[0]?.key, 'solo__other')
  assert.equal(got?.fields[0]?.kind, 'text')
})

test('answers become typed content: string, string[], boolean, text and Other pass through', () => {
  const fields = fieldsFromElicitation(ompAsk)?.fields ?? []
  assert.deepEqual(contentFromAnswers(fields, { q0: 'pg', q1: ['a', 'b'], q1__other: 'custom' }), { q0: 'pg', q1: ['a', 'b'], q1__other: 'custom' })
  assert.deepEqual(contentFromAnswers(fields, { q1: 'a' }), { q1: ['a'] })
  assert.deepEqual(contentFromAnswers(fields, { q0__other: 'mine' }), { q0__other: 'mine' })
  assert.deepEqual(contentFromAnswers(fields, { q0: 'pg', q0__other: '' }), { q0: 'pg' })
  const typed: QuestionField[] = [
    { key: 'ok', label: 'ok', options: [], multi: false, allowOther: false, kind: 'confirm' },
    { key: 'no', label: 'no', options: [], multi: false, allowOther: false, kind: 'confirm' },
    { key: 'name', label: 'name', options: [], multi: false, allowOther: false, kind: 'text' },
  ]
  assert.deepEqual(contentFromAnswers(typed, { ok: 'true', no: 'false', name: 'Ann', stray__other: 'x' }), { ok: true, no: false, name: 'Ann' })
})

test('a field the user left out is absent from the content, and Other text is ignored when not allowed', () => {
  const fields: QuestionField[] = [{ key: 'a', label: 'a', options: [{ value: 'x', label: 'x' }], multi: false, allowOther: false, kind: 'choice' }]
  assert.deepEqual(contentFromAnswers(fields, { a__other: 'sneaky' }), {})
})

test('ask_user questions become q0.. fields with the label as value and a valid recommended index', () => {
  const fields = fieldsFromAskUser([
    { question: 'Pick', options: ['one', 'two'], recommended: 1 },
    { question: 'Many', options: ['a', 'b'], multi: true, recommended: 9 },
  ])
  assert.deepEqual(fields[0], {
    key: 'q0',
    label: 'Pick',
    options: [
      { value: 'one', label: 'one' },
      { value: 'two', label: 'two' },
    ],
    multi: false,
    recommended: 'two',
    allowOther: true,
    kind: 'choice',
  })
  assert.equal(fields[1]?.key, 'q1')
  assert.equal(fields[1]?.multi, true)
  assert.equal(fields[1]?.recommended, undefined)
})

test('ask_user results list selections and the typed Other, or report cancellation', () => {
  const fields = fieldsFromAskUser([
    { question: 'Pick', options: ['one', 'two'] },
    { question: 'Many', options: ['a', 'b'], multi: true },
    { question: 'Third', options: ['x', 'y'] },
  ])
  assert.deepEqual(askUserResult(fields, { q0: 'one', q1: ['a', 'b'], q1__other: 'c', q2__other: 'free' }), {
    answers: [
      { question: 'Pick', selected: ['one'] },
      { question: 'Many', selected: ['a', 'b'], other: 'c' },
      { question: 'Third', selected: [], other: 'free' },
    ],
  })
  assert.deepEqual(askUserResult(fields, null), { cancelled: true })
})

const field: QuestionField[] = [{ key: 'q0', label: 'Q', options: [{ value: 'a', label: 'a' }], multi: false, allowOther: false, kind: 'choice' }]

test('a question is visible, answering resolves it with the answers and removes it', async () => {
  const qs = new Questions()
  const changes: number[] = []
  qs.on('change', () => changes.push(qs.views().length))
  const pending = qs.ask('omp', 'hi', field)
  const [view] = qs.views()
  assert.equal(view?.agent, 'omp')
  assert.equal(view?.message, 'hi')
  assert.equal(qs.answer(view?.id ?? '', { q0: 'a' }), true)
  assert.deepEqual(await pending, { q0: 'a' })
  assert.deepEqual(qs.views(), [])
  assert.deepEqual(changes, [1, 0])
  assert.equal(qs.answer(view?.id ?? '', { q0: 'a' }), false)
})

test('answering null cancels', async () => {
  const qs = new Questions()
  const pending = qs.ask('omp', 'hi', field)
  qs.answer(qs.views()[0]?.id ?? '', null)
  assert.equal(await pending, null)
})

test('one agent sees one question at a time, in FIFO order; another agent is independent', async () => {
  const qs = new Questions()
  const first = qs.ask('omp', 'first', field)
  const second = qs.ask('omp', 'second', field)
  const other = qs.ask('claude', 'other', field)
  assert.deepEqual(
    qs.views().map((v) => v.message),
    ['first', 'other'],
  )
  assert.equal(qs.pendingFor('omp'), 2)
  assert.equal(qs.pendingFor('claude'), 1)
  assert.equal(qs.pendingFor('nobody'), 0)
  qs.answer(qs.views()[0]?.id ?? '', { q0: 'a' })
  assert.deepEqual(await first, { q0: 'a' })
  assert.deepEqual(
    qs.views().map((v) => v.message),
    ['second', 'other'],
  )
  qs.answer(qs.views().find((v) => v.message === 'second')?.id ?? '', null)
  assert.equal(await second, null)
  qs.answer(qs.views()[0]?.id ?? '', { q0: 'a' })
  assert.deepEqual(await other, { q0: 'a' })
  assert.deepEqual(qs.views(), [])
})

test('a queued question cannot be answered before it is visible', async () => {
  const qs = new Questions()
  const first = qs.ask('omp', 'first', field)
  const second = qs.ask('omp', 'second', field)
  const secondId = 'q2'
  assert.equal(qs.answer(secondId, { q0: 'a' }), false)
  assert.equal(qs.pendingFor('omp'), 2)
  qs.answer(qs.views()[0]?.id ?? '', null)
  await first
  assert.equal(qs.views()[0]?.id, secondId)
  qs.answer(secondId, null)
  await second
})

test('cancelAgent settles every pending question of that agent with null and leaves others', async () => {
  const qs = new Questions()
  const a = qs.ask('omp', 'a', field)
  const b = qs.ask('omp', 'b', field)
  const c = qs.ask('claude', 'c', field)
  let changes = 0
  qs.on('change', () => changes++)
  qs.cancelAgent('omp')
  assert.equal(await a, null)
  assert.equal(await b, null)
  assert.equal(qs.pendingFor('omp'), 0)
  assert.deepEqual(
    qs.views().map((v) => v.agent),
    ['claude'],
  )
  assert.equal(changes, 1)
  qs.cancelAgent('omp')
  assert.equal(changes, 1)
  qs.answer(qs.views()[0]?.id ?? '', { q0: 'a' })
  assert.deepEqual(await c, { q0: 'a' })
})

test("'asked' fires when a question becomes the one the user sees: on arrival with an empty queue, and when the one before it is answered", async () => {
  const qs = new Questions()
  const seen: string[] = []
  qs.on('asked', (q: { agent: string; message: string }) => seen.push(`${q.agent}:${q.message}`))
  const first = qs.ask('omp', 'first', field)
  const second = qs.ask('omp', 'second', field)
  void qs.ask('claude', 'other', field)
  assert.deepEqual(seen, ['omp:first', 'claude:other'])
  qs.answer(qs.views()[0]?.id ?? '', { q0: 'a' })
  await first
  assert.deepEqual(seen, ['omp:first', 'claude:other', 'omp:second'])
  qs.cancelAgent('omp')
  assert.equal(await second, null)
})
