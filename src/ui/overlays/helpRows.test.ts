import assert from 'node:assert/strict'
import { test } from 'node:test'
import stringWidth from 'string-width'
import { COMMANDS } from '../../app/commands.js'
import { helpKeyColumn, helpRows, scrollThumb, type HelpRow } from './helpRows.js'
import { COMMAND_SECTION, KEY_SECTIONS } from '../input/keymap.js'

const SECTIONS = [...KEY_SECTIONS, COMMAND_SECTION]
const bodyRows = (rows: readonly HelpRow[]): Extract<HelpRow, { kind: 'row' }>[] => rows.filter((r) => r.kind === 'row')

test('sections come in the documented order and end with the generated command list', () => {
  assert.deepEqual(
    SECTIONS.map((s) => s.title),
    ['Move around', 'Write', 'Copy and paste', 'Chats and agents', 'Agents', 'When an agent asks you', 'Settings tab', 'Terminal tab', 'Docs tab (vim)', 'Commands', 'Leave', 'All commands'],
  )
})

test('All commands lists every command usage and summary, so the list cannot drift', () => {
  assert.deepEqual(COMMAND_SECTION.rows, COMMANDS.map((c) => [c.usage, c.summary]))
  const rows = bodyRows(helpRows([COMMAND_SECTION], 100))
  const keys = rows.map((r) => r.keys).join(' ')
  for (const c of COMMANDS) {
    assert.ok(keys.includes(c.usage), c.usage)
    assert.ok(rows.some((r) => r.text === c.summary), c.summary)
  }
  assert.ok(rows.some((r) => r.keys === '/exit'))
})

test('rows fit their columns at any width, counting drawn display width, and sections are separated by a blank row', () => {
  for (const width of [30, 58, 90, 115]) {
    const rows = helpRows(SECTIONS, width)
    for (const row of bodyRows(rows)) {
      assert.ok(row.keyWidth < helpKeyColumn(width), `${row.keys} @${width}`)
      assert.equal(
        row.keyWidth,
        row.pieces.reduce((sum, p) => sum + stringWidth(p.text) + (p.style === 'cap' ? 2 : 0), 0),
      )
      assert.ok(stringWidth(row.text) <= Math.max(12, width - helpKeyColumn(width)), `${row.text} @${width}`)
      assert.ok(row.detailFrom >= 0 && row.detailFrom <= row.text.length)
    }
    assert.equal(rows.filter((r) => r.kind === 'section').length, SECTIONS.length)
    assert.equal(rows.filter((r) => r.kind === 'gap').length, SECTIONS.length - 1)
    assert.equal(rows[0]?.kind, 'section')
  }
})

test('the key column grows on wide panes', () => {
  assert.ok(helpKeyColumn(120) > helpKeyColumn(52))
})

test('an action too long for its column wraps onto continuation rows with an empty key', () => {
  const rows = bodyRows(helpRows([{ title: 'T', rows: [['Ctrl+X', 'one two three four five six seven eight nine ten']] }], 40))
  assert.ok(rows.length >= 2)
  assert.equal(rows[0]?.keys, 'Ctrl+X')
  assert.ok(rows.slice(1).every((r) => r.keys === '' && r.keyWidth === 0))
  assert.equal(rows.map((r) => r.text).join(' '), 'one two three four five six seven eight nine ten')
})

test('a key too long for the key column wraps too, and wide characters are measured by width', () => {
  const [, long] = helpRows([{ title: 'T', rows: [['Ctrl+C / Ctrl+V / Ctrl+Z / Ctrl+Y', 'copy']] }], 100)
  assert.equal(long?.kind === 'row' ? long.keys : undefined, 'Ctrl+C / Ctrl+V / Ctrl+Z')
  const wide = bodyRows(helpRows([{ title: 'T', rows: [['日本語日本語日本語日本語日本語日本語日本語日本語', 'x']] }], 80))
  assert.ok(wide.length >= 2)
  assert.ok(wide.every((r) => r.keyWidth < helpKeyColumn(80)))
})

test('alternatives become keycaps joined by separators, commands and phrases stay accent text', () => {
  const [, combo, slash, mixed, plain] = helpRows(
    [
      {
        title: 'T',
        rows: [
          ['Alt+Up / Alt+Down', 'a'],
          ['/quit  /exit', 'b'],
          ['PgUp / PgDn / wheel', 'c'],
          ['Drag with the mouse', 'd'],
        ],
      },
    ],
    100,
  )
  assert.deepEqual(combo?.kind === 'row' ? combo.pieces : [], [
    { text: 'Alt+Up', style: 'cap' },
    { text: ' / ', style: 'sep' },
    { text: 'Alt+Down', style: 'cap' },
  ])
  assert.deepEqual(slash?.kind === 'row' ? slash.pieces : [], [{ text: '/quit  /exit', style: 'text' }])
  assert.deepEqual(
    mixed?.kind === 'row' ? mixed.pieces.map((p) => p.style) : [],
    ['cap', 'sep', 'cap', 'sep', 'text'],
  )
  assert.deepEqual(plain?.kind === 'row' ? plain.pieces : [], [{ text: 'Drag with the mouse', style: 'text' }])
})

test('the part of an action after the first colon, semicolon or parenthesis is detail, also across wrapped lines', () => {
  const [, one] = helpRows([{ title: 'T', rows: [['Ctrl+P', 'Command palette: every action, searchable']] }], 100)
  assert.ok(one?.kind === 'row')
  assert.equal(one.text.slice(0, one.detailFrom), 'Command palette:')
  const rows = bodyRows(helpRows([{ title: 'T', rows: [['Esc', 'Clear it (closes help and the palette, and a few more things besides)']] }], 50))
  assert.ok(rows.length >= 2)
  assert.equal(rows[0]?.text.slice(0, rows[0].detailFrom), 'Clear it ')
  assert.equal(rows[1]?.detailFrom, 0)
  const none = bodyRows(helpRows([{ title: 'T', rows: [['Esc', 'Nothing special here']] }], 100))[0]
  assert.equal(none?.detailFrom, none?.text.length)
})

test('an agent section carries its agent so the panel can color it', () => {
  const rows = helpRows([{ title: 'Agent omp (omp)', rows: [['commands', 'None']], agent: 'omp' }, COMMAND_SECTION], 100)
  assert.deepEqual(rows[0], { kind: 'section', text: 'AGENT OMP (OMP)', agent: 'omp' })
  const all = rows.find((r) => r.kind === 'section' && r.text === 'ALL COMMANDS')
  assert.deepEqual(all, { kind: 'section', text: 'ALL COMMANDS' })
})

test('the scrollbar thumb tracks the position and is absent when everything fits', () => {
  assert.equal(scrollThumb(10, 10, 0), undefined)
  assert.deepEqual(scrollThumb(40, 10, 0), { start: 0, size: 3 })
  assert.deepEqual(scrollThumb(40, 10, 30), { start: 7, size: 3 })
  assert.deepEqual(scrollThumb(40, 10, 99), { start: 7, size: 3 })
  const mid = scrollThumb(40, 10, 15)
  assert.ok(mid !== undefined && mid.start > 0 && mid.start + mid.size < 10)
  assert.deepEqual(scrollThumb(2, 1, 1), { start: 0, size: 1 })
})
