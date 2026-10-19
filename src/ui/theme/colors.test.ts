import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contrast, gradientAt, luminance, mix, parseColor, readableOn, snapAnsi, toRgb } from './colors.js'

test('parseColor normalizes hex, accepts ANSI and friendly names, and rejects the rest', () => {
  assert.equal(parseColor('#FF00aa'), '#ff00aa')
  assert.equal(parseColor('#f0a'), '#ff00aa')
  assert.equal(parseColor('ff8800'), '#ff8800')
  assert.equal(parseColor('  Orange '), '#ff8a00')
  assert.equal(parseColor('cyan'), 'cyan')
  assert.equal(parseColor('redBright'), 'redBright')
  assert.equal(parseColor('REDBRIGHT'), 'redBright')
  assert.equal(parseColor('grey'), 'gray')
  for (const bad of ['', 'nope', '#12', '#12345', '#gggggg', 'rgb(1,2,3)', 'constructor', '__proto__', 'abc']) assert.equal(parseColor(bad), undefined, bad)
})

test('toRgb reads hex and ANSI names only', () => {
  assert.deepEqual(toRgb('#0a141e'), [10, 20, 30])
  assert.deepEqual(toRgb('white'), [229, 229, 229])
  assert.equal(toRgb('nope'), undefined)
  assert.equal(toRgb('#12'), undefined)
})

test('contrast is symmetric, 21 for black on white, and 1 for unknown colors', () => {
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01)
  assert.equal(contrast('#123456', '#abcdef'), contrast('#abcdef', '#123456'))
  assert.equal(contrast('nope', '#fff000'), 1)
  assert.ok(luminance([255, 255, 255]) > luminance([10, 10, 10]))
})

test('readableOn picks text that reads on any fill, keeping ANSI names for named fills', () => {
  for (const bg of ['#00c8ff', '#ff2bd6', '#0f1a2b', '#ffffff', '#000000', '#ffd23f', '#7a1f8a']) assert.ok(contrast(readableOn(bg), bg) >= 4.5, bg)
  assert.equal(readableOn('yellow'), 'black')
  assert.equal(readableOn('blue'), 'white')
})

test('mix and gradientAt blend hex, and names through their palette values', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080')
  assert.equal(gradientAt(['#000000', '#ffffff'], 0), '#000000')
  assert.equal(gradientAt(['#000000', '#ffffff'], 1), '#ffffff')
  assert.equal(gradientAt(['#ff0000', '#00ff00', '#0000ff'], 0.5), '#00ff00')
  assert.equal(gradientAt(['cyan'], 0.7), 'cyan')
  assert.equal(gradientAt(['red', 'blue'], 0.2).startsWith('#'), true)
  assert.equal(mix('nope', 'cyan', 0.2), 'nope')
  assert.equal(mix('nope', 'cyan', 0.8), 'cyan')
  assert.equal(gradientAt(['#000000', '#ffffff'], 7), '#ffffff', 'clamped')
})

test('snapAnsi maps a hex to the nearest of the 16 ANSI colors', () => {
  assert.equal(snapAnsi('#ff0000'), 'redBright')
  assert.equal(snapAnsi('#00ff00'), 'greenBright')
  assert.equal(snapAnsi('#010101'), 'black')
  assert.equal(snapAnsi('cyan'), 'cyan')
  assert.equal(snapAnsi('notacolor'), 'notacolor')
})
