import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REVEAL_FRAMES, sparkline, tagline, TAGLINE, WORDMARK } from './banner.js'

test('the wordmark is plain letters, no block art', () => {
  assert.equal(WORDMARK, 'P A G E R')
  assert.ok(/^[A-Z ]+$/.test(WORDMARK))
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
