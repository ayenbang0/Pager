import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MessageView } from '../engine.js'
import { DEFAULT_THEME, findTheme } from '../themes.js'
import { buildLines, windowLines, type Line } from './layout.js'

const NOW = new Date(2024, 4, 10, 15, 0)
const T = DEFAULT_THEME

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
  const lines = buildLines([msg({ text: 'aaaa bbbb cccc dddd eeee ffff' })], 28, T, NOW)
  assert.ok(lines.length > 1)
  assert.equal(plain(lines[0]!).startsWith('09:05 bob  aaaa'), true)
  const bodyCol = '09:05 bob  '.length
  for (const l of lines.slice(1)) assert.equal(plain(l).startsWith(' '.repeat(bodyCol)), true)
  for (const l of lines) assert.ok(plain(l).length <= 28)
})

test('date prefix only when the message is not from today', () => {
  const old = msg({ ts: new Date(2024, 4, 9, 23, 59).getTime() })
  assert.equal(plain(buildLines([old], 60, T, NOW)[0]!).startsWith('05-09 23:59 bob'), true)
})

test('own message status markers sit at the end of the last line', () => {
  const pending = buildLines([msg({ mine: true, status: 'pending' })], 40, T, NOW)
  assert.equal(plain(pending.at(-1)!).endsWith(' …'), true)
  const delivered = buildLines([msg({ mine: true, status: 'delivered' })], 40, T, NOW)
  assert.equal(plain(delivered.at(-1)!).endsWith(' ✓'), true)
})

test('system messages are dim italic with no author column', () => {
  const [line] = buildLines([msg({ kind: 'system', text: 'bob left' })], 40, T, NOW)
  assert.deepEqual(line?.segs, [{ text: '* bob left', dim: true, italic: true }])
})

test('author and status colors come from the theme', () => {
  const ocean = findTheme('ocean')!
  const [mine] = buildLines([msg({ mine: true, status: 'delivered' })], 40, ocean, NOW)
  assert.equal(mine?.segs.find((s) => s.text === 'bob')?.color, ocean.mine)
  assert.equal(mine?.segs.find((s) => s.text === ' ✓')?.color, ocean.success)
  const [other] = buildLines([msg({})], 40, ocean, NOW)
  assert.ok(ocean.authors.includes(other?.segs.find((s) => s.text === 'bob')?.color ?? ''))
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

const long = (rows: number): string => Array.from({ length: rows }, (_, i) => `row ${i}`).join('\n')

test('a long text message folds to head + marker + tail; the marker row carries the fold key', () => {
  const lines = buildLines([msg({ text: long(40) })], 80, T, NOW)
  assert.equal(lines.length, 12 + 1 + 6)
  assert.deepEqual(lines.flatMap((l, i) => (l.fold === undefined ? [] : [i])), [12])
  assert.equal(lines[0]?.fold, undefined)
  assert.match(plain(lines[12]!), /▸ 22 more lines/)
  assert.equal(lines[12]?.fold, 'k')
  assert.match(plain(lines.at(-1)!), /row 39$/)
})

test('expanded, disabled and system messages are never folded', () => {
  assert.equal(buildLines([msg({ text: long(40) })], 80, T, NOW, { enabled: true, expanded: new Set(['k']) }).length, 40)
  assert.equal(buildLines([msg({ text: long(40) })], 80, T, NOW, { enabled: false, expanded: new Set() }).length, 40)
  assert.equal(buildLines([msg({ kind: 'system', text: long(40) })], 80, T, NOW).length, 40)
})

test('markdown messages render headings, bullets, code fences and inline spans', () => {
  const text = '# Title\n- item `x` and **b**\n```js\nlet a\n```'
  const lines = buildLines([msg({ text, markdown: true })], 80, T, NOW)
  assert.deepEqual(lines.map((l) => plain(l).slice('09:05 bob  '.length).trimStart()), ['Title', '• item x and b', '▎ js', '▎ let a'])
  assert.deepEqual(lines[0]?.segs.at(-1), { text: 'Title', bold: true, color: T.accent })
  assert.deepEqual(lines[1]?.segs.find((s) => s.text === 'x'), { text: 'x', color: T.info })
  assert.deepEqual(lines[1]?.segs.find((s) => s.text === 'b'), { text: 'b', bold: true })
  assert.equal(lines[3]?.segs.at(-1)?.color, T.info)
})

test('the same text without the markdown flag stays literal', () => {
  const lines = buildLines([msg({ text: '# Title\n`x`' })], 80, T, NOW)
  assert.deepEqual(lines.map((l) => plain(l).slice('09:05 bob  '.length).trimStart()), ['# Title', '`x`'])
})
