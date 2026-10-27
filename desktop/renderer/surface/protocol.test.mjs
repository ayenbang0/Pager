// node --test desktop/renderer/surface/protocol.test.mjs   (needs `npm run build`: it round-trips the emitter in dist/surface)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeOsc, encodeSurface, KINDS, MAX_BASE64_CHARS, MAX_PAYLOAD_BYTES, rowsOf, validateSurface } from './protocol.js'
import * as emitter from '../../../dist/surface/protocol.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const sample = {
  mermaid: 'graph LR\n A --> B',
  math: 'E = mc^2',
  diff: '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n',
  image: `data:image/png;base64,${PNG}`,
  'html-sandbox': '<b>héllo ☃ \u{1F600}</b>',
}
const osc = (seq) => seq.slice('\x1b]7777;'.length, -2)

test('both sides know the same kinds and limits', () => {
  assert.deepEqual([...KINDS], [...emitter.SURFACE_KINDS])
  assert.equal(MAX_PAYLOAD_BYTES, emitter.MAX_PAYLOAD_BYTES)
  assert.equal(MAX_BASE64_CHARS, emitter.MAX_BASE64_CHARS)
})

test('renderer encoder -> renderer decoder, every kind', () => {
  for (const kind of KINDS) {
    const msg = { kind, id: `r-${kind}`, source: sample[kind], title: 'Ünï ☃', height: 9 }
    const r = decodeOsc(osc(encodeSurface(msg)))
    assert.ok(r.ok, kind)
    assert.deepEqual(r.msg, msg)
  }
})

test('emitter (src/surface) -> renderer decoder, and the other way, byte for byte', () => {
  for (const kind of KINDS) {
    const msg = { kind, id: `x-${kind}`, source: sample[kind], title: 'T' }
    assert.equal(encodeSurface(msg), emitter.encodeSurface(msg), kind)
    const fromEmitter = decodeOsc(osc(emitter.encodeSurface(msg)))
    assert.ok(fromEmitter.ok && fromEmitter.msg.source === msg.source)
    const fromRenderer = emitter.decodeOsc(osc(encodeSurface(msg)))
    assert.ok(fromRenderer && fromRenderer.ok && fromRenderer.msg.source === msg.source)
  }
})

test('both validators agree on a set of good and bad messages', () => {
  const base = { kind: 'math', id: 'a', source: 'x' }
  const cases = [
    base, { ...base, kind: 'nope' }, { ...base, id: 'a b' }, { ...base, id: '' }, { ...base, source: '' }, { ...base, source: 1 }, { ...base, height: 0 }, { ...base, height: 60 }, { ...base, height: 61 },
    { ...base, height: 2.5 }, { ...base, title: 3 }, { ...base, title: 'a\nb' }, { kind: 'image', id: 'i', source: sample.image }, { kind: 'image', id: 'i', source: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    { kind: 'image', id: 'i', source: 'data:image/png;base64,PHN2Zz48L3N2Zz4=' }, null, [], 'str',
  ]
  for (const c of cases) {
    const a = validateSurface(c)
    const b = emitter.validateSurface(c)
    assert.equal(a.ok, b.ok, JSON.stringify(c))
    if (a.ok) assert.deepEqual(a.msg, b.msg)
  }
})

test('size cap is enforced by decoder and encoder', () => {
  const room = MAX_PAYLOAD_BYTES - JSON.stringify({ kind: 'math', id: 'big', source: '' }).length
  assert.doesNotThrow(() => encodeSurface({ kind: 'math', id: 'big', source: 'a'.repeat(room) }))
  assert.throws(() => encodeSurface({ kind: 'math', id: 'big', source: 'a'.repeat(room + 1) }), /limit/)
  const r = decodeOsc(`pager-surface;${Buffer.from('a'.repeat(MAX_PAYLOAD_BYTES + 1)).toString('base64')}`)
  assert.ok(!r.ok && /larger/.test(r.error))
  // within the base64 length cap but decoding to more than 1 MiB of bytes
  const sneaky = 'A'.repeat(MAX_BASE64_CHARS)
  assert.ok(!decodeOsc(`pager-surface;${sneaky}`).ok)
})

test('hostile and malformed payloads are refused, other sub-protocols pass', () => {
  assert.equal(decodeOsc('other;abcd'), null)
  assert.equal(decodeOsc(undefined), null)
  for (const data of ['pager-surface', 'pager-surface;', 'pager-surface;%%%%', 'pager-surface;abc', `pager-surface;${Buffer.from('{"kind":"html-sandbox","id":"a"}').toString('base64')}`, `pager-surface;${Buffer.from([0xc3, 0x28, 0xff, 0xfe]).toString('base64')}`]) {
    assert.equal(decodeOsc(data).ok, false, data)
  }
  const ok = decodeOsc(`pager-surface;${Buffer.from(JSON.stringify({ kind: 'math', id: 'a', source: 'x', __proto__: { polluted: 1 }, onclick: 'x' })).toString('base64')}`)
  assert.ok(ok.ok && !('onclick' in ok.msg) && ({}).polluted === undefined)
})

test('rowsOf', () => {
  assert.equal(rowsOf({ kind: 'diff', id: 'a', source: 'x' }), 18)
  assert.equal(rowsOf({ kind: 'diff', id: 'a', source: 'x', height: 3 }), 3)
})
