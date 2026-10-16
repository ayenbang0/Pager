import { EventEmitter } from 'node:events'
import DHT, { type BootstrapNode, type DHTServer, type KeyPair, type PeerSocket } from 'hyperdht'
import { setTimeout as sleep } from 'node:timers/promises'
import { encodeFrame, FrameDecoder, ProtocolError, type Frame } from './wire.js'

export interface PeerLink {
  readonly pk: string
  readonly initiator: 'local' | 'remote'
  hello: { name: string }
  send(frame: Frame): boolean
  close(): void
}

export interface NetOptions {
  keyPair: KeyPair
  /** undefined = HyperDHT public defaults. */
  bootstrap?: BootstrapNode[]
  /** Merged into `new DHT({...})`; tests pass `{ host: '127.0.0.1' }`. */
  dhtOptions?: Record<string, unknown>
  getName(): string
  /** true => refuse at the DHT firewall. */
  isBlocked(pk: string): boolean
  /** Peers we should stay connected to (hex); the self key is ignored. */
  wanted(): Iterable<string>
  backoff?: { baseMs: number; maxMs: number }
}

const HELLO_TIMEOUT_MS = 10_000
const LISTEN_RETRY_MS = 30_000
const STOP_GRACE_MS = 3_000

interface Session {
  pk: string
  initiator: 'local' | 'remote'
  socket: PeerSocket
  link?: PeerLink
  /** Destroyed in favour of another socket: no events, no reconnect. */
  suppressed: boolean
}

/**
 * Transport policy only: sockets, hello handshake, duplicate resolution, reconnect backoff.
 * Events: 'listening', 'listen-error' (Error), 'open' (PeerLink), 'hello' (PeerLink),
 * 'frame' (PeerLink, Frame), 'close' (pk: string).
 */
export class Net extends EventEmitter {
  listening = false

  private readonly opts: NetOptions
  private readonly myPk: string
  private readonly backoff: { baseMs: number; maxMs: number }
  private dht?: DHT
  private server?: DHTServer
  private stopped = false
  private listenTimer?: NodeJS.Timeout
  private readonly links_ = new Map<string, Session>()
  private readonly sessions = new Set<Session>()
  private readonly inflight = new Set<string>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly attempts = new Map<string, number>()

  constructor(opts: NetOptions) {
    super()
    this.opts = opts
    this.myPk = opts.keyPair.publicKey.toString('hex')
    this.backoff = opts.backoff ?? { baseMs: 2000, maxMs: 300_000 }
  }

  start(): void {
    const dht = new DHT({ ...this.opts.dhtOptions, bootstrap: this.opts.bootstrap })
    this.dht = dht
    // HyperDHT firewall semantics: returning true REJECTS the peer.
    this.server = dht.createServer({ firewall: (pk) => this.opts.isBlocked(pk.toString('hex')) })
    this.server.on('connection', (socket) => this.attach(socket, 'remote', socket.remotePublicKey.toString('hex')))
    void this.listen()
    this.refresh()
  }

  link(pk: string): PeerLink | undefined {
    return this.links_.get(pk)?.link
  }

  links(): PeerLink[] {
    return [...this.links_.values()].flatMap((s) => (s.link ? [s.link] : []))
  }

  /** Call whenever wanted() may have changed. */
  refresh(): void {
    if (this.stopped || !this.dht) return
    const wanted = new Set(this.opts.wanted())
    wanted.delete(this.myPk)
    for (const [pk, timer] of this.timers) {
      if (wanted.has(pk)) continue
      clearTimeout(timer)
      this.timers.delete(pk)
      this.attempts.delete(pk)
    }
    for (const pk of wanted) {
      if (!this.links_.has(pk) && !this.inflight.has(pk) && !this.timers.has(pk)) this.dial(pk)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.listenTimer)
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const s of this.sessions) s.socket.destroy()
    const { dht, server } = this
    if (!dht) return
    const graceful = (async () => {
      await server?.close()
      await dht.destroy()
    })().catch(() => {})
    await Promise.race([graceful, sleep(STOP_GRACE_MS, undefined, { ref: false })])
    await dht.destroy({ force: true })
  }

  private async listen(): Promise<void> {
    try {
      await this.server?.listen(this.opts.keyPair)
    } catch (err) {
      if (this.stopped) return
      this.emit('listen-error', err instanceof Error ? err : new Error(String(err)))
      this.listenTimer = setTimeout(() => void this.listen(), LISTEN_RETRY_MS)
      this.listenTimer.unref()
      return
    }
    if (this.stopped) return
    this.listening = true
    this.emit('listening')
  }

  private dial(pk: string): void {
    if (this.stopped || !this.dht) return
    this.inflight.add(pk)
    const socket = this.dht.connect(Buffer.from(pk, 'hex'), { keyPair: this.opts.keyPair })
    this.attach(socket, 'local', pk)
  }

  private schedule(pk: string, delayMs: number): void {
    if (this.stopped) return
    clearTimeout(this.timers.get(pk))
    const timer = setTimeout(() => {
      this.timers.delete(pk)
      this.dial(pk)
    }, delayMs)
    timer.unref()
    this.timers.set(pk, timer)
  }

  private attach(socket: PeerSocket, initiator: 'local' | 'remote', pk: string): void {
    const session: Session = { pk, initiator, socket, suppressed: false }
    this.sessions.add(session)
    const decoder = new FrameDecoder()
    const sendFrame = (frame: Frame): boolean => {
      if (socket.destroyed || !socket.writable) return false
      socket.write(encodeFrame(frame))
      return true
    }
    const sendHello = (): void => void sendFrame({ t: 'hello', v: 1, name: this.opts.getName() })
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS)
    helloTimer.unref()

    socket.on('error', () => {})
    if (initiator === 'remote') sendHello()
    else socket.on('open', sendHello)

    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[]
      try {
        frames = decoder.push(chunk)
      } catch (err) {
        if (err instanceof ProtocolError) socket.destroy()
        else throw err
        return
      }
      for (const frame of frames) {
        if (socket.destroyed) return
        if (!session.link) {
          if (frame.t !== 'hello') {
            socket.destroy()
            return
          }
          clearTimeout(helloTimer)
          this.promote(session, frame.name, sendFrame)
        } else if (frame.t === 'hello') {
          session.link.hello = { name: frame.name }
          this.emit('hello', session.link)
        } else {
          this.emit('frame', session.link, frame)
        }
      }
    })

    socket.on('close', () => {
      clearTimeout(helloTimer)
      this.sessions.delete(session)
      if (session.suppressed) return
      if (initiator === 'local') this.inflight.delete(pk)
      if (session.link) {
        if (this.links_.get(pk) !== session) return
        this.links_.delete(pk)
        this.emit('close', pk)
        this.scheduleIfWanted(pk, this.backoff.baseMs)
      } else if (initiator === 'local' && !this.links_.has(pk)) {
        const n = this.attempts.get(pk) ?? 0
        this.attempts.set(pk, n + 1)
        const base = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** n)
        this.scheduleIfWanted(pk, base * (0.8 + 0.4 * Math.random()))
      }
    })
  }

  private scheduleIfWanted(pk: string, delayMs: number): void {
    if ([...this.opts.wanted()].includes(pk)) this.schedule(pk, delayMs)
  }

  /** Remote hello arrived: resolve duplicates, then publish the link. */
  private promote(session: Session, name: string, sendFrame: (f: Frame) => boolean): void {
    const existing = this.links_.get(session.pk)
    if (existing) {
      const initiatorOf = (s: Session): string => (s.initiator === 'local' ? this.myPk : s.pk)
      if (initiatorOf(existing) < initiatorOf(session)) {
        session.suppressed = true
        if (session.initiator === 'local') this.inflight.delete(session.pk)
        session.socket.destroy()
        return
      }
      existing.suppressed = true
      this.links_.delete(session.pk)
      existing.socket.destroy()
    }
    if (session.initiator === 'local') this.inflight.delete(session.pk)
    this.attempts.delete(session.pk)
    clearTimeout(this.timers.get(session.pk))
    this.timers.delete(session.pk)
    const link: PeerLink = {
      pk: session.pk,
      initiator: session.initiator,
      hello: { name },
      send: sendFrame,
      close: () => session.socket.destroy(),
    }
    session.link = link
    this.links_.set(session.pk, session)
    this.emit('open', link)
  }
}
