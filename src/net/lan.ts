import dgram from 'node:dgram'
import os from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'

export interface LanOptions {
  /** `host:port` of a DHT bootstrap node to join; skips discovery. */
  target?: string
  /** UDP discovery port (default 49737). */
  port?: number
  /** IPv4 address to host on (default: the first non-internal IPv4 address). */
  address?: string
  /** Where discovery datagrams go (default: 255.255.255.255 and each interface's directed broadcast). */
  broadcast?: string[]
  /** How long to listen for a host's answer (default 1500 ms). */
  discoverMs?: number
}

export interface LanHandle {
  bootstrap: { host: string; port: number }[]
  /** The address of this machine on the network. */
  address: string
  /** True when this run started the local DHT; false when it joined one that was already there. */
  hosting: boolean
  stop(): Promise<void>
}

const DEFAULT_PORT = 49737
const DEFAULT_DISCOVER_MS = 1500
const ASK = 'PGRLAN1?'
const ANSWER = 'PGRLAN1! '
const JITTER_MS = 400
const RETRY_MS = 300

function parseTarget(target: string): { host: string; port: number } {
  const m = /^([^\s:]+):(\d{1,5})$/.exec(target)
  const port = m === null ? NaN : Number(m[2])
  if (m === null || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`"${target}" is not host:port`)
  return { host: m[1] ?? '', port }
}

/** The first non-internal IPv4 address and every directed broadcast address of this machine's interfaces. */
function localNetwork(): { address: string | undefined; broadcasts: string[] } {
  let address: string | undefined
  const broadcasts: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal) continue
      address ??= nic.address
      const ip = nic.address.split('.').map(Number)
      const mask = nic.netmask.split('.').map(Number)
      broadcasts.push(ip.map((b, i) => (b | (~(mask[i] ?? 0) & 255)) & 255).join('.'))
    }
  }
  return { address, broadcasts }
}

/** Sends the discovery question and returns the DHT bootstrap nodes the answers name, if any. */
async function discover(port: number, targets: string[], waitMs: number): Promise<{ host: string; port: number }[]> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const found: { host: string; port: number }[] = []
  socket.on('message', (msg) => {
    const text = msg.toString('utf8')
    if (!text.startsWith(ANSWER)) return
    try {
      const node = parseTarget(text.slice(ANSWER.length).trim())
      if (!found.some((f) => f.host === node.host && f.port === node.port)) found.push(node)
    } catch {
      // not ours
    }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(0, () => {
        socket.off('error', reject)
        resolve()
      })
    })
    socket.setBroadcast(true)
    socket.on('error', () => undefined)
    for (const target of targets) socket.send(ASK, port, target, () => undefined)
    await sleep(waitMs)
  } finally {
    socket.close()
  }
  return found
}

/** Binds the discovery port and answers every question with where this machine's DHT bootstrap node is. */
function respond(port: number, answer: string): Promise<dgram.Socket> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  socket.on('message', (msg, rinfo) => {
    if (msg.toString('utf8') === ASK) socket.send(answer, rinfo.port, rinfo.address, () => undefined)
  })
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(port, () => {
      socket.off('error', reject)
      socket.on('error', () => undefined)
      resolve(socket)
    })
  })
}

/**
 * Finds or starts the DHT that LAN-only mode talks through. With a `target` it just joins that node. Otherwise it asks the network
 * (UDP broadcast); a host that answers is joined, and with no answer this machine becomes the host: a small local DHT plus a
 * responder on the discovery port.
 */
export async function startLan(opts: LanOptions = {}): Promise<LanHandle> {
  const net = localNetwork()
  const address = opts.address ?? net.address
  if (opts.target !== undefined) return { bootstrap: [parseTarget(opts.target)], address: address ?? '127.0.0.1', hosting: false, stop: async () => undefined }
  if (address === undefined) throw new Error('LAN mode needs a network interface (no non-internal IPv4 address found)')
  const port = opts.port ?? DEFAULT_PORT
  const targets = opts.broadcast ?? ['255.255.255.255', ...net.broadcasts]
  const waitMs = opts.discoverMs ?? DEFAULT_DISCOVER_MS
  // Two machines starting together should not both decide nobody is there.
  await sleep(Math.floor(Math.random() * JITTER_MS))
  let bootstrap = await discover(port, targets, waitMs)
  if (bootstrap.length > 0) return { bootstrap, address, hosting: false, stop: async () => undefined }

  const testnet: Testnet = await createTestnet(3, { host: address, port: 0 })
  const node = testnet.bootstrap[0]
  if (node === undefined) {
    await testnet.destroy()
    throw new Error('LAN mode could not start a local DHT')
  }
  let responder: dgram.Socket
  try {
    responder = await respond(port, `${ANSWER}${address}:${node.port}`)
  } catch (err) {
    await testnet.destroy()
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    // Another machine won the race for the port: look once more before giving up.
    await sleep(RETRY_MS)
    bootstrap = await discover(port, targets, waitMs)
    if (bootstrap.length > 0) return { bootstrap, address, hosting: false, stop: async () => undefined }
    throw new Error(`LAN discovery port ${port} is in use`)
  }
  return {
    bootstrap: [{ host: address, port: node.port }],
    address,
    hosting: true,
    stop: async () => {
      responder.close()
      await testnet.destroy()
    },
  }
}
