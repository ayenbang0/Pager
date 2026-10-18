import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type BoardEntry, renderBoard } from './board.js'

const entry = (name: string, extra: Partial<BoardEntry> = {}): BoardEntry => ({
  name,
  state: 'idle',
  task: '',
  purpose: '',
  files: [],
  branch: `pager/${name}`,
  ...extra,
})

test('renders the plan format with YOU first and the others listed', () => {
  const board = renderBoard(
    [
      entry('omp', { state: 'working', task: 'add login', purpose: 'auth for the API', files: ['a.ts', 'b.ts'] }),
      entry('claude', { task: 'docs', purpose: 'explain it', files: ['README.md'] }),
    ],
    'ship auth',
    'omp',
  )
  assert.equal(
    board,
    [
      '--- BOARD ---',
      'GOAL: ship auth',
      'YOU: omp (working) task: add login | fits: auth for the API | files: a.ts, b.ts | branch pager/omp',
      'OTHERS:',
      '- claude (idle) task: docs | fits: explain it | files: README.md | branch pager/claude',
    ].join('\n'),
  )
})

test('the viewer is the YOU line even when listed later, and is never in OTHERS', () => {
  const board = renderBoard([entry('a1'), entry('b1', { task: 'x' })], 'g', 'b1')
  const lines = board.split('\n')
  assert.match(lines[2] ?? '', /^YOU: b1 \(idle\) task: x /)
  assert.deepEqual(lines.slice(3), ['OTHERS:', '- a1 (idle) task: (none) | fits: ? | files: none | branch pager/a1'])
})

test('empty goal, purpose and files use placeholders; alone means "- none"', () => {
  const board = renderBoard([entry('omp')], '  ', 'omp')
  assert.equal(
    board,
    '--- BOARD ---\nGOAL: (not set)\nYOU: omp (idle) task: (none) | fits: ? | files: none | branch pager/omp\nOTHERS:\n- none',
  )
})

test('a long task is cut to 200 characters and multi-line text stays on one line', () => {
  const board = renderBoard([entry('omp', { task: `${'x'.repeat(250)}` }), entry('b2', { task: 'line one\n\n  line   two' })], '', 'omp')
  const you = board.split('\n')[2] ?? ''
  const task = /task: (x+…?) \|/.exec(you)?.[1] ?? ''
  assert.equal(task.length, 200)
  assert.ok(task.endsWith('…'))
  assert.ok(board.includes('- b2 (idle) task: line one line two |'))
})

test('a task of exactly 200 characters is not cut', () => {
  const board = renderBoard([entry('omp', { task: 'y'.repeat(200) })], '', 'omp')
  assert.ok(board.includes(`task: ${'y'.repeat(200)} |`))
})

test('files beyond eight are summarised as +N', () => {
  const files = Array.from({ length: 11 }, (_, i) => `f${i}.ts`)
  const board = renderBoard([entry('omp', { files })], '', 'omp')
  assert.ok(board.includes('files: f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts, +3 |'))
  assert.ok(!board.includes('f8.ts'))
  const eight = renderBoard([entry('omp', { files: files.slice(0, 8) })], '', 'omp')
  assert.ok(eight.includes('f7.ts |') && !eight.includes('+'))
})

test('a viewer missing from the entries gets no YOU line', () => {
  const board = renderBoard([entry('omp')], 'g', 'ghost')
  assert.ok(!board.includes('YOU:'))
  assert.ok(board.includes('- omp (idle)'))
})

test('line counts and the verify status appear on the entry only when known', () => {
  const board = renderBoard(
    [entry('omp', { files: ['a.ts'], lines: { adds: 12, dels: 3 }, verify: 'fail' }), entry('claude', { files: ['b.ts'], lines: { adds: 1, dels: 0 } })],
    '',
    'omp',
  )
  assert.ok(board.includes('YOU: omp (idle) task: (none) | fits: ? | files: a.ts (+12/-3) | verify: fail | branch pager/omp'))
  assert.ok(board.includes('- claude (idle) task: (none) | fits: ? | files: b.ts (+1/-0) | branch pager/claude'))
})
