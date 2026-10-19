import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Place } from './chrome.js'
import { buildTitle, titleLabel, TITLE_SPINNER } from './windowTitle.js'

const input = { state: 'idle' as const, frame: 0, unread: 0, label: '● bob' }

test('the separator shows the run state: > idle, ! waiting for you, a spinner while working', () => {
  assert.equal(buildTitle(input), '◆ pager > ● bob')
  assert.equal(buildTitle({ ...input, state: 'attention' }), '◆ pager ! ● bob')
  assert.equal(buildTitle({ ...input, state: 'working', frame: 0 }), '◆ pager ⠋ ● bob')
  assert.equal(buildTitle({ ...input, state: 'working', frame: 2 }), '◆ pager ⠹ ● bob')
  assert.equal(buildTitle({ ...input, state: 'working', frame: TITLE_SPINNER.length }), buildTitle({ ...input, state: 'working', frame: 0 }))
})

test('unread comes first and caps at 99+; an empty label leaves just the brand', () => {
  assert.equal(buildTitle({ ...input, unread: 3 }), '(3) ◆ pager > ● bob')
  assert.equal(buildTitle({ ...input, unread: 120 }), '(99+) ◆ pager > ● bob')
  assert.equal(buildTitle({ ...input, label: '' }), '◆ pager >')
})

test('control characters never reach the terminal and a long label is cut', () => {
  const title = buildTitle({ ...input, label: '\x1b[31mevil\x07 name' })
  assert.equal(/\p{Cc}/u.test(title), false)
  assert.ok(title.includes('evil'))
  assert.equal([...buildTitle({ ...input, label: 'x'.repeat(100) })].length, '◆ pager > '.length + 40)
})

test('every place has a label; a DM shows whether the contact is online, a document its name', () => {
  const at = (kind: Place['kind'], title = ''): Place => ({ kind, title })
  assert.equal(titleLabel(at('home'), false), '⌂ home')
  assert.equal(titleLabel(at('dm', 'bob'), true), '● bob')
  assert.equal(titleLabel(at('dm', 'bob'), false), '○ bob')
  assert.equal(titleLabel(at('group', 'team'), false), '# team')
  assert.equal(titleLabel(at('hub'), false), '⌁ agents')
  assert.equal(titleLabel(at('agent', 'omp'), false), '⌁ omp')
  assert.equal(titleLabel(at('terminal'), false), '▸ terminal')
  assert.equal(titleLabel(at('docs', 'plan.md'), false), '▤ plan.md')
  assert.equal(titleLabel(at('docs'), false), '▤ docs')
  assert.equal(titleLabel(at('shared', 'ann'), false), "◈ ann's agents")
})
