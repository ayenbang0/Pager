import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Frame } from '../net/wire.js'
import type { AudioIo } from './audio.js'
import { Calls } from './calls.js'

const G = `grp:${'ab'.repeat(16)}`

interface Peer {
  calls: Calls
  /** What its mic would say next: push a chunk with `talk`. */
  talk(pcm: Buffer): void
  /** Everything each remote speaker played, by the order speakers were opened. */
  heard: Buffer[][]
  rings: string[]
  sent: Frame[]
}

const loud = (): Buffer => {
  const b = Buffer.alloc(2048)
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 === 0 ? 12_000 : -12_000, i)
  return b
}

/** Peers on one fake network: everyone is a member of G and online, unless `online` says otherwise. */
function network(names: string[], online = (_from: string, _to: string) => true): Map<string, Peer> {
  const peers = new Map<string, Peer>()
  for (const me of names) {
    let mic: ((pcm: Buffer) => void) | undefined
    const heard: Buffer[][] = []
    const io: AudioIo = {
      mic: (onChunk) => {
        mic = onChunk
        return { stop: () => (mic = undefined) }
      },
      speaker: () => {
        const got: Buffer[] = []
        heard.push(got)
        return { write: (pcm) => void got.push(pcm), stop: () => undefined }
      },
    }
    const peer: Peer = {
      heard,
      rings: [],
      sent: [],
      talk: (pcm) => mic?.(pcm),
      calls: new Calls({
        me,
        link: (pk) =>
          online(me, pk)
            ? {
                send: (frame) => {
                  peer.sent.push(frame)
                  peers.get(pk)?.calls.onFrame(me, frame as Extract<Frame, { t: 'call' | 'call-audio' }>)
                  return true
                },
              }
            : undefined,
        members: (conv) => (conv === G ? names.filter((n) => n !== me) : undefined),
        audio: async () => io,
        ring: (_conv, room, pk, started) => void peer.rings.push(`${pk} ${room} ${started ? 'started' : 'joined'}`),
        changed: () => undefined,
      }),
    }
    peers.set(me, peer)
  }
  return peers
}

test('joining rings the others once per new room; only the people in my room hear me, and silence is not sent', async () => {
  const net = network(['ann', 'bob', 'cat'])
  const [ann, bob, cat] = ['ann', 'bob', 'cat'].map((n) => net.get(n)!)
  assert.equal(await ann!.calls.join(G, 'main'), undefined)
  assert.deepEqual(bob!.rings, ['ann main started'])
  await bob!.calls.join(G, 'main')
  assert.deepEqual(cat!.rings, ['ann main started', 'bob main joined'], 'only the first join starts the room; the app rings a group once')
  await cat!.calls.join(G, 'side')
  assert.deepEqual(ann!.calls.roomsIn(G).map((r) => [r.room, r.people]), [['main', ['ann', 'bob']], ['side', ['cat']]])
  const before = ann!.sent.length
  ann!.talk(Buffer.alloc(2048))
  assert.equal(ann!.sent.length, before, 'silence stays home')
  ann!.talk(loud())
  assert.deepEqual(ann!.sent.slice(before).map((f) => f.t), ['call-audio'], 'one stream, to bob only')
  assert.equal(bob!.heard[0]?.length, 1)
  assert.equal(cat!.heard.length, 0)
  assert.equal(ann!.calls.current()?.people.find((p) => p.pk === 'ann')?.speaking, true)
  assert.equal(bob!.calls.current()?.people.find((p) => p.pk === 'ann')?.speaking, true)
})

test('mute stops my sound; leaving or a dropped link takes people out of the room', async () => {
  const net = network(['ann', 'bob'])
  const ann = net.get('ann')!
  const bob = net.get('bob')!
  await ann.calls.join(G, 'main')
  await bob.calls.join(G, 'main')
  assert.equal(ann.calls.toggleMute(), true)
  ann.talk(loud())
  assert.equal(bob.heard.length, 0)
  ann.calls.toggleMute()
  ann.talk(loud())
  assert.equal(bob.heard[0]?.length, 1)
  bob.calls.onClose('ann')
  assert.deepEqual(bob.calls.roomsIn(G).map((r) => r.people), [['bob']])
  assert.equal(bob.calls.leave(), true)
  assert.deepEqual(ann.calls.roomsIn(G).map((r) => r.people), [['ann']])
  assert.equal(bob.calls.leave(), false)
})

test('strangers, wrong rooms and unknown conversations are ignored; a reconnect re-announces my room', async () => {
  let linked = false
  const net = network(['ann', 'bob'], () => linked)
  const ann = net.get('ann')!
  const bob = net.get('bob')!
  await ann.calls.join(G, 'main')
  assert.deepEqual(bob.calls.roomsIn(G), [], 'bob was offline')
  bob.calls.onFrame('eve', { t: 'call', conv: G, room: 'main', op: 'join' })
  bob.calls.onFrame('ann', { t: 'call', conv: `grp:${'cd'.repeat(16)}`, room: 'main', op: 'join' })
  assert.deepEqual(bob.calls.roomsIn(G), [])
  linked = true
  ann.calls.onOpen('bob')
  assert.deepEqual(bob.calls.roomsIn(G).map((r) => r.people), [['ann']])
  assert.deepEqual(bob.rings, ['ann main started'])
  bob.calls.onFrame('ann', { t: 'call-audio', conv: G, room: 'main', d: loud().toString('base64') })
  assert.equal(bob.heard.length, 0, 'not in that room, so nothing plays')
})

test('without SoX a call explains how to get it', async () => {
  const calls = new Calls({ me: 'ann', link: () => undefined, members: () => [], audio: async () => 'Calls need SoX', ring: () => undefined, changed: () => undefined })
  assert.equal(await calls.join(G, 'main'), 'Calls need SoX')
  assert.equal(calls.current(), undefined)
})
