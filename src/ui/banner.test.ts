import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bannerRows, LOGO, LOGO_WIDTH, mix, REVEAL_FRAMES, sparkline, tagline, TAGLINE, type Seg } from './banner.js'

const plain = (rows: Seg[][]): string[] => rows.map((r) => r.map((s) => s.text).join(''))

test('every logo row has the same width', () => {
  assert.ok(LOGO.every((r) => r.length === LOGO_WIDTH))
})

test('the reveal grows left to right and ends on the full logo', () => {
  assert.equal(plain(bannerRows(0, '#00b4ff', true)).join('').trim(), '')
  const half = plain(bannerRows(REVEAL_FRAMES / 2, '#00b4ff', true))
  assert.ok(half.every((r, i) => r.length === LOGO_WIDTH && r.slice(Math.ceil(LOGO_WIDTH / 2) + 1).trim() === '' && LOGO[i]?.startsWith(r.trimEnd())))
  assert.deepEqual(plain(bannerRows(REVEAL_FRAMES, '#00b4ff', true)), [...LOGO])
})

test('static mode is the final frame with no highlight band', () => {
  const rows = bannerRows(0, '#00b4ff', false)
  assert.deepEqual(plain(rows), [...LOGO])
  const colors = new Set(rows.flat().filter((s) => s.text.trim() !== '').map((s) => s.color))
  assert.ok(colors.size <= 2, 'solid + shadow only')
})

test('the sweep brightens some blocks after the reveal', () => {
  const colors = new Set(bannerRows(REVEAL_FRAMES + 12, '#00b4ff', true).flat().map((s) => s.color))
  assert.ok(colors.size > 2)
})

test('ANSI-name accents fall back to bold/dim instead of hex blending', () => {
  const segs = bannerRows(REVEAL_FRAMES + 12, 'cyan', true).flat()
  assert.ok(segs.every((s) => s.text.trim() === '' || s.color === 'cyan'))
})

test('mix blends toward a target', () => {
  assert.equal(mix('#000000', [255, 255, 255], 1), '#ffffff')
  assert.equal(mix('#102030', [0, 0, 0], 0), '#102030')
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
