import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paletteColor, readScreen } from './screen.js'
import { newTerm } from './xterm.js'

const feed = async (data: string, cols = 20, rows = 4) => {
  const term = newTerm({ cols, rows, allowProposedApi: true })
  await new Promise<void>((r) => term.write(data, r))
  return term
}

test('named, 256-color and truecolor foregrounds', async () => {
  const term = await feed('\x1b[31mred\x1b[0m \x1b[38;5;196mx\x1b[0m\x1b[38;2;1;2;3my\x1b[0m')
  const [r] = readScreen(term, true).rows
  assert.equal(r?.[0]?.text, 'red')
  assert.equal(r?.[0]?.color, 'red')
  assert.equal(r?.[2]?.color, '#ff0000')
  assert.equal(r?.[3]?.color, '#010203')
})

test('bright palette entries and the gray ramp', () => {
  assert.equal(paletteColor(9), 'redBright')
  assert.equal(paletteColor(232), '#080808')
  assert.equal(paletteColor(231), '#ffffff')
})

test('attributes map onto the Seg fields', async () => {
  const term = await feed('\x1b[1;3;4;9mA\x1b[0m\x1b[7mB')
  const [a, b] = readScreen(term, true).rows[0] ?? []
  assert.deepEqual([a?.bold, a?.italic, a?.underline, a?.strike], [true, true, true, true])
  assert.equal(b?.inverse, true)
})

test('trailing default blanks are dropped, styled blanks are kept', async () => {
  const term = await feed('ab   \x1b[44m  \x1b[0m   ')
  const row = readScreen(term, true).rows[0] ?? []
  assert.equal(row.map((s) => s.text).join(''), 'ab     ')
  assert.equal(row.at(-1)?.bg, 'blue')
})

test('wide glyphs occupy one cell worth of text', async () => {
  const term = await feed('a漢b')
  assert.equal((readScreen(term, true).rows[0] ?? []).map((s) => s.text).join(''), 'a漢b')
})

test('the cursor cell is inverse only when visible', async () => {
  const term = await feed('hi')
  const shown = readScreen(term, false)
  assert.deepEqual(shown.cursor, { x: 2, y: 0 })
  assert.equal(shown.rows[0]?.at(-1)?.inverse, true)
  assert.equal(shown.rows[0]?.at(-1)?.text, ' ')
  const hidden = readScreen(term, true)
  assert.equal(hidden.cursor, null)
  assert.equal(hidden.rows[0]?.map((s) => s.text).join(''), 'hi')
})

test('reports scrollback position, alt screen and mouse mode', async () => {
  const term = await feed('1\r\n2\r\n3\r\n4\r\n5\r\n6')
  const v = readScreen(term, true)
  assert.equal(v.top, 2)
  assert.equal(v.atBottom, true)
  term.scrollLines(-1)
  assert.equal(readScreen(term, false).cursor, null)
  assert.equal(readScreen(term, false).atBottom, false)
  await new Promise<void>((r) => term.write('\x1b[?1000h\x1b[?1049h', r))
  const alt = readScreen(term, true)
  assert.equal(alt.alt, true)
  assert.equal(alt.mouse, true)
})
