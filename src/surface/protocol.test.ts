import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeOsc, DEFAULT_ROWS, encodeSurface, MAX_BASE64_CHARS, MAX_PAYLOAD_BYTES, rowsOf, SURFACE_KINDS, validateSurface, type SurfaceMessage } from './protocol.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const png = `data:image/png;base64,${PNG.toString('base64')}`
const sample: Record<string, string> = {
  mermaid: 'graph LR\n  A[Open] --> B{Edit?}',
  math: 'E = mc^2 \\; \\int_0^1 x^2\\,dx',
  diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
  image: png,
  'html-sandbox': '<h1>héllo ☃</h1>',
}

/** What an xterm OSC handler is given for an escape: everything between `ESC ] 7777 ;` and the terminator. */
function oscData(seq: string): string {
  assert.ok(seq.startsWith('\x1b]7777;') && seq.endsWith('\x1b\\'))
  return seq.slice('\x1b]7777;'.length, -2)
}

test('every kind round-trips through the escape sequence', () => {
  for (const kind of SURFACE_KINDS) {
    const msg: SurfaceMessage = { kind, id: `k-${kind}`, source: sample[kind]!, title: 'Title ☃', height: 7 }
    const r = decodeOsc(oscData(encodeSurface(msg)))
    assert.ok(r && r.ok, kind)
    assert.deepEqual(r.msg, msg)
  }
})

test('the sequence is ESC ] 7777 ; pager-surface ; base64 ST', () => {
  const seq = encodeSurface({ kind: 'math', id: 'm1', source: 'x' })
  assert.match(seq, /^\x1b\]7777;pager-surface;[A-Za-z0-9+/]+={0,2}\x1b\\$/)
  const json = Buffer.from(oscData(seq).slice('pager-surface;'.length), 'base64').toString('utf8')
  assert.deepEqual(JSON.parse(json), { kind: 'math', id: 'm1', source: 'x' })
})

test('rows default per kind and can be set', () => {
  assert.equal(rowsOf({ kind: 'math', id: 'a', source: 'x' }), DEFAULT_ROWS.math)
  assert.equal(rowsOf({ kind: 'math', id: 'a', source: 'x', height: 9 }), 9)
})

test('other 7777 sub-protocols are left alone', () => {
  assert.equal(decodeOsc('something-else;abcd'), null)
  assert.equal(decodeOsc('pager-surfaces;abcd'), null)
})

test('payload size cap: 1 MiB of JSON', () => {
  const room = MAX_PAYLOAD_BYTES - JSON.stringify({ kind: 'math', id: 'big', source: '' }).length
  assert.doesNotThrow(() => encodeSurface({ kind: 'math', id: 'big', source: 'a'.repeat(room) }))
  assert.throws(() => encodeSurface({ kind: 'math', id: 'big', source: 'a'.repeat(room + 1) }), /limit/)
  // a hand-made oversized payload is refused by the decoder without being parsed
  const huge = Buffer.from(JSON.stringify({ kind: 'math', id: 'big', source: 'a'.repeat(MAX_PAYLOAD_BYTES) })).toString('base64')
  assert.ok(huge.length > MAX_BASE64_CHARS)
  const r = decodeOsc(`pager-surface;${huge}`)
  assert.ok(r && !r.ok && /larger/.test(r.error))
})

test('the decoder refuses bad payloads with a reason', () => {
  const bad = (data: string, re: RegExp): void => {
    const r = decodeOsc(data)
    assert.ok(r && !r.ok, data)
    if (!r.ok) assert.match(r.error, re)
  }
  bad('pager-surface', /base64/)
  bad('pager-surface;', /base64/)
  bad('pager-surface;not base64!!', /base64/)
  bad(`pager-surface;${Buffer.from('{nope').toString('base64')}`, /JSON/)
  bad(`pager-surface;${Buffer.from([0xff, 0xfe, 0xfd, 0xfc]).toString('base64')}`, /UTF-8/)
  bad(`pager-surface;${Buffer.from('[1]').toString('base64')}`, /object/)
  bad(`pager-surface;${Buffer.from('{"kind":"script","id":"a","source":"x"}').toString('base64')}`, /kind/)
})

test('validation: id, source, title, height', () => {
  const v = (o: Record<string, unknown>) => validateSurface({ kind: 'math', id: 'a', source: 'x', ...o })
  assert.ok(v({}).ok)
  for (const id of ['', 'a b', 'a/b', '<x>', 'x'.repeat(65), 7]) assert.ok(!v({ id }).ok, String(id))
  assert.ok(!v({ source: '' }).ok)
  assert.ok(!v({ source: 5 }).ok)
  for (const height of [0, 61, 1.5, '3', NaN]) assert.ok(!v({ height }).ok, String(height))
  const t = v({ title: `a\x1b[31mb\n${'x'.repeat(500)}` })
  assert.ok(t.ok && !/[\x00-\x1f]/.test(t.msg.title!) && t.msg.title!.length === 200)
  // unknown fields are dropped
  const extra = v({ onload: 'alert(1)' })
  assert.ok(extra.ok && !('onload' in extra.msg))
})

test('images: png, jpeg, gif, webp data URLs whose bytes match; nothing else', () => {
  const ok = (url: string): boolean => validateSurface({ kind: 'image', id: 'i', source: url }).ok
  assert.ok(ok(png))
  assert.ok(ok(`data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64')}`))
  assert.ok(ok(`data:image/gif;base64,${Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1').toString('base64')}`))
  assert.ok(ok(`data:image/webp;base64,${Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]).toString('base64')}`))
  assert.ok(!ok('https://example.com/a.png'))
  assert.ok(!ok(`data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`))
  assert.ok(!ok(`data:text/html;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`))
  assert.ok(!ok(`data:image/png;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`), 'png label on svg bytes')
  assert.ok(!ok(png + '"onerror="x'))
  assert.ok(!ok('data:image/png,%89PNG'))
})
