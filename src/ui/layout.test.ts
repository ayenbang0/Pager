import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MessageView } from '../engine.js'
import { buildLines, windowLines, type Line } from './layout.js'

const NOW = new Date(2024, 4, 10, 15, 0)

function msg(over: Partial<MessageView>): MessageView {
  return {
    key: 'k',
    ts: new Date(2024, 4, 10, 9, 5).getTime(),
    authorName: 'bob',
    authorKey: 'ab'.repeat(32),
    mine: false,
    kind: 'text',
    text: 'hi',
    status: null,
    ...over,
  }
}
const plain = (l: Line): string => l.segs.map((s) => s.text).join('')

test('wrapped continuation lines indent to the body column', () => {
  const lines = buildLines([msg({ text: 'aaaa bbbb cccc dddd eeee ffff' })], 28, NOW)
  assert.ok(lines.length > 1)
  assert.equal(plain(lines[0]!).startsWith('09:05 bob  aaaa'), true)
  const bodyCol = '09:05 bob  '.length
  for (const l of lines.slice(1)) assert.equal(plain(l).startsWith(' '.repeat(bodyCol)), true)
  for (const l of lines) assert.ok(plain(l).length <= 28)
})

test('date prefix only when the message is not from today', () => {
  const old = msg({ ts: new Date(2024, 4, 9, 23, 59).getTime() })
  assert.equal(plain(buildLines([old], 60, NOW)[0]!).startsWith('05-09 23:59 bob'), true)
})

test('own message status markers sit at the end of the last line', () => {
  const pending = buildLines([msg({ mine: true, status: 'pending' })], 40, NOW)
  assert.equal(plain(pending.at(-1)!).endsWith(' …'), true)
  const delivered = buildLines([msg({ mine: true, status: 'delivered' })], 40, NOW)
  assert.equal(plain(delivered.at(-1)!).endsWith(' ✓'), true)
})

test('system messages are dim italic with no author column', () => {
  const [line] = buildLines([msg({ kind: 'system', text: 'bob left' })], 40, NOW)
  assert.deepEqual(line?.segs, [{ text: '* bob left', dim: true, italic: true }])
})

test('windowLines keeps the newest lines at offset 0 and clamps offsets', () => {
  const lines: Line[] = Array.from({ length: 10 }, (_, i) => ({ key: String(i), segs: [] }))
  assert.deepEqual(windowLines(lines, 4, 0).visible.map((l) => l.key), ['6', '7', '8', '9'])
  assert.deepEqual(windowLines(lines, 4, 2).visible.map((l) => l.key), ['4', '5', '6', '7'])
  const far = windowLines(lines, 4, 99)
  assert.equal(far.maxOffset, 6)
  assert.deepEqual(far.visible.map((l) => l.key), ['0', '1', '2', '3'])
  assert.deepEqual(windowLines(lines, 20, 5).visible.length, 10)
})
