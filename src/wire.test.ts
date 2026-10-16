import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES, ProtocolError } from './wire.js'

const line = (o: unknown): Buffer => Buffer.from(JSON.stringify(o) + '\n')
const pk = 'a'.repeat(64)

test('reassembles a frame split across chunks, and splits one chunk into two frames', () => {
  const d = new FrameDecoder()
  const buf = encodeFrame({ t: 'hello', v: 1, name: 'ann' })
  assert.deepEqual(d.push(buf.subarray(0, 5)), [])
  assert.deepEqual(d.push(buf.subarray(5, 12)), [])
  assert.deepEqual(d.push(buf.subarray(12)), [{ t: 'hello', v: 1, name: 'ann' }])
  const two = Buffer.concat([encodeFrame({ t: 'contact-accept' }), encodeFrame({ t: 'ack', conv: 'dm:' + 'b'.repeat(32), author: pk, seq: 3 })])
  assert.equal(d.push(two).length, 2)
})

test('contact-request note defaults to empty', () => {
  assert.deepEqual(new FrameDecoder().push(line({ t: 'contact-request' })), [{ t: 'contact-request', note: '' }])
})

test('rejects oversize, bad JSON, unknown t, bad version, control chars', () => {
  assert.throws(() => new FrameDecoder().push(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61)), ProtocolError)
  assert.throws(() => new FrameDecoder().push(Buffer.from('nope\n')), ProtocolError)
  assert.throws(() => new FrameDecoder().push(line({ t: 'mystery' })), ProtocolError)
  assert.throws(() => new FrameDecoder().push(line({ t: 'hello', v: 2, name: 'x' })), ProtocolError)
  const ev = { author: pk, seq: 1, ts: 0, kind: 'text', body: '\x1b[2J', sig: 'c'.repeat(128) }
  assert.throws(() => new FrameDecoder().push(line({ t: 'events', conv: 'dm:' + 'b'.repeat(32), events: [ev] })), ProtocolError)
})
