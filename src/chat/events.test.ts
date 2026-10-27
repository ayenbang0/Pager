import assert from 'node:assert/strict'
import { test } from 'node:test'
import DHT from 'hyperdht'
import { newGroupId } from './convId.js'
import { signEvent, verifyEvent } from './events.js'

const kp = DHT.keyPair()
const author = kp.publicKey.toString('hex')
const base = { conv: newGroupId(), author, seq: 1, ts: 1000, kind: 'text' as const, body: 'hi' }

test('sign/verify round trip', () => {
  assert.ok(verifyEvent(signEvent(base, kp.secretKey)))
})

test('changing any signed field breaks verification', () => {
  const e = signEvent(base, kp.secretKey)
  const other = DHT.keyPair().publicKey.toString('hex')
  for (const tampered of [
    { ...e, body: 'ho' },
    { ...e, seq: 2 },
    { ...e, ts: 1001 },
    { ...e, author: other },
    { ...e, conv: newGroupId() },
  ]) {
    assert.equal(verifyEvent(tampered), false)
  }
  assert.equal(verifyEvent({ ...e, sig: 'zz' }), false)
})
