import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOGO, LOGO_WIDTH, REVEAL_FRAMES, sparkline, tagline, TAGLINE } from './banner.js'

test('every logo row has the same width', () => {
  assert.ok(LOGO.every((r) => r.length === LOGO_WIDTH))
})

test('tagline types out after the reveal and is whole when static', () => {
  assert.equal(tagline(0, false), TAGLINE)
  assert.equal(tagline(REVEAL_FRAMES, true).replace('▌', '').trim(), '')
  assert.ok(tagline(REVEAL_FRAMES + 100, true).startsWith(TAGLINE))
})

test('sparkline scales to the largest value and keeps zeros on the lowest bar', () => {
  assert.equal(sparkline([0, 0, 0]), '▁▁▁')
  assert.equal(sparkline([0, 4, 8]), '▁▅█')
})
