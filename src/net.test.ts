import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import DHT, { type KeyPair } from 'hyperdht'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { Net, type NetOptions, type PeerLink } from './net.js'
import { waitFor } from './testutil.js'
import type { Frame } from './wire.js'

let testnet: Testnet
before(async () => {
  testnet = await createTestnet(3)
})

const nets: Net[] = []
after(async () => {
  await Promise.all(nets.map((n) => n.stop()))
  await testnet.destroy()
})

interface Node {
  net: Net
  kp: KeyPair
  pk: string
  opened: PeerLink[]
  frames: Frame[]
}

function make(kp: KeyPair, over: Partial<NetOptions> = {}): Node {
  const opened: PeerLink[] = []
  const frames: Frame[] = []
  const net = new Net({
    keyPair: kp,
    bootstrap: testnet.bootstrap,
    dhtOptions: { host: '127.0.0.1' },
    backoff: { baseMs: 50, maxMs: 200 },
    getName: () => 'n' + kp.publicKey.toString('hex').slice(0, 4),
    isBlocked: () => false,
    wanted: () => [],
    ...over,
  })
  net.on('open', (l: PeerLink) => opened.push(l))
  net.on('frame', (_l: PeerLink, f: Frame) => frames.push(f))
  nets.push(net)
  return { net, kp, pk: kp.publicKey.toString('hex'), opened, frames }
}

test('mutual dialers end with one link each and opposite initiators; frames flow', async () => {
  const kpA = DHT.keyPair()
  const kpB = DHT.keyPair()
  const pkA = kpA.publicKey.toString('hex')
  const pkB = kpB.publicKey.toString('hex')
  const a = make(kpA, { wanted: () => [pkB] })
  const b = make(kpB, { wanted: () => [pkA] })
  a.net.start()
  b.net.start()
  await waitFor(() => a.net.link(pkB) !== undefined && b.net.link(pkA) !== undefined, 20_000, 'links')
  // Real time on purpose: asserting that no duplicate link appears needs the platform clock.
  await sleep(300)
  assert.equal(a.net.links().length, 1)
  assert.equal(b.net.links().length, 1)
  const la = a.net.link(pkB)
  const lb = b.net.link(pkA)
  assert.ok(la && lb)
  assert.notEqual(la.initiator, lb.initiator)
  assert.equal(la.hello.name, 'n' + pkB.slice(0, 4))
  la.send({ t: 'contact-accept' })
  await waitFor(() => b.frames.some((f) => f.t === 'contact-accept'), 5000, 'frame')
})

test('a blocked key never opens', async () => {
  const kpA = DHT.keyPair()
  const kpB = DHT.keyPair()
  const pkA = kpA.publicKey.toString('hex')
  const pkB = kpB.publicKey.toString('hex')
  const a = make(kpA, { isBlocked: (pk) => pk === pkB })
  const b = make(kpB, { wanted: () => [pkA] })
  a.net.start()
  b.net.start()
  await waitFor(() => a.net.listening, 10_000, 'listening')
  // Real time on purpose: negative assertion (nothing opens) has no event to await.
  await sleep(1500)
  assert.equal(a.opened.length, 0)
  assert.equal(b.opened.length, 0)
})

test('a peer that starts later is reached via backoff', async () => {
  const kpA = DHT.keyPair()
  const kpB = DHT.keyPair()
  const pkA = kpA.publicKey.toString('hex')
  const pkB = kpB.publicKey.toString('hex')
  const a = make(kpA, { wanted: () => [pkB] })
  const b = make(kpB)
  a.net.start()
  // Real time on purpose: let the dialer fail at least once so the backoff path is exercised.
  await sleep(800)
  b.net.start()
  await waitFor(() => a.net.link(pkB) !== undefined && b.net.link(pkA) !== undefined, 20_000, 'late link')
})

test('a first frame other than hello gets the socket closed', async () => {
  const a = make(DHT.keyPair())
  a.net.start()
  await waitFor(() => a.net.listening, 10_000, 'listening')
  const dht = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' })
  try {
    const socket = dht.connect(a.kp.publicKey)
    socket.on('error', () => {})
    let closed = false
    socket.on('close', () => (closed = true))
    socket.on('open', () => socket.write('{"t":"contact-accept"}\n'))
    await waitFor(() => closed, 10_000, 'socket close')
    assert.equal(a.opened.length, 0)
  } finally {
    await dht.destroy({ force: true })
  }
})

test('protocol violations are reported to the log callback, not swallowed', async () => {
  const lines: string[] = []
  const a = make(DHT.keyPair(), { log: (event, _pk, detail) => lines.push(`${event} ${detail ?? ''}`) })
  a.net.start()
  await waitFor(() => a.net.listening, 10_000, 'listening')
  const dht = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' })
  try {
    const socket = dht.connect(a.kp.publicKey)
    socket.on('error', () => {})
    socket.on('open', () => socket.write('{"t":"hello","v":1,"name":""}\n'))
    await waitFor(() => lines.some((l) => l.startsWith('protocol-error')), 10_000, 'protocol-error line')
    assert.match(lines.find((l) => l.startsWith('protocol-error')) ?? '', /invalid frame hello name/)
  } finally {
    await dht.destroy({ force: true })
  }
})
