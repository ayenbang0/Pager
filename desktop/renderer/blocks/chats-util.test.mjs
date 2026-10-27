// node --test desktop/renderer/blocks/chats-util.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dayNumber, fmtClock, fmtDay, fmtListTime, fmtSize, hueIndex, initials, isEmojiOnly, lastSeenText, rankMatch, safeHref, safeImageSrc, clip } from './chats-util.js'

const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo, d, h, mi).getTime()

test('clock and day labels', () => {
  const now = at(2026, 9, 23, 15, 30)
  assert.equal(fmtClock(at(2026, 9, 23, 9, 5)), '09:05')
  assert.equal(fmtDay(at(2026, 9, 23, 1), now), 'Today')
  assert.equal(fmtDay(at(2026, 9, 22, 23), now), 'Yesterday')
  assert.equal(fmtDay(at(2026, 9, 20), now), 'Tuesday')
  assert.equal(fmtDay(at(2026, 8, 1), now), '1 September')
  assert.equal(fmtDay(at(2025, 11, 31), now), '31 December 2025')
  assert.equal(dayNumber(at(2026, 2, 29, 0, 30)) + 1, dayNumber(at(2026, 2, 30, 23, 30)))
})

test('list time', () => {
  const now = at(2026, 9, 23, 15, 30)
  assert.equal(fmtListTime(at(2026, 9, 23, 8, 1), now), '08:01')
  assert.equal(fmtListTime(at(2026, 9, 22, 8, 1), now), 'Yesterday')
  assert.equal(fmtListTime(at(2026, 9, 19, 8, 1), now), 'Mon')
  assert.equal(fmtListTime(at(2026, 5, 3), now), '3 Jun')
  assert.equal(fmtListTime(at(2024, 5, 3), now), '3 Jun 24')
  assert.equal(fmtListTime(0, now), '')
})

test('last seen', () => {
  const now = at(2026, 9, 23, 15, 30)
  assert.equal(lastSeenText(now - 10_000, now), 'last seen just now')
  assert.equal(lastSeenText(now - 5 * 60_000, now), 'last seen 5 min ago')
  assert.equal(lastSeenText(now - 3 * 3_600_000, now), 'last seen 3 h ago')
  assert.equal(lastSeenText(0, now), 'offline')
})

test('sizes, colours, initials', () => {
  assert.equal(fmtSize(900), '900 B')
  assert.equal(fmtSize(2048), '2.0 KB')
  assert.equal(fmtSize(2_481_000), '2.4 MB')
  assert.equal(fmtSize(-1), '')
  assert.equal(hueIndex('Ada', 8), hueIndex('Ada', 8))
  assert.ok(hueIndex('Ada', 8) < 8)
  assert.equal(initials('Ada Lovelace'), 'AL')
  assert.equal(initials('#crew'), 'C')
  assert.equal(initials('🌿 garden'), '🌿G')
  assert.equal(initials(''), '?')
  assert.equal(clip('abcdef', 4), 'abc…')
})

test('search ranking', () => {
  assert.equal(rankMatch('', 'x'), 0)
  assert.equal(rankMatch('ada', 'Ada Lovelace'), 0)
  assert.equal(rankMatch('love', 'Ada Lovelace'), 1)
  assert.equal(rankMatch('vel', 'Ada Lovelace'), 2)
  assert.equal(rankMatch('zz', 'Ada Lovelace'), -1)
  assert.equal(rankMatch('ada lace', 'Ada Lovelace'), 2)
  assert.equal(rankMatch('ada', null, 'Hello ada'), 1)
})

test('safe urls', () => {
  assert.equal(safeHref('https://example.com/a b'), 'https://example.com/a%20b')
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref('data:text/html,<b>'), null)
  assert.equal(safeHref('file:///c:/x'), null)
  assert.equal(safeImageSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA')
  assert.equal(safeImageSrc('data:image/svg+xml;base64,AAAA'), null)
  assert.equal(safeImageSrc('data:text/html;base64,AAAA'), null)
  assert.equal(safeImageSrc('javascript:1'), null)
  assert.equal(safeImageSrc('https://example.com/x.png'), 'https://example.com/x.png')
})

test('emoji only', () => {
  assert.equal(isEmojiOnly('😄'), true)
  assert.equal(isEmojiOnly('👍🏽 🎉'), true)
  assert.equal(isEmojiOnly('😄😄😄😄'), false)
  assert.equal(isEmojiOnly('hi 😄'), false)
  assert.equal(isEmojiOnly('1'), false)
  assert.equal(isEmojiOnly(''), false)
})
