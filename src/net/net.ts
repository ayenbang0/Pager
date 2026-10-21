import { EventEmitter } from 'node:events'
import DHT, { type BootstrapNode, type DHTServer, type KeyPair, type PeerSocket } from 'hyperdht'
import { setTimeout as sleep } from 'node:timers/promises'
import { encodeFrame, FrameDecoder, ProtocolError, type Frame } from './wire.js'

export interface PeerLink {
  readonly pk: string
  readonly initiator: 'local' | 'remote'
  hello: { name: string; caps: readonly string[] }
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
  /** A link silent for this long is dropped (peers keep it alive every 5 s). Default PEER_TIMEOUT_MS. */
  peerTimeoutMs?: number
  /** Link diagnostics (open, close, protocol errors); never throws. */
  log?: (event: string, pk: string, detail?: string) => void
}

/** Optional protocol features this build speaks; peers that do not list one never receive its frames. */
export const LOCAL_CAPS = ['read', 'collab', 'call', 'ping'] as const
const HELLO_TIMEOUT_MS = 5000
const CONNECT_TIMEOUT_MS = 60_000
const LISTEN_RETRY_MS = 30_000
const STOP_GRACE_MS = 3_000
/** Peers send keepalives every 5 s: this much silence means the other side is gone without having closed. */
export const PEER_TIMEOUT_MS = 20_000
/** An empty DHT routing table is re-bootstrapped up to this many times, WARM_STEP_MS apart, before the first dial. */
const WARM_TRIES = 15
const WARM_STEP_MS = 1000

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
  private readonly peerTimeoutMs: number
  /** The DHT has found nodes (or given up waiting): dialing before that only fails with PEER_NOT_FOUND. */
  private warmed = false
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
    this.backoff = opts.backoff ?? { baseMs: 2000, maxMs: 30_000 }
    this.peerTimeoutMs = opts.peerTimeoutMs ?? PEER_TIMEOUT_MS
  }

  start(): void {
    const dht = new DHT({ ...this.opts.dhtOptions, bootstrap: this.opts.bootstrap })
    this.dht = dht
    // HyperDHT firewall semantics: returning true REJECTS the peer.
    this.server = dht.createServer({ firewall: (pk) => this.opts.isBlocked(pk.toString('hex')) })
    this.server.on('connection', (socket) => this.attach(socket, 'remote', socket.remotePublicKey.toString('hex')))
    dht.on('network-change', () => {
      this.opts.log?.('network-change', this.myPk)
      this.redial()
    })
    void this.listen()
    void this.warm()
  }

  link(pk: string): PeerLink | undefined {
    return this.links_.get(pk)?.link
  }

  links(): PeerLink[] {
    return [...this.links_.values()].flatMap((s) => (s.link ? [s.link] : []))
  }

  /** Call whenever wanted() may have changed. */
  refresh(): void {
    if (this.stopped || !this.dht || !this.warmed) return
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

  /** Waits for the DHT to know some nodes, then dials every wanted peer. A cold table dials into nothing and doubles the backoff for nothing. */
  private async warm(): Promise<void> {
    const dht = this.dht
    if (!dht) return
    await dht.ready().catch(() => undefined)
    for (let i = 0; i < WARM_TRIES && !this.stopped && dht.nodes.length === 0; i++) {
      dht.refresh()
      await sleep(WARM_STEP_MS, undefined, { ref: false })
    }
    if (this.stopped) return
    if (dht.nodes.length === 0) this.opts.log?.('cold-dht', this.myPk, 'dialing anyway')
    this.warmed = true
    this.refresh()
  }

  /** The machine's network changed (new Wi-Fi, VPN, wake from sleep): forget the backoff and dial every wanted peer without a link now. */
  private redial(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.attempts.clear()
    this.refresh()
  }

  /** One line about this node's DHT view for /net and the log (undefined before start). */
  stats(): string | undefined {
    const d = this.dht
    if (!d) return undefined
    return `nodes=${d.nodes.length} online=${d.online} degraded=${d.degraded} nat=${d.firewalled ? 'firewalled' : 'open'}${d.randomized ? ',randomized' : ''} addr=${d.host ?? 'unknown'}:${d.port}`
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
      this.opts.log?.('listen-error', this.myPk, err instanceof Error ? err.message : String(err))
      this.emit('listen-error', err instanceof Error ? err : new Error(String(err)))
      this.listenTimer = setTimeout(() => void this.listen(), LISTEN_RETRY_MS)
      this.listenTimer.unref()
      return
    }
    if (this.stopped) return
    this.listening = true
    this.opts.log?.('listening', this.myPk, this.stats())
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
    socket.setTimeout(this.peerTimeoutMs)
    this.sessions.add(session)
    const decoder = new FrameDecoder()
    const sendFrame = (frame: Frame): boolean => {
      if (socket.destroyed || !socket.writable) return false
      socket.write(encodeFrame(frame))
      return true
    }
    const sendHello = (): void => void sendFrame({ t: 'hello', v: 1, name: this.opts.getName(), caps: [...LOCAL_CAPS] })
    const log = (event: string, detail?: string): void => this.opts.log?.(event, pk, detail)
    // A dial may spend a while hole-punching before the socket opens; the hello clock only starts once it has.
    const arm = (ms: number): NodeJS.Timeout => {
      const t = setTimeout(() => {
        log('hello-timeout', initiator)
        socket.destroy()
      }, ms)
      t.unref()
      return t
    }
    let helloTimer = arm(initiator === 'local' ? CONNECT_TIMEOUT_MS : HELLO_TIMEOUT_MS)

    socket.on('error', (err: Error) => log('socket-error', err.message))
    if (initiator === 'remote') {
      log('incoming', '')
      sendHello()
    } else {
      socket.on('open', () => {
        sendHello()
        clearTimeout(helloTimer)
        helloTimer = arm(HELLO_TIMEOUT_MS)
        log('socket-open', '')
      })
    }

    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[]
      try {
        frames = decoder.push(chunk)
      } catch (err) {
        if (err instanceof ProtocolError) {
          log('protocol-error', err.message)
          socket.destroy()
        } else throw err
        return
      }
      for (const frame of frames) {
        if (socket.destroyed) return
        if (!session.link) {
          if (frame.t !== 'hello') {
            log('non-hello-first', frame.t)
            socket.destroy()
            return
          }
          clearTimeout(helloTimer)
          log('link-open', `${initiator} ${frame.name} caps=${(frame.caps ?? []).join(',')}`)
          this.promote(session, frame.name, frame.caps ?? [], sendFrame)
        } else if (frame.t === 'hello') {
          session.link.hello = { name: frame.name, caps: frame.caps ?? [] }
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
        log('link-close', initiator)
        this.links_.delete(pk)
        this.emit('close', pk)
        this.scheduleIfWanted(pk, this.backoff.baseMs)
      } else if (initiator === 'local' && !this.links_.has(pk)) {
        const n = this.attempts.get(pk) ?? 0
        this.attempts.set(pk, n + 1)
        log('dial-closed', `attempt ${n + 1} ${this.stats() ?? ''}`.trim())
        const base = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** n)
        this.scheduleIfWanted(pk, base * (0.8 + 0.4 * Math.random()))
      }
    })
  }

  private scheduleIfWanted(pk: string, delayMs: number): void {
    if ([...this.opts.wanted()].includes(pk)) this.schedule(pk, delayMs)
  }

  /** Remote hello arrived: resolve duplicates, then publish the link. */
  private promote(session: Session, name: string, caps: readonly string[], sendFrame: (f: Frame) => boolean): void {
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
      hello: { name, caps },
      send: sendFrame,
      close: () => session.socket.destroy(),
    }
    session.link = link
    this.links_.set(session.pk, session)
    this.emit('open', link)
  }
}
