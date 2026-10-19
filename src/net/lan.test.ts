import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { test } from 'node:test'
import { startLan } from './lan.js'

/** A free UDP port: bind to 0, read it, close. */
async function freePort(): Promise<number> {
  const s = dgram.createSocket('udp4')
  await new Promise<void>((resolve) => s.bind(0, '127.0.0.1', resolve))
  const port = s.address().port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

const local = (port: number) => ({ address: '127.0.0.1', broadcast: ['127.0.0.1'], port, discoverMs: 400 })

test('the first pager hosts, the second discovers it and gets the same bootstrap; stop frees the port', async () => {
  const port = await freePort()
  const first = await startLan(local(port))
  assert.equal(first.hosting, true)
  assert.equal(first.bootstrap.length, 1)
  assert.equal(first.address, '127.0.0.1')
  const second = await startLan(local(port))
  assert.equal(second.hosting, false)
  assert.deepEqual(second.bootstrap, first.bootstrap)
  await second.stop()
  await first.stop()
  // the port is free again: a new host can bind it
  const again = await startLan(local(port))
  assert.equal(again.hosting, true)
  await again.stop()
})

test('a target skips discovery and opens no sockets', async () => {
  const lan = await startLan({ target: '10.1.2.3:4567', address: '10.1.2.9' })
  assert.deepEqual(lan.bootstrap, [{ host: '10.1.2.3', port: 4567 }])
  assert.equal(lan.hosting, false)
  assert.equal(lan.address, '10.1.2.9')
  await lan.stop()
  await assert.rejects(startLan({ target: 'nope' }), /is not host:port/)
  await assert.rejects(startLan({ target: 'h:99999' }), /is not host:port/)
})
