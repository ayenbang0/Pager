import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_THEME as theme } from '../theme/themes.js'
import { fieldSegs, footerSegs, listWindow, moreSegs, tailWidth, wrapWords } from './overlayRows.js'
import { segsWidth, type Seg } from '../kit/segs.js'

const text = (segs: Seg[]): string => segs.map((s) => s.text).join('')

test('listWindow centres on the cursor and reports what hides', () => {
  assert.deepEqual(listWindow(20, 10, 5), { start: 8, end: 13, above: 8, below: 7 })
  assert.deepEqual(listWindow(20, 0, 5), { start: 0, end: 5, above: 0, below: 15 })
  assert.deepEqual(listWindow(20, 19, 5), { start: 15, end: 20, above: 15, below: 0 })
  assert.deepEqual(listWindow(3, 1, 10), { start: 0, end: 3, above: 0, below: 0 })
  assert.deepEqual(listWindow(0, 0, 4), { start: 0, end: 0, above: 0, below: 0 })
})

test('moreSegs shows pills only for the hidden sides', () => {
  assert.equal(text(moreSegs(0, 0, theme)), '')
  assert.equal(text(moreSegs(2, 0, theme)), ' ▲ 2 more ')
  assert.equal(text(moreSegs(0, 5, theme)), ' ▼ 5 more ')
  assert.equal(text(moreSegs(2, 5, theme)), ' ▲ 2 more   ▼ 5 more ')
  assert.equal(moreSegs(1, 1, theme)[0]?.bg, theme.pill.muted.bg)
})

test('the footer is exactly the width and keeps the right side, dropping hints from the end', () => {
  const hints = [['↑↓', 'move'], ['Enter', 'run'], ['Esc', 'close']] as const
  const right = moreSegs(3, 4, theme)
  for (const width of [80, 50, 30, 24]) {
    const row = footerSegs(hints, right, width, theme)
    assert.equal(segsWidth(row), width, `width ${width}`)
    assert.ok(text(row).endsWith(text(right)), `right kept at ${width}`)
  }
  assert.match(text(footerSegs(hints, right, 80, theme)), /Esc.*close/)
  assert.doesNotMatch(text(footerSegs(hints, right, 30, theme)), /Esc/)
  assert.match(text(footerSegs(hints, right, 30, theme)), /move/)
})

test('tailWidth keeps the end by display width', () => {
  assert.equal(tailWidth('abcdef', 3), 'def')
  assert.equal(tailWidth('漢字漢字', 5), '漢字')
  assert.equal(tailWidth('ab', 10), 'ab')
  assert.equal(tailWidth('ab', 0), '')
})

test('fieldSegs fills the width on the surface, shows the cursor and a placeholder', () => {
  const prefix: Seg[] = [{ text: '❯ ' }]
  const empty = fieldSegs(prefix, { before: '', at: '', after: '' }, 'type here', true, 30, theme)
  assert.equal(segsWidth(empty), 30)
  assert.match(text(empty), /❯ ▁type here/)
  const typed = fieldSegs(prefix, { before: 'abc', at: '', after: '' }, 'type here', true, 30, theme)
  assert.match(text(typed), /abc▁/)
  assert.doesNotMatch(text(typed), /type here/)
  const mid = fieldSegs(prefix, { before: 'a', at: 'b', after: 'c' }, '', true, 30, theme)
  assert.equal(mid.find((s) => s.inverse === true)?.text, 'b')
  const blurred = fieldSegs(prefix, { before: 'abc', at: '', after: '' }, '', false, 30, theme)
  assert.doesNotMatch(text(blurred), /▁/)
  assert.ok(blurred.every((s) => s.bg === theme.surface || s.text === '❯ '))
})

test('a long field keeps its tail and never exceeds the width, with wide characters', () => {
  for (const width of [30, 12, 6]) {
    const long = fieldSegs([{ text: '❯ ' }], { before: '漢字'.repeat(40), at: '', after: '' }, '', true, width, theme)
    assert.equal(segsWidth(long), width)
    assert.ok(text(long).endsWith('▁') || text(long).trimEnd().endsWith('▁'))
  }
})

test('wrapWords wraps at spaces by display width and cuts overlong words', () => {
  assert.deepEqual(wrapWords('one two three four', 9), ['one two', 'three', 'four'])
  assert.deepEqual(wrapWords('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
  assert.deepEqual(wrapWords('', 5), [])
  for (const line of wrapWords('漢字 漢字漢字 漢', 4)) assert.ok(segsWidth([{ text: line }]) <= 4)
})
