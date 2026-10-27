import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dataDir } from '../platform/paths.js'
import { daemonAddress, encodeData, encodeJson, FrameDecoder, PROTOCOL_VERSION, type DaemonEvent, type Frame, type Reply } from './protocol.js'

export interface Attached {
  replay: Buffer
  cols: number
  rows: number
  /** Bytes of output the pane had produced at the moment of the replay; data frames that follow continue from here. */
  seq: number
}

export interface ConnectOptions {
  /** `window` clients count as attached windows; anything else (`cli`) is invisible to the layout. */
  client?: string
  name?: string
  timeoutMs?: number
}

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  timer: NodeJS.Timeout
}

/**
 * A connection to the daemon. Events: `event`(DaemonEvent), `data`(paneId:number, Buffer), `close`.
 * Pane output arrives only for panes this client attached.
 */
export class DaemonClient extends EventEmitter {
  readonly pid: number
  readonly build: string
  private nextId = 0
  private readonly pending = new Map<number | string, Pending>()
  private readonly seqs = new Map<number, number>()
  private closed = false

  private constructor(
    private readonly socket: net.Socket,
    info: { pid: number; build: string },
  ) {
    super()
    this.pid = info.pid
    this.build = info.build
  }

  /** Dials `address` and says hello. Rejects when nothing answers or the daemon speaks a protocol this build cannot. */
  static async connect(address: string, opts: ConnectOptions = {}): Promise<DaemonClient> {
    const timeout = opts.timeoutMs ?? 5000
    const socket = net.createConnection(address)
    const { promise: opened, resolve, reject } = Promise.withResolvers<void>()
    socket.once('connect', resolve)
    socket.once('error', reject)
    try {
      await opened
    } catch (e) {
      socket.destroy()
      throw e
    }
    socket.off('error', reject)
    socket.on('error', () => {})
    const boot: { client?: DaemonClient } = {}
    const dec = new FrameDecoder()
    const early = Promise.withResolvers<{ pid: number; build: string }>()
    const helloId = 0
    const timer = setTimeout(() => early.reject(new Error('the daemon did not answer hello')), timeout)
    socket.on('data', (chunk) => {
      let frames: Frame[]
      try {
        frames = dec.push(chunk)
      } catch {
        return void socket.destroy()
      }
      for (const f of frames) {
        if (boot.client !== undefined) boot.client.onFrame(f)
        else if (f.kind === 'json') {
          const r = f.json as Reply
          if (r.id !== helloId) continue
          if (r.ok) early.resolve(r.result as { pid: number; build: string })
          else early.reject(new Error(r.error))
        }
      }
    })
    socket.once('close', () => early.reject(new Error('the daemon closed the connection')))
    socket.write(encodeJson({ id: helloId, type: 'hello', version: PROTOCOL_VERSION, client: opts.client ?? 'cli', ...(opts.name === undefined ? {} : { name: opts.name }) }))
    let info: { pid: number; build: string }
    try {
      info = await early.promise
    } catch (e) {
      socket.destroy()
      throw e
    } finally {
      clearTimeout(timer)
    }
    const client = new DaemonClient(socket, info)
    client.nextId = helloId
    boot.client = client
    socket.on('close', () => client.onClose())
    if (socket.destroyed) client.onClose()
    return client
  }

  private onFrame(f: Frame): void {
    if (f.kind === 'data') {
      this.seqs.set(f.paneId, (this.seqs.get(f.paneId) ?? 0) + f.data.length)
      this.emit('data', f.paneId, f.data)
    } else if (f.kind === 'json') {
      const m = f.json as Partial<Reply> & Partial<DaemonEvent>
      if (typeof m.id === 'number' || typeof m.id === 'string') {
        const p = this.pending.get(m.id)
        if (p === undefined) return
        this.pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.ok === true) p.resolve((m as { result?: unknown }).result)
        else p.reject(new Error(typeof m.error === 'string' ? m.error : 'request failed'))
      } else if (typeof m.event === 'string') this.emit('event', m as DaemonEvent)
    }
  }

  private onClose(): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('the connection to the daemon closed'))
    }
    this.pending.clear()
    this.emit('close')
  }

  get alive(): boolean {
    return !this.closed
  }

  call<T = unknown>(type: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the connection to the daemon closed'))
    // Some requests carry their own string `id` argument (chats.request.accept, chats.docs.* …). The envelope has one
    // `id` slot, so a string argument id doubles as the call id: it travels to the daemon intact and the reply, which
    // echoes the frame's id, still finds this call. Two such calls with the same id string cannot be in flight at once.
    const id = typeof args.id === 'string' ? args.id : ++this.nextId
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      reject(new Error(`the daemon did not answer ${type}`))
    }, timeoutMs)
    this.pending.set(id, { resolve, reject, timer })
    this.socket.write(encodeJson({ ...args, id, type }))
    return promise as Promise<T>
  }

  /** Subscribes to events (all of them, or the named ones). */
  subscribe(filter?: readonly string[]): Promise<unknown> {
    return this.call('events.subscribe', filter === undefined ? {} : { filter: [...filter] })
  }

  async attach(paneId: string, size?: { cols: number; rows: number }): Promise<Attached> {
    // Clear the running count first: data frames after the reply continue from the replay's seq.
    const r = await this.call<{ replay: string; cols: number; rows: number; seq: number }>('pane.attach', { paneId, ...size })
    this.seqs.set(Number(paneId), r.seq)
    return { replay: Buffer.from(r.replay, 'base64'), cols: r.cols, rows: r.rows, seq: r.seq }
  }

  /** Where this client's view of the pane's output stands (replay seq plus the data frames since). */
  seqOf(paneId: string): number {
    return this.seqs.get(Number(paneId)) ?? 0
  }

  /** Keyboard bytes for a pane, as a binary frame. */
  input(paneId: string, data: string | Uint8Array): void {
    if (this.closed) return
    this.socket.write(encodeData(Number(paneId), typeof data === 'string' ? Buffer.from(data, 'utf8') : data))
  }

  /** Stops reading from the socket (tests: a client that falls behind). */
  pause(): void {
    this.socket.pause()
  }

  resume(): void {
    this.socket.resume()
  }

  close(): void {
    this.socket.destroy()
    this.onClose()
  }
}

export interface DaemonPaths {
  dir: string
  address: string
  /** The cli.js the daemon is started from (and the one its `pager` panes run). */
  cliPath: string
  /** The node that runs it. */
  nodePath: string
}

export function resolvePaths(over: Partial<DaemonPaths> = {}): DaemonPaths {
  const dir = over.dir ?? dataDir()
  return { dir, address: over.address ?? daemonAddress(dir), cliPath: over.cliPath ?? fileURLToPath(new URL('../cli.js', import.meta.url)), nodePath: over.nodePath ?? process.execPath }
}

/** One connection attempt: undefined when nobody listens. */
export async function tryConnect(address: string, opts: ConnectOptions = {}): Promise<DaemonClient | undefined> {
  try {
    return await DaemonClient.connect(address, opts)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'ECONNRESET') return undefined
    throw e
  }
}

/** Starts `pager daemon` as a detached, windowless process of its own; it outlives this one. Its log goes to `<dir>/daemon.log`. */
export function spawnDaemon(p: DaemonPaths): { exited: Promise<number | null> } {
  fs.mkdirSync(p.dir, { recursive: true })
  const log = path.join(p.dir, 'daemon.log')
  try {
    if (fs.statSync(log).size > 1024 * 1024) fs.rmSync(log, { force: true })
  } catch {
    // no log yet
  }
  const fd = fs.openSync(log, 'a')
  const child = spawn(p.nodePath, [p.cliPath, 'daemon'], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, PAGER_DAEMON_SOCKET: p.address, PAGER_NO_UPDATE_CHECK: '1' } })
  fs.closeSync(fd)
  const { promise, resolve } = Promise.withResolvers<number | null>()
  child.once('exit', (code) => resolve(code))
  child.once('error', () => resolve(-1))
  child.unref()
  return { exited: promise }
}

export interface Connected {
  client: DaemonClient
  /** This call had to start the daemon. */
  started: boolean
  /** Milliseconds from the call to a completed hello. */
  ms: number
}

/** Connects; when no daemon answers, starts one and waits until it does. */
export async function connectOrStart(p: DaemonPaths, opts: ConnectOptions = {}, waitMs = 15_000): Promise<Connected> {
  const t0 = performance.now()
  const first = await tryConnect(p.address, opts)
  if (first !== undefined) return { client: first, started: false, ms: performance.now() - t0 }
  const child = spawnDaemon(p)
  let gone: number | null | undefined
  void child.exited.then((c) => {
    gone = c
  })
  for (let delay = 10; performance.now() - t0 < waitMs; delay = Math.min(60, delay + 10)) {
    await sleep(delay)
    const client = await tryConnect(p.address, opts)
    if (client !== undefined) return { client, started: true, ms: performance.now() - t0 }
    // Another process may have started the daemon first and this one then exited ("already running"): keep dialing.
    if (gone !== undefined && gone !== null && gone !== 0) throw new Error(`the daemon exited with code ${gone}; see ${path.join(p.dir, 'daemon.log')}`)
  }
  throw new Error(`the daemon did not start within ${waitMs} ms; see ${path.join(p.dir, 'daemon.log')}`)
}
