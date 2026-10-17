import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanText, encodeFrame, FrameDecoder, MAX_FRAME_BYTES, ProtocolError } from './wire.js'

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

test('shared-session frames: valid ones decode, oversize or malformed ones are protocol errors', () => {
  const pk = 'ab'.repeat(32)
  const entry = { n: 1, ts: 1, author: 'bob', role: 'guest', pk, kind: 'text', text: 'hi\nthere' }
  const ok: unknown[] = [
    { t: 'collab-invite', access: 'view', title: "alice's agents" },
    { t: 'collab-join' },
    { t: 'collab-leave' },
    { t: 'collab-end', reason: 'removed by host' },
    { t: 'collab-say', text: 'a\nb', tab: 'omp' },
    { t: 'collab-answer', id: 'q1', answers: { q0: ['x'], q1__other: 'y' } },
    { t: 'collab-answer', id: 'q1', answers: null },
    { t: 'collab-sync', reset: true, host: 'alice', entries: [entry], agents: [{ name: 'omp', cli: 'omp', state: 'idle', task: '' }], questions: [], guests: [{ pk, name: 'bob', access: 'control', online: true }] },
  ]
  for (const f of ok) assert.equal(new FrameDecoder().push(Buffer.from(`${JSON.stringify(f)}\n`)).length, 1, JSON.stringify(f))
  const bad: unknown[] = [
    { t: 'collab-invite', access: 'admin', title: 'x' },
    { t: 'collab-say', text: 'x'.repeat(4001) },
    { t: 'collab-sync', reset: false, host: 'alice', entries: Array.from({ length: 41 }, () => entry) },
    { t: 'collab-sync', reset: false, host: 'alice', entries: [{ ...entry, role: 'root' }] },
    { t: 'collab-sync', reset: false, host: 'alice', entries: [{ ...entry, text: 'x'.repeat(12_001) }] },
  ]
  for (const f of bad) assert.throws(() => new FrameDecoder().push(Buffer.from(`${JSON.stringify(f)}\n`)), ProtocolError, JSON.stringify(f).slice(0, 80))
})

test('cleanText drops terminal escapes but keeps newlines and tabs', () => {
  assert.equal(cleanText('a\u001b[31mb\n\tc\u0007\u009b'), 'a[31mb\n\tc')
})
