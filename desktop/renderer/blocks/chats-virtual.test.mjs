// node --test desktop/renderer/blocks/chats-virtual.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FlowLayout, anchorScrollTop, estimateRow, nearBottom } from './chats-virtual.js'

const items = (n) => Array.from({ length: n }, (_, i) => ({ key: 'k' + i, type: 'msg', msg: { text: 'x' }, pos: 'single' }))

test('offsets use measured heights over estimates', () => {
  const l = new FlowLayout(() => 50)
  l.setItems(items(10))
  assert.equal(l.topOf(3), 150)
  assert.equal(l.setHeight('k1', 80), true)
  assert.equal(l.setHeight('k1', 80), false)
  assert.equal(l.topOf(3), 180)
  assert.equal(l.total, 530)
})

test('range covers the viewport plus overscan and clamps', () => {
  const l = new FlowLayout(() => 100)
  l.setItems(items(100))
  assert.deepEqual(l.range(0, 300, 0), { start: 0, end: 4 })
  assert.deepEqual(l.range(1000, 300, 100), { start: 9, end: 15 })
  assert.deepEqual(l.range(99999, 300, 100), { start: 99, end: 100 })
  const empty = new FlowLayout()
  assert.deepEqual(empty.range(0, 500), { start: 0, end: 0 })
})

test('indexAt binary search matches a linear scan on uneven heights', () => {
  const l = new FlowLayout(() => 0)
  const its = items(500)
  l.setItems(its)
  its.forEach((it, i) => l.setHeight(it.key, 20 + ((i * 37) % 90)))
  for (const y of [0, 1, 19, 20, 500, 12345, 20000, l.total - 1]) {
    let lin = 0
    for (let i = 0; i < its.length; i++) if (l.topOf(i) <= y) lin = i
    assert.equal(l.indexAt(y), lin, 'y=' + y)
  }
})

test('anchoring keeps a row still when rows above grow or older rows are prepended', () => {
  const l = new FlowLayout(() => 50)
  const its = items(20)
  l.setItems(its)
  // user looks at k10, 30px below the viewport top
  const scrollTop = l.topOf(10) - 30
  const anchorOffset = l.topOf(10) - scrollTop
  // a row above measures 40px taller
  l.setHeight('k2', 90)
  assert.equal(anchorScrollTop(l, 'k10', anchorOffset), scrollTop + 40)
  // 5 older rows prepended
  const older = Array.from({ length: 5 }, (_, i) => ({ key: 'o' + i, type: 'msg', msg: { text: 'y' }, pos: 'single' }))
  l.setItems([...older, ...its])
  assert.equal(anchorScrollTop(l, 'k10', anchorOffset), scrollTop + 40 + 250)
  assert.equal(anchorScrollTop(l, 'gone', 0), null)
})

test('near bottom', () => {
  assert.equal(nearBottom(900, 100, 1000), true)
  assert.equal(nearBottom(800, 100, 1000), false)
  assert.equal(nearBottom(0, 100, 100), true)
})

test('estimates grow with text, replies, reactions and images', () => {
  const base = { type: 'msg', pos: 'single', showName: false, msg: { text: 'hi', reactions: [], attachments: [] } }
  const long = { ...base, msg: { ...base.msg, text: 'word '.repeat(200) } }
  const img = { ...base, msg: { ...base.msg, attachments: [{ mime: 'image/png' }] } }
  assert.ok(estimateRow(long) > estimateRow(base) * 3)
  assert.ok(estimateRow(img) > estimateRow(base) + 150)
  assert.equal(estimateRow({ type: 'day' }), 44)
})
