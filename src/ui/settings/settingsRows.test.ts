import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { test } from 'node:test'
import { segsWidth } from '../kit/segs.js'
import { DEFAULT_THEME } from '../theme/themes.js'
import { firstCursor, settingsKey, settingsRowSegs, type SettingsRow, type SettingsState } from './settingsRows.js'

const rows: SettingsRow[] = [
  { kind: 'section', section: 'profile', title: 'Profile' },
  { kind: 'text', id: 'name', label: 'Display name', value: 'alice' },
  { kind: 'info', label: 'Version', value: 'pager 1' },
  { kind: 'toggle', id: 'mouse', label: 'Mouse', value: true },
  { kind: 'toggle', id: 'alerts', label: 'Alerts', value: false, locked: 'PAGER_NO_NOTIFY' },
  { kind: 'choice', id: 'density', label: 'Density', options: ['compact', 'cozy', 'roomy'], value: 'cozy' },
  { kind: 'choice', id: 'badge', label: 'Badge', options: ['auto', 'none'], value: 'auto', custom: true },
  { kind: 'action', id: 'wipe', label: 'Wipe', confirm: true },
  { kind: 'action', id: 'code', label: 'Code', value: 'abc' },
  { kind: 'section', section: 'folders', title: 'Folders' },
  { kind: 'text', id: 'folder:work', label: 'work', value: '2 chats' },
]
const at = (cursor: number): SettingsState => ({ cursor, confirming: null })

test('Up and Down skip headers and info rows and wrap', () => {
  assert.equal(firstCursor(rows), 1)
  assert.equal(settingsKey(at(1), rows, { input: '', downArrow: true }).state.cursor, 3)
  assert.equal(settingsKey(at(3), rows, { input: '', upArrow: true }).state.cursor, 1)
  assert.equal(settingsKey(at(1), rows, { input: '', upArrow: true }).state.cursor, 10)
  assert.equal(settingsKey(at(10), rows, { input: '', downArrow: true }).state.cursor, 1)
})

test('Home, End and paging land on selectable rows', () => {
  assert.equal(settingsKey(at(5), rows, { input: '', home: true }).state.cursor, 1)
  assert.equal(settingsKey(at(5), rows, { input: '', end: true }).state.cursor, 10)
  assert.equal(settingsKey(at(1), rows, { input: '', pageDown: true }).state.cursor, 10)
  assert.equal(settingsKey(at(10), rows, { input: '', pageUp: true }).state.cursor, 1)
})

test('toggles flip with Enter or Space and are set by Left and Right', () => {
  assert.deepEqual(settingsKey(at(3), rows, { input: '', return: true }).effect, { kind: 'set', id: 'mouse', value: false })
  assert.deepEqual(settingsKey(at(3), rows, { input: ' ' }).effect, { kind: 'set', id: 'mouse', value: false })
  assert.deepEqual(settingsKey(at(3), rows, { input: '', leftArrow: true }).effect, { kind: 'set', id: 'mouse', value: false })
  assert.deepEqual(settingsKey(at(3), rows, { input: '', rightArrow: true }).effect, { kind: 'set', id: 'mouse', value: true })
})

test('choices cycle with wraparound; a custom choice edits on Enter', () => {
  assert.deepEqual(settingsKey(at(5), rows, { input: '', rightArrow: true }).effect, { kind: 'set', id: 'density', value: 'roomy' })
  assert.deepEqual(settingsKey(at(5), rows, { input: '', leftArrow: true }).effect, { kind: 'set', id: 'density', value: 'compact' })
  assert.deepEqual(settingsKey(at(5), rows, { input: '', return: true }).effect, { kind: 'set', id: 'density', value: 'roomy' })
  assert.deepEqual(settingsKey(at(6), rows, { input: '', return: true }).effect, { kind: 'edit', id: 'badge' })
  assert.deepEqual(settingsKey(at(6), rows, { input: '', rightArrow: true }).effect, { kind: 'set', id: 'badge', value: 'none' })
  assert.deepEqual(settingsKey(at(6), rows, { input: '', leftArrow: true }).effect, { kind: 'set', id: 'badge', value: 'none' })
})

test('text rows edit; plain actions run', () => {
  assert.deepEqual(settingsKey(at(1), rows, { input: '', return: true }).effect, { kind: 'edit', id: 'name' })
  assert.deepEqual(settingsKey(at(8), rows, { input: '', return: true }).effect, { kind: 'run', id: 'code' })
})

test('a confirm action needs a second Enter, and any move cancels it', () => {
  const first = settingsKey(at(7), rows, { input: '', return: true })
  assert.equal(first.effect, undefined)
  assert.equal(first.state.confirming, 'wipe')
  const second = settingsKey(first.state, rows, { input: '', return: true })
  assert.deepEqual(second.effect, { kind: 'run', id: 'wipe' })
  assert.equal(second.state.confirming, null)
  const moved = settingsKey(first.state, rows, { input: '', downArrow: true })
  assert.equal(moved.state.confirming, null)
  assert.equal(settingsKey(at(7), rows, { input: '', return: true }).effect, undefined)
})

test('a locked row reports its source instead of changing', () => {
  for (const press of [{ input: '', return: true }, { input: '', rightArrow: true }, { input: ' ' }]) {
    assert.deepEqual(settingsKey(at(4), rows, press).effect, { kind: 'locked', source: 'PAGER_NO_NOTIFY' })
  }
})

test('[ and ] reorder a folder row only', () => {
  assert.deepEqual(settingsKey(at(10), rows, { input: '[' }).effect, { kind: 'run', id: 'folder-up:work' })
  assert.deepEqual(settingsKey(at(10), rows, { input: ']' }).effect, { kind: 'run', id: 'folder-down:work' })
  assert.equal(settingsKey(at(1), rows, { input: ']' }).effect, undefined)
})

test('every row is exactly the requested width, selected or not, with wide characters', () => {
  const wide: SettingsRow[] = [
    ...rows,
    { kind: 'text', id: 'x', label: '漢字の名前 and a very long label that cannot possibly fit', value: '🚀🚀🚀 長い値' },
    { kind: 'choice', id: 'badge2', label: 'Badge 🔥', options: ['🚀'], value: '🚀', custom: true },
  ]
  for (const width of [60, 30, 12]) {
    for (const row of wide) {
      for (const selected of [false, true]) {
        const segs = settingsRowSegs(row, selected, width, DEFAULT_THEME, row.kind === 'action')
        assert.equal(segsWidth(segs), width, `${width} ${JSON.stringify(row)}`)
        assert.equal(stringWidth(segs.map((s) => s.text).join('')), width)
      }
    }
  }
})

test('a confirming action row shows the second-Enter prompt', () => {
  const text = settingsRowSegs(rows[7]!, true, 60, DEFAULT_THEME, true).map((s) => s.text).join('')
  assert.match(text, /Press Enter again to confirm/)
})
