import type { EventEmitter } from 'node:events'
import type { DaemonState } from '../daemon/protocol.js'
import type { WsLike } from './ws.js'

/**
 * What one browser connection speaks, over one WebSocket and one daemon connection of its own (so attach, detach and size votes are
 * per browser). Browser -> server is JSON text `{t, id?, ...}`; the answer to a call is `{t:'reply', id, ok, result|error}`.
 * Server -> browser is JSON text (`hello`, `state`, `event`, `resync`, `reply`) and binary frames: u32 LE pane id, then output bytes.
 *
 *   state                       -> the layout and panes
 *   attach  pane, cols?, rows?  -> { replay (base64), cols, rows }; binary output follows
 *   detach  pane
 *   input   pane, data | b64    keyboard bytes                              [writes]
 *   resize  pane, cols, rows                                                [writes]
 *   new     kind?, cwd?, command?                a tab                      [writes]
 *   split   pane, dir, kind?, cwd?, command?     a pane beside pane         [writes]
 *   close   pane                                                            [writes]
 *   run     command, pane?, dir?, cwd?, waitMs?  a pane running command, then its capture   [writes]
 *   capture pane, lines?                         the screen (or last lines) as text
 *   ping
 */

/** The part of a daemon connection a session uses: `DaemonClient` is one, tests bring a fake. */
export interface DaemonLink extends EventEmitter {
  call<T = unknown>(type: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>
  input(paneId: string, data: string | Uint8Array): void
  pause(): void
  resume(): void
  close(): void
  readonly alive: boolean
}

export interface SessionOptions {
  readOnly: boolean
  version: string
  log?: (s: string) => void
  /** Output queued for a browser beyond this pauses the daemon connection until it drains. */
  highWater?: number
}

/** Messages that change anything. Read-only mode refuses them all, whatever the browser sends. */
export const WRITE_TYPES: ReadonlySet<string> = new Set(['input', 'resize', 'new', 'split', 'close', 'run'])

export const MAX_INPUT = 64 * 1024
export const MAX_COMMAND = 16 * 1024
const KINDS = new Set(['shell', 'pager', 'omp', 'claude', 'opencode', 'hermes'])
const EVENTS = ['state', 'pane_spawned', 'pane_exited', 'pane_closed', 'pane_resized', 'pane_title', 'pane_cwd', 'pane_resync', 'command_finished', 'bell', 'toast']
const PANE = /^\d{1,10}$/

const NO_REPLY = Symbol('no reply')

class Refused extends Error {}

type Msg = Record<string, unknown> & { t: string }

function pane(m: Msg): string {
  const p = m.pane
  if (typeof p !== 'string' || !PANE.test(p)) throw new Refused('pane must be a pane id')
  return p
}

function int(m: Msg, key: string, min: number, max: number): number {
  const v = m[key]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Refused(`${key} must be a whole number from ${min} to ${max}`)
  return v
}

function text(m: Msg, key: string, max: number, required = false): string | undefined {
  const v = m[key]
  if (v === undefined) {
    if (required) throw new Refused(`${key} is required`)
    return undefined
  }
  if (typeof v !== 'string' || v.length > max || v.includes('\0')) throw new Refused(`${key} must be text of at most ${max} characters`)
  if (required && v.length === 0) throw new Refused(`${key} is required`)
  return v
}

function size(m: Msg): { cols: number; rows: number } | undefined {
  if (m.cols === undefined && m.rows === undefined) return undefined
  return { cols: int(m, 'cols', 1, 1000), rows: int(m, 'rows', 1, 1000) }
}

function launch(m: Msg): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const kind = text(m, 'kind', 16)
  if (kind !== undefined) {
    if (!KINDS.has(kind)) throw new Refused(`kind must be one of ${[...KINDS].join(', ')}`)
    out.kind = kind
  }
  const cwd = text(m, 'cwd', 4096)
  if (cwd !== undefined) out.cwd = cwd
  const command = text(m, 'command', MAX_COMMAND)
  if (command !== undefined) out.command = command
  return out
}

const stripSettings = (s: DaemonState): Omit<DaemonState, 'settings'> => {
  const { settings: _settings, ...rest } = s
  return rest
}

function dataFrame(paneId: number, data: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(4 + data.length)
  out.writeUInt32LE(paneId, 0)
  out.set(data, 4)
  return out
}

type PaneState = 'dropping' | 'holding' | 'live'

/** Runs one browser connection until either side goes away. */
export class RemoteSession {
  private readonly states = new Map<string, PaneState>()
  private readonly held = new Map<string, Buffer[]>()
  private readonly heldBytes = new Map<string, number>()
  private readonly sizes = new Map<string, { cols: number; rows: number }>()
  private readonly resyncing = new Set<string>()
  private readonly finished = new Map<string, number | null>()
  private readonly waiters = new Set<(paneId: string) => void>()
  private paused = false
  private gone = false
  private readonly highWater: number

  constructor(
    private readonly ws: WsLike,
    private readonly link: DaemonLink,
    private readonly o: SessionOptions,
  ) {
    this.highWater = o.highWater ?? 8 * 1024 * 1024
    ws.on('message', (m: string | Buffer) => this.onMessage(m))
    ws.on('drain', () => this.onDrain())
    ws.on('close', () => this.dispose())
    link.on('data', (paneId: number, data: Buffer) => this.onData(paneId, data))
    link.on('event', (ev: { event: string; [k: string]: unknown }) => this.onEvent(ev))
    link.on('close', () => {
      if (!this.gone) ws.close(1011, 'the session daemon closed the connection')
    })
  }

  /** Subscribes to daemon events and sends the first messages. */
  async start(): Promise<void> {
    await this.link.call('events.subscribe', { filter: EVENTS })
    this.json({ t: 'hello', readOnly: this.o.readOnly, version: this.o.version })
    this.json({ t: 'state', state: stripSettings(await this.link.call<DaemonState>('state')) })
  }

  dispose(): void {
    if (this.gone) return
    this.gone = true
    this.states.clear()
    this.held.clear()
    this.link.close()
    this.ws.close(1001)
  }

  private json(v: unknown): void {
    this.ws.send(JSON.stringify(v))
  }

  private reply(id: unknown, ok: true, result?: unknown): void
  private reply(id: unknown, ok: false, error: string): void
  private reply(id: unknown, ok: boolean, payload?: unknown): void {
    if (typeof id !== 'number') return
    this.json(ok ? { t: 'reply', id, ok: true, result: payload } : { t: 'reply', id, ok: false, error: payload })
  }

  private onMessage(raw: string | Buffer): void {
    if (typeof raw !== 'string') return void this.ws.close(1003, 'text messages only')
    let m: unknown
    try {
      m = JSON.parse(raw)
    } catch {
      return void this.ws.close(1007, 'not JSON')
    }
    if (typeof m !== 'object' || m === null || Array.isArray(m) || !('t' in m) || typeof m.t !== 'string') return void this.ws.close(1008, 'a message is an object with a type')
    const msg = m as Msg // shape just checked: an object whose `t` is text
    const id = msg.id
    if (this.o.readOnly && WRITE_TYPES.has(msg.t)) return this.reply(id, false, 'read-only: this server refuses changes')
    this.dispatch(msg).then(
      (r) => {
        if (r !== NO_REPLY) this.reply(id, true, r)
      },
      (e: unknown) => {
        if (!(e instanceof Refused)) this.o.log?.(`${msg.t}: ${e instanceof Error ? e.message : String(e)}`)
        this.reply(id, false, e instanceof Error ? e.message : String(e))
      },
    )
  }

  private async dispatch(m: Msg): Promise<unknown> {
    switch (m.t) {
      case 'ping':
        return { pong: Date.now() }
      case 'state':
        return stripSettings(await this.link.call<DaemonState>('state'))
      case 'attach':
        return this.attach(m)
      case 'detach': {
        const p = pane(m)
        this.states.delete(p)
        this.held.delete(p)
        this.sizes.delete(p)
        await this.link.call('pane.detach', { paneId: p })
        return undefined
      }
      case 'capture': {
        const lines = m.lines === undefined ? undefined : int(m, 'lines', 1, 10_000)
        return this.link.call('pane.capture', { paneId: pane(m), plain: m.plain !== false, ...(lines === undefined ? {} : { lines }) })
      }
      case 'input': {
        const p = pane(m)
        if (typeof m.b64 === 'string') {
          if (m.b64.length > Math.ceil((MAX_INPUT * 4) / 3) + 4) throw new Refused('input is too large')
          this.link.input(p, Buffer.from(m.b64, 'base64'))
        } else {
          const data = text(m, 'data', MAX_INPUT, true)
          if (data !== undefined) this.link.input(p, data)
        }
        return undefined
      }
      case 'resize': {
        const p = pane(m)
        const sz = { cols: int(m, 'cols', 1, 1000), rows: int(m, 'rows', 1, 1000) }
        this.sizes.set(p, sz)
        await this.link.call('pane.resize', { paneId: p, ...sz })
        return undefined
      }
      case 'new':
        return this.link.call('tab.new', launch(m))
      case 'split': {
        if (m.dir !== 'row' && m.dir !== 'col') throw new Refused("dir must be 'row' or 'col'")
        return this.link.call('pane.split', { paneId: pane(m), dir: m.dir, ...launch(m) })
      }
      case 'close':
        return this.link.call('pane.close', { paneId: pane(m) })
      case 'run':
        return this.run(m)
      default:
        throw new Refused(`unknown message type: ${m.t}`)
    }
  }

  /** Replays the pane's screen, then streams its output. A pane already shown here is detached first so the replay never doubles bytes. */
  private async attach(m: Msg, push?: string): Promise<unknown> {
    const p = pane(m)
    const sz = this.o.readOnly ? undefined : size(m)
    if (sz !== undefined) this.sizes.set(p, sz)
    if (this.states.has(p)) {
      this.states.set(p, 'dropping') // output queued before the detach is in the replay below
      await this.link.call('pane.detach', { paneId: p })
    }
    this.states.set(p, 'holding')
    this.held.set(p, [])
    this.heldBytes.set(p, 0)
    let r: { replay: string; cols: number; rows: number; seq: number }
    try {
      r = await this.link.call('pane.attach', { paneId: p, ...(sz ?? this.sizes.get(p) ?? {}) })
    } catch (e) {
      this.states.delete(p)
      this.held.delete(p)
      throw e
    }
    if (this.states.get(p) !== 'holding') throw new Refused('detached while attaching')
    const result = { replay: r.replay, cols: r.cols, rows: r.rows }
    if (push === undefined) {
      this.reply(m.id, true, result)
    } else this.json({ t: 'resync', pane: p, ...result })
    this.states.set(p, 'live')
    const queue = this.held.get(p) ?? []
    this.held.delete(p)
    this.heldBytes.delete(p)
    for (const d of queue) this.sendData(Number(p), d)
    return NO_REPLY
  }

  private async run(m: Msg): Promise<unknown> {
    const command = text(m, 'command', MAX_COMMAND, true)!
    const waitMs = m.waitMs === undefined ? 0 : int(m, 'waitMs', 0, 60_000)
    const at = m.pane === undefined ? undefined : pane(m)
    const cwd = text(m, 'cwd', 4096)
    const made = await this.link.call<{ paneId: string }>('pane.run', { command, ...(at === undefined ? {} : { paneId: at }), ...(m.dir === 'col' || m.dir === 'row' ? { dir: m.dir } : {}), ...(cwd === undefined ? {} : { cwd }) })
    let exit: number | null | undefined = this.finished.get(made.paneId)
    if (waitMs > 0 && !this.finished.has(made.paneId)) {
      const done = Promise.withResolvers<void>()
      const waiter = (id: string): void => {
        if (id === made.paneId) done.resolve()
      }
      this.waiters.add(waiter)
      const timer = setTimeout(done.resolve, waitMs)
      await done.promise
      clearTimeout(timer)
      this.waiters.delete(waiter)
      exit = this.finished.get(made.paneId)
    }
    const shot = await this.link.call<{ text: string }>('pane.capture', { paneId: made.paneId, plain: true })
    return { paneId: made.paneId, text: shot.text, finished: exit !== undefined, exit: exit ?? null }
  }

  private onData(paneId: number, data: Buffer): void {
    const key = String(paneId)
    const st = this.states.get(key)
    if (st === 'live') return this.sendData(paneId, data)
    if (st !== 'holding') return
    const bytes = (this.heldBytes.get(key) ?? 0) + data.length
    if (bytes > 4 * 1024 * 1024) {
      // The browser's replay is not coming soon enough: start over from a fresh replay rather than hold without limit.
      this.held.set(key, [])
      this.heldBytes.set(key, 0)
      return
    }
    this.heldBytes.set(key, bytes)
    this.held.get(key)?.push(data)
  }

  private sendData(paneId: number, data: Buffer): void {
    this.ws.send(dataFrame(paneId, data))
    if (!this.paused && this.ws.bufferedAmount > this.highWater) {
      this.paused = true
      this.link.pause() // the daemon notices a slow reader, drops its output and tells us to resync once it drains
    }
  }

  private onDrain(): void {
    if (!this.paused) return
    this.paused = false
    this.link.resume()
  }

  private onEvent(ev: { event: string; [k: string]: unknown }): void {
    switch (ev.event) {
      case 'state':
        return this.json({ t: 'state', state: stripSettings(ev.state as DaemonState) })
      case 'pane_resync': {
        const p = String(ev.paneId)
        if (this.states.has(p) && !this.resyncing.has(p)) {
          this.resyncing.add(p)
          this.attach({ t: 'attach', pane: p }, 'resync')
            .catch((e: unknown) => this.o.log?.(`resync ${p}: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => this.resyncing.delete(p))
        }
        return
      }
      case 'pane_closed':
        this.states.delete(String(ev.paneId))
        this.held.delete(String(ev.paneId))
        break
      case 'command_finished': {
        const id = String(ev.paneId)
        this.finished.set(id, typeof ev.exit === 'number' ? ev.exit : null)
        if (this.finished.size > 64) this.finished.delete(this.finished.keys().next().value as string)
        for (const w of this.waiters) w(id)
        break
      }
    }
    this.json({ t: 'event', ...ev })
  }
}
