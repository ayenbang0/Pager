import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_THEME as theme } from '../theme/themes.js'
import { segsWidth, type Seg } from './segs.js'
import { cardBottom, cardRow, cardTop, chip, dot, edgeColor, hairline, raisedFill, relativeTime, ruleRow, tabPills, titleRow } from './tern.js'

const text = (segs: Seg[]): string => segs.map((s) => s.text).join('')
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0)

test('relative time: now, minutes, hours, days, weeks, months, years; the future reads as now', () => {
  const ago = (ms: number): string => relativeTime(NOW - ms, NOW)
  assert.equal(ago(0), 'now')
  assert.equal(ago(44_000), 'now')
  assert.equal(ago(45_000), '1m')
  assert.equal(ago(59 * 60_000 + 59_000), '59m')
  assert.equal(ago(60 * 60_000), '1h')
  assert.equal(ago(23 * 3_600_000 + 59 * 60_000), '23h')
  assert.equal(ago(24 * 3_600_000), '1d')
  assert.equal(ago(6 * 86_400_000), '6d')
  assert.equal(ago(7 * 86_400_000), '1w')
  assert.equal(ago(34 * 86_400_000), '4w')
  assert.equal(ago(35 * 86_400_000), '1mo')
  assert.equal(ago(364 * 86_400_000), '12mo')
  assert.equal(ago(365 * 86_400_000), '1y')
  assert.equal(relativeTime(NOW + 5_000, NOW), 'now')
  assert.equal(relativeTime(Number.NaN, NOW), 'now')
})

test('card edges and rows are exactly the width, with rounded corners and quiet hairlines', () => {
  for (const width of [0, 1, 2, 3, 4, 5, 12, 40]) {
    assert.equal(segsWidth(cardTop(width, theme)), width, `top ${width}`)
    assert.equal(segsWidth(cardBottom(width, theme)), width, `bottom ${width}`)
    assert.equal(segsWidth(cardRow([{ text: 'hello' }], width, theme)), width, `row ${width}`)
  }
  assert.equal(text(cardTop(8, theme)), '╭──────╮')
  assert.equal(text(cardBottom(8, theme)), '╰──────╯')
  assert.equal(text(cardRow([{ text: 'hi' }], 10, theme)), '│ hi     │')
  assert.ok(cardTop(8, theme).every((s) => s.color === theme.border), 'resting edges use the border color')
  assert.ok(cardTop(8, theme, { focused: true }).every((s) => s.color === theme.accent), 'a focused card edge is the accent')
  assert.equal(edgeColor(theme, true), theme.accent)
})

test('edge inserts sit on the hairline; the right one drops first, the left one is clipped last', () => {
  const left: Seg[] = [{ text: 'alice' }]
  const right: Seg[] = [{ text: 'send' }]
  assert.equal(text(cardTop(20, theme, { left, right })), '╭─ alice ─── send ─╮')
  assert.equal(text(cardBottom(20, theme, { right })), '╰─────────── send ─╯')
  assert.equal(text(cardTop(11, theme, { left, right })), '╭─ alice ─╮')
  for (const width of [3, 6, 9, 10]) {
    const row = cardTop(width, theme, { left: [{ text: '漢字漢字漢字' }], right })
    assert.equal(segsWidth(row), width, `wide text in ${width}`)
  }
})

test('card rows clip wide content to the room between the sides', () => {
  const row = cardRow([{ text: '漢字漢字漢字漢字' }], 10, theme)
  assert.equal(segsWidth(row), 10)
  assert.ok(text(row).startsWith('│ ') && text(row).endsWith(' │'))
})

test('a rule row puts the left text, a hairline and the right text on one exact row', () => {
  for (const width of [0, 1, 5, 12, 40]) {
    assert.equal(segsWidth(ruleRow([{ text: 'title' }], [{ text: 'note' }], width, theme)), width, `${width}`)
  }
  assert.equal(text(ruleRow([{ text: 'ab' }], [{ text: 'cd' }], 12, theme)), 'ab ───── cd ')
  assert.equal(text(ruleRow([{ text: 'ab' }], [], 8, theme)), 'ab ─────')
  assert.equal(text(ruleRow([{ text: 'abcdefgh' }], [{ text: 'note' }], 8, theme)), 'abcdefgh', 'the note gives way to the title')
})

test('tab pills raise only the active one; chips sit on the soft fill; dots carry their color', () => {
  const tabs = tabPills(['Home', 'Chats', 'Tools'], 1, theme)
  assert.equal(text(tabs), ' Home   Chats   Tools ')
  assert.deepEqual(
    tabs.filter((s) => s.bg !== undefined).map((s) => s.text),
    [' Chats '],
  )
  assert.equal(tabs.find((s) => s.text === ' Chats ')?.bg, raisedFill(theme))
  assert.equal(chip('alice', theme).bg, theme.pill.muted.bg)
  assert.equal(chip('alice', theme, 'accent').bg, theme.pill.accent.bg)
  assert.equal(dot('#00ff00').color, '#00ff00')
  assert.equal(dot('#00ff00', true).text, '○')
  assert.equal(text(hairline(3, theme)), '───')
  assert.deepEqual(hairline(0, theme), [])
})

test('a title row is a raised chip, a hairline and a dim note, exactly the width', () => {
  for (const width of [0, 4, 12, 40, 100]) {
    assert.equal(segsWidth(titleRow('alice', 'online · typing', width, theme, dot('#00ff88'))), width, `${width}`)
  }
  const row = titleRow('alice', 'note', 30, theme, dot('#00ff88'))
  assert.equal(text(row), ' ● alice  ────────────── note ')
  assert.equal(row[0]?.bg, raisedFill(theme))
  assert.equal(row.find((s) => s.text === 'alice')?.bold, true)
  assert.equal(row.find((s) => s.text === '●')?.bg, raisedFill(theme), 'the lead glyph sits on the chip')
  assert.equal(text(titleRow('HELP', undefined, 12, theme)), ' HELP  ─────')
})
