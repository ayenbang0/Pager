'use strict'
// node --test desktop/electron/blocks/screen.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const screen = require('./screen.cjs')
const t = screen._t

const rect = { x: -1920, y: 0, width: 1920, height: 1080 } // a second monitor left of the primary

test('mapPoint: normalised point -> physical pixel inside the display, clamped, negative origins kept', () => {
  assert.deepEqual(t.mapPoint(rect, 0, 0), { x: -1920, y: 0 })
  assert.deepEqual(t.mapPoint(rect, 1, 1), { x: -1, y: 1079 })
  assert.deepEqual(t.mapPoint(rect, 0.5, 0.5), { x: -960, y: 540 })
  assert.deepEqual(t.mapPoint(rect, -3, 9), { x: -1920, y: 1079 })
  assert.deepEqual(t.mapPoint(rect, NaN, Infinity), { x: -1920, y: 0 })
})

test('commandsFor: pointer, buttons, wheel, keys and text become helper commands; never off the display', () => {
  const c = t.commandsFor(
    [
      { t: 'move', x: 0.5, y: 0.25 },
      { t: 'down', button: 0, x: 0.5, y: 0.25 },
      { t: 'up', button: 2 },
      { t: 'wheel', dx: 0, dy: 100 },
      { t: 'key', code: 'KeyA', down: true },
      { t: 'key', code: 'ArrowLeft', down: false },
      { t: 'key', code: 'NoSuchKey', down: true },
      { t: 'text', text: 'hi' },
    ],
    rect,
  )
  assert.equal(c, 'm -960 270;m -960 270;b left d;b right u;w 0 -100;k 65 d 0;k 37 u 1;c 104 d;c 104 u;c 105 d;c 105 u')
  assert.equal(t.commandsFor([{ t: 'move', x: 7, y: 7 }], rect), 'm -1 1079')
})

test('commandsFor rejects malformed batches and unknown buttons', () => {
  assert.throws(() => t.commandsFor('x', rect), /Bad input/)
  assert.throws(() => t.commandsFor(new Array(300).fill({ t: 'move', x: 0, y: 0 }), rect), /Bad input/)
  assert.throws(() => t.commandsFor([{ t: 'drag' }], rect), /Bad input event/)
  assert.throws(() => t.commandsFor([{ t: 'down', button: 9 }], rect), /Bad mouse button/)
  assert.throws(() => t.commandsFor([null], rect), /Bad input event/)
})

test('key table covers letters, digits, F1-F24, arrows with the extended flag, modifiers', () => {
  assert.deepEqual(t.KEYS.KeyZ, [0x5a, 0])
  assert.deepEqual(t.KEYS.Digit0, [0x30, 0])
  assert.deepEqual(t.KEYS.F1, [0x70, 0])
  assert.deepEqual(t.KEYS.F24, [0x87, 0])
  assert.deepEqual(t.KEYS.ArrowUp, [0x26, 1])
  assert.deepEqual(t.KEYS.ControlRight, [0xa3, 1])
  assert.deepEqual(t.KEYS.Numpad7, [0x67, 0])
})

test('without a session, nothing can be driven or captured; control needs confirmation', async () => {
  await assert.rejects(screen.methods.input({ sid: 's999', events: [] }), /closed/)
  await assert.rejects(screen.methods.mode({ sid: 's999', mode: 'control', confirm: true }), /closed/)
  await assert.rejects(screen.methods.frame({ sid: 's999' }), /closed/)
  await assert.rejects(screen.methods.saveRecording({ sid: 's999', data: new Uint8Array(1) }), /closed/)
  // a session with no confirmation never reaches control mode
  t.sessions.set('sx', { sid: 'sx', sourceId: 'screen:0:0', displayId: '1', mode: 'view', lastInput: Date.now(), emit() {} })
  await assert.rejects(screen.methods.mode({ sid: 'sx', mode: 'control' }), /confirmation/)
  await assert.rejects(screen.methods.mode({ sid: 'sx', mode: 'control', confirm: 'yes' }), /confirmation/)
  await assert.rejects(screen.methods.input({ sid: 'sx', events: [{ t: 'move', x: 0, y: 0 }] }), /view only/)
  assert.equal(t.sessions.get('sx').mode, 'view')
  await screen.methods.release({ sid: 'sx' })
  assert.equal(t.sessions.has('sx'), false)
})

test('select refuses a display it did not list (outside Electron there is nothing to list)', async () => {
  await assert.rejects(screen.methods.select({ sourceId: 'screen:99:0' }), /needs the desktop app|no longer available/)
})

test('helper: SendInput works (reserved key 0xFF), release-all is a no-op when nothing is held, bad lines are reported', { skip: process.platform !== 'win32' }, async () => {
  const { j: info } = await t.input.request('i')
  assert.ok(info.vw > 0 && info.vh > 0)
  const { j } = await t.input.request('k 255 d 0;k 255 u 0')
  assert.deepEqual(j, { ok: 2, fail: 0 })
  const bad = await t.input.request('b weird d')
  assert.deepEqual(bad.j, { ok: 0, fail: 1 })
  const held = await t.input.request('k 255 d 0')
  assert.equal(held.j.ok, 1)
  const rel = await t.input.request('r')
  assert.equal(rel.j.released, 1)
  assert.ok((await t.input.request('m x y')).j.error)
  await screen.dispose()
})
