import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { VERSION } from '../app/version.js'
import { pageUrl } from '../platform/appBrowser.js'
import { detachPane, hasPane, locatePane, locateTab, movePane, newTab, paneIds, setRatio, setRatioAt, splitPane } from './layout.js'
import { AGENT_COMMANDS, isBlockKind, RESUME_COMMANDS, resolveLaunch, type LaunchContext, type LaunchRequest, type LaunchSpec } from './launch.js'
import { clampSize, folderTitle, PaneRuntime } from './panes.js'
import {
  daemonAddress,
  EVENT_NAMES,
  encodeData,
  encodeJson,
  FRAME_DATA,
  FrameDecoder,
  hostAddress,
  PROTOCOL_VERSION,
  type DaemonEvent,
  type DaemonState,
  type Frame,
  type Node,
  type Pane,
  type PaneKind,
  type Request,
  type Session,
} from './protocol.js'
import { applyPatch, loadSettings, saveSettings, type Settings } from './settings.js'
import { loadState, StateWriter, type SavedPane } from './state.js'

export interface DaemonOptions {
  dir: string
  /** The pipe or socket to listen on; default `daemonAddress(dir)`. */
  address?: string
  /** The cli.js that `pager` panes run. */
  cliPath: string
  nodePath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Test seam: what a pane runs. */
  launcher?: (req: LaunchRequest, ctx: LaunchContext) => Promise<LaunchSpec>
  /** A client with more than this many bytes unsent loses pane output until it re-attaches. */
  slowBytes?: number
  layoutSaveMs?: number
  dataSaveMs?: number
  ringBytes?: number
  log?: (line: string) => void
}

export interface DaemonHandle {
  address: string
  hostAddress: string
  /** Resolves once the daemon has stopped (`daemon.stop` or `close()`). */
  stopped: Promise<void>
  close(): Promise<void>
}

export class AlreadyRunningError extends Error {
  constructor(readonly address: string) {
    super(`a daemon already listens on ${address}`)
  }
}

const SLOW_BYTES = 4 * 1024 * 1024
/** A client this far behind on anything (events included) is cut off. */
const HARD_BYTES = 128 * 1024 * 1024
const STATE_COALESCE_MS = 30
const KINDS = new Set(['pager', 'shell', 'omp', 'claude', 'opencode', 'hermes', 'custom'])
/** After the old screen of a restored pane: leave a full-screen program's screen, drop its modes, say what happened. */
const MODES_OFF = '\x1b[?1049l\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1l'

type Args = Record<string, unknown>

interface LaunchArgs {
  kind: PaneKind
  cwd: string
  command?: string
  argv?: string[]
  cols?: number
  rows?: number
}

interface Created {
  sessionId: string
  tabId: string
  paneId: string
}

interface Client {
  id: number
  socket: net.Socket
  name: string
  kind: string
  said: boolean
  /** Event names this client wants; undefined: not subscribed. */
  events: Set<string> | 'all' | undefined
  attached: Set<string>
  /** Panes whose output this client missed: it gets none until it attaches again. */
  stale: Set<string>
  notified: boolean
}

const str = (a: Args, k: string): string => {
  const v = a[k]
  if (typeof v !== 'string' || v === '') throw new Error(`${k} is required`)
  return v
}
const opt = (a: Args, k: string): string | undefined => (typeof a[k] === 'string' && a[k] !== '' ? (a[k] as string) : undefined)
const argvOf = (a: Args): string[] | undefined => (Array.isArray(a.argv) && a.argv.length > 0 && a.argv.every((x) => typeof x === 'string') ? (a.argv as string[]) : undefined)

function asKind(v: unknown, fallback: PaneKind): PaneKind {
  if (v === undefined) return fallback
  if (typeof v === 'string' && (KINDS.has(v) || /^block:[a-z0-9_-]{1,32}$/.test(v))) return v as PaneKind
  throw new Error(`unknown pane kind: ${String(v)}`)
}

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

class Daemon {
  readonly address: string
  readonly hostAddr: string
  settings: Settings
  private readonly panes = new Map<string, PaneRuntime>()
  private sessions: Session[] = []
  private activeSession = ''
  private renamedTabs = new Set<string>()
  private nextPane = 0
  private nextTab = 0
  private nextSession = 0
  private readonly clients = new Map<number, Client>()
  private nextClient = 0
  private server: net.Server | undefined
  private hostServer: net.Server | undefined
  private readonly hostToken = randomBytes(16).toString('hex')
  private readonly writer: StateWriter
  private readonly started = Date.now()
  private closing: Promise<void> | undefined
  private stateTimer: NodeJS.Timeout | undefined
  private stateReasons = new Set<string>()
  private readonly done = Promise.withResolvers<void>()
  private readonly log: (line: string) => void
  private readonly slowBytes: number

  constructor(private readonly o: DaemonOptions) {
    this.address = o.address ?? daemonAddress(o.dir, o.env ?? process.env, o.platform)
    this.hostAddr = hostAddress(this.address, o.platform)
    this.settings = loadSettings(path.join(o.dir, 'desktop.json'))
    this.slowBytes = o.slowBytes ?? SLOW_BYTES
    this.log = o.log ?? ((l) => process.stderr.write(`[${new Date().toISOString()}] ${l}\n`))
    this.writer = new StateWriter(
      path.join(o.dir, 'daemon.state'),
      () => ({
        nextPane: this.nextPane,
        nextTab: this.nextTab,
        nextSession: this.nextSession,
        activeSession: this.activeSession,
        sessions: this.sessions,
        renamedTabs: [...this.renamedTabs],
        panes: [...this.panes.values()].map((rt) => ({ pane: rt.meta, total: rt.ring.total, tail: (n: number) => rt.ring.tail(n) })),
      }),
      { ...(o.layoutSaveMs === undefined ? {} : { layoutMs: o.layoutSaveMs }), ...(o.dataSaveMs === undefined ? {} : { dataMs: o.dataSaveMs }), onError: (e) => this.log(`cannot write daemon.state: ${e instanceof Error ? e.message : String(e)}`) },
    )
  }

  get stopped(): Promise<void> {
    return this.done.promise
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    await fs.promises.mkdir(this.o.dir, { recursive: true })
    await this.listen()
    await this.restore()
    await this.listenHost()
    this.log(`daemon ${VERSION} (pid ${process.pid}) listening on ${this.address}; ${this.panes.size} pane(s) restored`)
  }

  private async listen(): Promise<void> {
    const server = net.createServer((socket) => this.accept(socket))
    const bind = (): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      server.once('error', reject)
      server.listen(this.address, () => {
        server.off('error', reject)
        resolve()
      })
      return promise
    }
    try {
      await bind()
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
      if (process.platform === 'win32' || !(await this.stale(this.address))) throw new AlreadyRunningError(this.address)
      fs.rmSync(this.address, { force: true })
      await bind()
    }
    server.on('error', (e) => this.log(`server error: ${e.message}`))
    this.server = server
    if (process.platform !== 'win32') fs.chmodSync(this.address, 0o600)
  }

  /** A socket file nobody answers on is left over from a daemon that died. */
  private stale(address: string): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const probe = net.connect(address)
    probe.once('connect', () => {
      probe.destroy()
      resolve(false)
    })
    probe.once('error', () => resolve(true))
    return promise
  }

  /** The private pipe panes use to ask a window to show a URL (`pager docs` inside a pane); one line in, `ok` or `no` out. */
  private async listenHost(): Promise<void> {
    const server = net.createServer((sock) => {
      let buf = ''
      sock.setTimeout(5000, () => sock.destroy())
      sock.on('error', () => {})
      sock.on('data', (d) => {
        buf += d.toString('utf8')
        if (buf.length > 8192) return void sock.destroy()
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        let ok = false
        try {
          const m = JSON.parse(buf.slice(0, nl)) as { token?: unknown; type?: unknown; url?: unknown }
          if (typeof m.token === 'string' && sameToken(m.token, this.hostToken) && m.type === 'open' && typeof m.url === 'string' && pageUrl(m.url) !== undefined) {
            ok = this.windows() > 0
            if (ok) this.emit({ event: 'open_url', url: m.url })
          }
        } catch {
          // not JSON: refused
        }
        sock.end(ok ? 'ok\n' : 'no\n')
      })
    })
    server.on('error', (e) => this.log(`host pipe: ${e.message}`))
    if (process.platform !== 'win32') fs.rmSync(this.hostAddr, { force: true })
    const { promise, resolve } = Promise.withResolvers<void>()
    server.once('error', () => resolve()) // without it URLs from panes simply fail: the daemon still works
    server.listen(this.hostAddr, resolve)
    await promise
    this.hostServer = server
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    clearTimeout(this.stateTimer)
    this.writer.touch('layout')
    await this.writer.flush()
    for (const rt of this.panes.values()) rt.kill()
    this.panes.clear()
    for (const c of this.clients.values()) c.socket.destroy()
    this.clients.clear()
    await Promise.all(
      [this.server, this.hostServer].map(async (s) => {
        if (s === undefined) return
        const { promise, resolve } = Promise.withResolvers<void>()
        s.close(() => resolve())
        await promise
      }),
    )
    if (process.platform !== 'win32') {
      fs.rmSync(this.address, { force: true })
      fs.rmSync(this.hostAddr, { force: true })
    }
    this.log('daemon stopped')
    this.done.resolve()
  }

  // ---- connections -----------------------------------------------------------------------------------------------

  private accept(socket: net.Socket): void {
    const client: Client = { id: ++this.nextClient, socket, name: '', kind: '', said: false, events: undefined, attached: new Set(), stale: new Set(), notified: false }
    this.clients.set(client.id, client)
    const dec = new FrameDecoder()
    socket.on('data', (chunk) => {
      let frames: Frame[]
      try {
        frames = dec.push(chunk)
      } catch (e) {
        this.log(`client ${client.id}: ${e instanceof Error ? e.message : String(e)}`)
        return void socket.destroy()
      }
      for (const f of frames) this.onFrame(client, f)
    })
    socket.on('drain', () => this.onDrain(client))
    socket.on('error', () => {})
    socket.on('close', () => this.drop(client))
  }

  private drop(client: Client): void {
    if (!this.clients.delete(client.id)) return
    const hadWindow = client.said && client.kind === 'window'
    for (const id of client.attached) this.release(client, id)
    client.attached.clear()
    if (hadWindow) {
      this.emit({ event: 'client_detached', client: client.name, clients: this.windows() })
      this.changed('clients')
    }
  }

  private windows(): number {
    let n = 0
    for (const c of this.clients.values()) if (c.said && c.kind === 'window') n++
    return n
  }

  private send(c: Client, frame: Buffer): void {
    if (c.socket.destroyed) return
    c.socket.write(frame)
    if (c.socket.writableLength > HARD_BYTES) {
      this.log(`client ${c.id} is ${c.socket.writableLength} bytes behind: closed`)
      c.socket.destroy()
    }
  }

  private onFrame(c: Client, f: Frame): void {
    if (f.kind === 'data') {
      // Raw keyboard bytes for a pane: no JSON, no text decoding on the way.
      if (c.said) this.onInput(c, String(f.paneId), f.data)
      return
    }
    if (f.kind !== 'json') return // a frame type from a newer peer
    const req = f.json as Partial<Request> | null
    if (typeof req !== 'object' || req === null || typeof req.id !== 'number' || typeof req.type !== 'string') return
    const reply = (r: unknown): void => this.send(c, encodeJson(r))
    if (!c.said && req.type !== 'hello') return reply({ id: req.id, ok: false, error: 'the first request must be hello' })
    Promise.resolve()
      .then(() => this.handle(c, req as Request))
      .then(
        (result) => reply(result === undefined ? { id: req.id, ok: true } : { id: req.id, ok: true, result }),
        (e: unknown) => reply({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
  }

  // ---- events ----------------------------------------------------------------------------------------------------

  /** Sends an event to every client that subscribed to its name. */
  private emit(ev: DaemonEvent): void {
    let frame: Buffer | undefined
    for (const c of this.clients.values()) {
      if (c.events === undefined || (c.events !== 'all' && !c.events.has(ev.event))) continue
      frame ??= encodeJson(ev)
      this.send(c, frame)
    }
  }

  /** The layout or a pane's description changed: one `layout_changed` and one full `state` per burst, and a save soon. */
  private changed(reason: string): void {
    this.writer.touch('layout')
    this.stateReasons.add(reason)
    if (this.stateTimer !== undefined) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined
      const reasons = [...this.stateReasons]
      this.stateReasons.clear()
      this.syncTabTitles()
      this.emit({ event: 'layout_changed', reasons })
      this.emit({ event: 'state', state: this.snapshot() })
    }, STATE_COALESCE_MS)
  }

  private syncTabTitles(): void {
    for (const s of this.sessions) {
      for (const t of s.tabs) {
        if (this.renamedTabs.has(t.id)) continue
        const title = this.panes.get(t.focus)?.meta.title
        if (title !== undefined && title !== '') t.title = title
      }
    }
  }

  private snapshot(): DaemonState {
    return { sessions: this.sessions, panes: [...this.panes.values()].map((r) => ({ ...r.meta })), activeSession: this.activeSession, clients: this.windows(), settings: this.settings }
  }

  // ---- panes -----------------------------------------------------------------------------------------------------

  private launchContext(): LaunchContext {
    return { dataDir: this.o.dir, nodePath: this.o.nodePath ?? process.execPath, cliPath: this.o.cliPath, socket: this.address, hostPipe: this.hostAddr, hostToken: this.hostToken, settings: this.settings, env: this.o.env ?? process.env, platform: this.o.platform ?? process.platform }
  }

  private runtime(id: string): PaneRuntime {
    const rt = this.panes.get(id)
    if (rt === undefined) throw new Error(`no such pane: ${id}`)
    return rt
  }

  private makeRuntime(meta: Pane): PaneRuntime {
    const rt = new PaneRuntime(meta, { ...(this.o.ringBytes === undefined ? {} : { ringBytes: this.o.ringBytes }), scrollbackLines: Math.min(this.settings.scrollbackLines, 20_000) })
    const id = meta.id
    rt.on('data', (d: Buffer) => {
      this.fan(id, d)
      this.writer.touch('data')
    })
    rt.on('exit', (code: number) => {
      this.emit({ event: 'pane_exited', paneId: id, exitCode: code })
      this.changed('exit')
    })
    rt.on('title', (title: string) => {
      this.emit({ event: 'pane_title', paneId: id, title })
      this.changed('title')
    })
    rt.on('cwd', (cwd: string) => {
      this.emit({ event: 'pane_cwd', paneId: id, cwd })
      this.changed('cwd')
    })
    rt.on('bell', () => this.emit({ event: 'bell', paneId: id }))
    rt.on('resized', (cols: number, rows: number) => {
      this.emit({ event: 'pane_resized', paneId: id, cols, rows })
      this.changed('resize')
    })
    rt.on('finished', (b: { command: string; cwd: string; exit: number | null; startedAt: number; endedAt: number | null }) =>
      this.emit({ event: 'command_finished', paneId: id, command: b.command, cwd: b.cwd, exit: b.exit, ms: b.endedAt === null ? 0 : b.endedAt - b.startedAt }),
    )
    this.panes.set(id, rt)
    return rt
  }

  private defaultKind(): PaneKind {
    if (![...this.panes.values()].some((r) => r.meta.kind === 'pager' && r.meta.state !== 'exited')) return 'pager'
    return this.settings.newBlocks === 'agent' ? 'omp' : 'shell'
  }

  /** Where a new tab starts: the focused pane's folder (setting `newTabsStartIn`), else home. */
  private startCwd(): string {
    if (this.settings.newTabsStartIn === 'current') {
      const s = this.sessions.find((x) => x.id === this.activeSession)
      const tab = s?.tabs.find((t) => t.id === s.activeTab)
      const cwd = tab === undefined ? undefined : this.panes.get(tab.focus)?.meta.cwd
      if (cwd !== undefined && cwd !== '') return cwd
    }
    return os.homedir()
  }

  private async spawnPane(init: { kind: PaneKind; cwd: string; command?: string; argv?: string[]; cols?: number; rows?: number }): Promise<PaneRuntime> {
    const id = String(++this.nextPane)
    const { cols, rows } = clampSize(init.cols ?? 80, init.rows ?? 24)
    const block = isBlockKind(init.kind)
    const meta: Pane = { id, kind: init.kind, title: block ? init.kind.slice(6) : folderTitle(init.cwd), cwd: init.cwd, cols, rows, state: 'running', ...(init.command === undefined ? {} : { command: init.command }) }
    const rt = this.makeRuntime(meta)
    if (!block) {
      try {
        const req: LaunchRequest = { id, kind: init.kind, cwd: init.cwd, ...(init.command === undefined ? {} : { command: init.command }), ...(init.argv === undefined ? {} : { argv: init.argv }) }
        await rt.start(await (this.o.launcher ?? resolveLaunch)(req, this.launchContext()))
      } catch (e) {
        this.panes.delete(id)
        rt.kill()
        throw new Error(`cannot start ${init.kind}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    this.emit({ event: 'pane_spawned', pane: { ...rt.meta } })
    return rt
  }

  private launchArgs(a: Args, fallbackCwd: string, fallbackKind: PaneKind): LaunchArgs {
    const command = opt(a, 'command')
    const argv = argvOf(a)
    return {
      kind: asKind(a.kind, argv !== undefined && a.kind === undefined ? 'custom' : fallbackKind),
      cwd: opt(a, 'cwd') ?? fallbackCwd,
      ...(command === undefined ? {} : { command }),
      ...(argv === undefined ? {} : { argv }),
      ...(typeof a.cols === 'number' ? { cols: a.cols } : {}),
      ...(typeof a.rows === 'number' ? { rows: a.rows } : {}),
    }
  }

  private fan(paneId: string, data: Buffer): void {
    let frame: Buffer | undefined
    for (const c of this.clients.values()) {
      if (!c.attached.has(paneId) || c.stale.has(paneId)) continue
      if (c.socket.writableLength > this.slowBytes) {
        // Too slow to follow: stop feeding it any pane (keeping the daemon's memory flat), tell it once it drains.
        for (const p of c.attached) c.stale.add(p)
        c.notified = false
        this.log(`client ${c.id} (${c.name}) is behind: dropping its pane output until it re-attaches`)
        continue
      }
      frame ??= encodeData(Number(paneId), data)
      c.socket.write(frame)
    }
  }

  private onDrain(c: Client): void {
    if (c.stale.size === 0 || c.notified) return
    c.notified = true
    for (const paneId of c.stale) this.send(c, encodeJson({ event: 'pane_resync', paneId }))
  }

  /** While a window shows the pane, the window's terminal answers the program's queries; with none, the daemon does. */
  private refreshAnswering(id: string): void {
    const rt = this.panes.get(id)
    if (rt === undefined) return
    rt.answerQueries = ![...this.clients.values()].some((c) => c.attached.has(id))
  }

  private release(c: Client, id: string): void {
    const rt = this.panes.get(id)
    if (rt === undefined) return
    rt.votes.drop(c.id)
    rt.applySize()
    this.refreshAnswering(id)
  }

  private onInput(c: Client, id: string, data: string | Buffer): void {
    const rt = this.panes.get(id)
    if (rt === undefined) return
    rt.votes.touch(c.id)
    rt.applySize()
    if (rt.meta.state === 'restored' && rt.running) {
      rt.meta.state = 'running'
      this.changed('restored')
    }
    rt.write(data)
  }

  private attach(c: Client, a: Args): unknown {
    const id = str(a, 'paneId')
    const rt = this.runtime(id)
    if (typeof a.cols === 'number' && typeof a.rows === 'number') rt.votes.vote(c.id, a.cols, a.rows)
    else rt.votes.touch(c.id)
    rt.applySize()
    c.attached.add(id)
    c.stale.delete(id)
    this.refreshAnswering(id)
    // Synchronous with registering above: no output can fall between the replay and the first data frame.
    const snap = rt.snapshot()
    if (rt.needsRepaint()) setTimeout(() => rt.nudge(), 40)
    return { replay: snap.replay.toString('base64'), cols: snap.cols, rows: snap.rows, seq: snap.seq }
  }

  private async restart(id: string): Promise<void> {
    const old = this.runtime(id)
    if (old.running) throw new Error('the pane is still running')
    if (isBlockKind(old.meta.kind)) return
    const meta: Pane = { ...old.meta, state: 'running' }
    delete meta.exitCode
    delete meta.pid
    const history = old.ring.snapshot()
    old.kill()
    const rt = this.makeRuntime(meta)
    rt.seed(history)
    try {
      const req: LaunchRequest = { id, kind: meta.kind, cwd: meta.cwd, ...(meta.command === undefined ? {} : { command: meta.command }) }
      await rt.start(await (this.o.launcher ?? resolveLaunch)(req, this.launchContext()))
    } catch (e) {
      meta.state = 'exited'
      meta.exitCode = -1
      this.changed('restart')
      throw new Error(`cannot restart ${meta.kind}: ${e instanceof Error ? e.message : String(e)}`)
    }
    for (const c of this.clients.values()) if (c.attached.has(id)) this.send(c, encodeJson({ event: 'pane_resync', paneId: id }))
    this.changed('restart')
  }

  // ---- layout ----------------------------------------------------------------------------------------------------

  private session(id: string | undefined): Session {
    const s = this.sessions.find((x) => x.id === (id ?? this.activeSession))
    if (s === undefined) throw new Error(id === undefined ? 'no session yet' : `no such session: ${id}`)
    return s
  }

  private async createSession(name: string | undefined, init: LaunchArgs): Promise<Created> {
    const sid = `s${++this.nextSession}`
    const tid = `t${++this.nextTab}`
    const rt = await this.spawnPane(init)
    this.sessions.push({ id: sid, name: name ?? `Session ${this.sessions.length + 1}`, tabs: [newTab(tid, rt.meta.title, rt.meta.id)], activeTab: tid })
    this.activeSession = sid
    this.changed('session.new')
    return { sessionId: sid, tabId: tid, paneId: rt.meta.id }
  }

  private async createTab(sessionId: string | undefined, init: LaunchArgs): Promise<Created> {
    if (this.sessions.length === 0) return this.createSession(undefined, init)
    const s = this.session(sessionId)
    const tid = `t${++this.nextTab}`
    const rt = await this.spawnPane(init)
    s.tabs.push(newTab(tid, rt.meta.title, rt.meta.id))
    s.activeTab = tid
    this.activeSession = s.id
    this.changed('tab.new')
    return { sessionId: s.id, tabId: tid, paneId: rt.meta.id }
  }

  private async splitOf(paneId: string, dir: 'row' | 'col', a: Args): Promise<{ paneId: string }> {
    const src = this.runtime(paneId)
    const located = locatePane(this.sessions, paneId)
    if (located === undefined) throw new Error(`pane ${paneId} is in no tab`)
    const init = this.launchArgs(a, src.meta.cwd, 'shell')
    const rt = await this.spawnPane({ cols: Math.max(2, dir === 'row' ? Math.floor(src.meta.cols / 2) : src.meta.cols), rows: Math.max(1, dir === 'col' ? Math.floor(src.meta.rows / 2) : src.meta.rows), ...init })
    // The source may have been closed while the new program started.
    const now = locatePane(this.sessions, paneId)
    if (now === undefined) {
      rt.kill()
      this.panes.delete(rt.meta.id)
      throw new Error(`pane ${paneId} closed`)
    }
    const ratio = typeof a.ratio === 'number' ? a.ratio : 0.5
    now.tab.root = splitPane(now.tab.root, paneId, dir, rt.meta.id, { ratio, before: a.before === true })
    now.tab.focus = rt.meta.id
    now.session.activeTab = now.tab.id
    this.activeSession = now.session.id
    this.changed('pane.split')
    return { paneId: rt.meta.id }
  }

  private removeSession(id: string): void {
    const i = this.sessions.findIndex((s) => s.id === id)
    if (i < 0) return
    const [s] = this.sessions.splice(i, 1)
    for (const t of s!.tabs) this.renamedTabs.delete(t.id)
    if (this.activeSession === id) this.activeSession = (this.sessions[Math.min(i, this.sessions.length - 1)] ?? { id: '' }).id
  }

  private killPane(id: string): void {
    const rt = this.panes.get(id)
    if (rt === undefined) return
    for (const c of this.clients.values()) {
      if (c.attached.delete(id)) c.stale.delete(id)
    }
    rt.kill()
    this.panes.delete(id)
    this.emit({ event: 'pane_closed', paneId: id })
  }

  private closePane(id: string): void {
    this.runtime(id)
    const gone = detachPane(this.sessions, id)
    this.killPane(id)
    if (gone?.tabClosed) {
      this.renamedTabs.delete(gone.located.tab.id)
      if (gone.located.session.tabs.length === 0) this.removeSession(gone.located.session.id)
    }
    this.changed('pane.close')
  }

  // ---- requests --------------------------------------------------------------------------------------------------

  private async handle(c: Client, req: Request): Promise<unknown> {
    const a = req as unknown as Args
    switch (req.type) {
      case 'hello': {
        c.name = opt(a, 'name') ?? opt(a, 'client') ?? `client-${c.id}`
        c.kind = opt(a, 'client') ?? 'cli'
        c.said = true
        if (c.kind === 'window') {
          this.emit({ event: 'client_attached', client: c.name, clients: this.windows() })
          this.changed('clients')
        }
        return { version: PROTOCOL_VERSION, build: VERSION, pid: process.pid, clientId: c.id, address: this.address, uptimeMs: Date.now() - this.started }
      }
      case 'state':
        return this.snapshot()
      case 'status':
        return { pid: process.pid, build: VERSION, protocol: PROTOCOL_VERSION, uptimeMs: Date.now() - this.started, address: this.address, stateFile: path.join(this.o.dir, 'daemon.state'), panes: this.panes.size, running: [...this.panes.values()].filter((r) => r.running).length, sessions: this.sessions.length, clients: this.clients.size, windows: this.windows() }
      case 'stop':
      case 'daemon.stop':
        setImmediate(() => void this.close())
        return undefined
      case 'settings.get':
        return this.settings
      case 'settings.set': {
        this.settings = applyPatch(this.settings, a.patch)
        void saveSettings(path.join(this.o.dir, 'desktop.json'), this.settings).catch((e: unknown) => this.log(`cannot write desktop.json: ${e instanceof Error ? e.message : String(e)}`))
        this.changed('settings')
        return this.settings
      }
      case 'events.subscribe': {
        const f = a.filter
        const names = typeof f === 'string' ? f.split(',') : Array.isArray(f) ? f.filter((x): x is string => typeof x === 'string') : []
        const clean = names.map((n) => n.trim()).filter((n) => n !== '')
        const bad = clean.find((n) => !(EVENT_NAMES as readonly string[]).includes(n))
        if (bad !== undefined) throw new Error(`unknown event: ${bad} (known: ${EVENT_NAMES.join(', ')})`)
        c.events = clean.length === 0 ? 'all' : new Set(clean)
        return undefined
      }
      case 'session.new': {
        const init = this.launchArgs(a, this.startCwd(), this.defaultKind())
        return this.createSession(opt(a, 'name'), init)
      }
      case 'session.close': {
        const s = this.session(opt(a, 'sessionId'))
        for (const id of s.tabs.flatMap((t) => paneIds(t.root))) this.killPane(id)
        this.removeSession(s.id)
        this.changed('session.close')
        return undefined
      }
      case 'session.rename':
        this.session(opt(a, 'sessionId')).name = str(a, 'name')
        this.changed('session.rename')
        return undefined
      case 'tab.new': {
        const init = this.launchArgs(a, this.startCwd(), this.defaultKind() === 'pager' ? 'pager' : 'shell')
        return this.createTab(opt(a, 'sessionId'), init)
      }
      case 'tab.close': {
        const t = locateTab(this.sessions, str(a, 'tabId'))
        if (t === undefined) throw new Error('no such tab')
        for (const id of paneIds(t.tab.root)) this.killPane(id)
        t.session.tabs.splice(t.session.tabs.indexOf(t.tab), 1)
        this.renamedTabs.delete(t.tab.id)
        if (t.session.tabs.length === 0) this.removeSession(t.session.id)
        else if (t.session.activeTab === t.tab.id) t.session.activeTab = t.session.tabs[0]!.id
        this.changed('tab.close')
        return undefined
      }
      case 'tab.rename': {
        const t = locateTab(this.sessions, str(a, 'tabId'))
        if (t === undefined) throw new Error('no such tab')
        t.tab.title = str(a, 'title')
        this.renamedTabs.add(t.tab.id)
        this.changed('tab.rename')
        return undefined
      }
      case 'tab.activate': {
        const t = locateTab(this.sessions, str(a, 'tabId'))
        if (t === undefined) throw new Error('no such tab')
        t.session.activeTab = t.tab.id
        this.activeSession = t.session.id
        this.changed('tab.activate')
        return undefined
      }
      case 'pane.split': {
        const dir = a.dir === 'col' ? 'col' : a.dir === 'row' ? 'row' : undefined
        if (dir === undefined) throw new Error("dir must be 'row' or 'col'")
        return this.splitOf(str(a, 'paneId'), dir, a)
      }
      case 'pane.run': {
        const command = str(a, 'command')
        const paneId = opt(a, 'paneId')
        if (paneId !== undefined && this.panes.has(paneId) && locatePane(this.sessions, paneId) !== undefined) return this.splitOf(paneId, a.dir === 'col' ? 'col' : 'row', { ...a, command, kind: a.kind ?? 'shell' })
        const init = this.launchArgs({ ...a, command, kind: a.kind ?? 'shell' }, this.startCwd(), 'shell')
        return this.createTab(opt(a, 'sessionId'), init)
      }
      case 'pane.close':
        this.closePane(str(a, 'paneId'))
        return undefined
      case 'pane.restart':
        await this.restart(str(a, 'paneId'))
        return undefined
      case 'pane.focus': {
        const id = str(a, 'paneId')
        this.runtime(id)
        const at = locatePane(this.sessions, id)
        if (at === undefined) throw new Error(`pane ${id} is in no tab`)
        at.tab.focus = id
        at.session.activeTab = at.tab.id
        this.activeSession = at.session.id
        this.panes.get(id)?.votes.touch(c.id)
        this.changed('pane.focus')
        return undefined
      }
      case 'pane.ratio': {
        const id = str(a, 'paneId')
        const at = locatePane(this.sessions, id)
        if (at === undefined || typeof a.ratio !== 'number') throw new Error('pane.ratio needs a pane in a split and a ratio')
        at.tab.root = typeof a.path === 'string' ? setRatioAt(at.tab.root, a.path, a.ratio) : setRatio(at.tab.root, id, a.ratio)
        this.changed('pane.ratio')
        return undefined
      }
      case 'pane.move': {
        if (!movePane(this.sessions, str(a, 'paneId'), str(a, 'toTab'))) throw new Error('cannot move that pane there')
        const to = locateTab(this.sessions, str(a, 'toTab'))
        if (to !== undefined) {
          to.session.activeTab = to.tab.id
          this.activeSession = to.session.id
        }
        // A session left without tabs goes away.
        for (const s of [...this.sessions]) if (s.tabs.length === 0) this.removeSession(s.id)
        this.changed('pane.move')
        return undefined
      }
      case 'pane.input': {
        const id = str(a, 'paneId')
        this.runtime(id)
        const data = typeof a.b64 === 'string' ? Buffer.from(a.b64, 'base64') : typeof a.data === 'string' ? a.data : undefined
        if (data === undefined) throw new Error('data is required')
        this.onInput(c, id, data)
        return undefined
      }
      case 'pane.paste': {
        const rt = this.runtime(str(a, 'paneId'))
        rt.paste(str(a, 'text'))
        return undefined
      }
      case 'pane.resize': {
        const id = str(a, 'paneId')
        const rt = this.runtime(id)
        if (typeof a.cols !== 'number' || typeof a.rows !== 'number') throw new Error('cols and rows are required')
        rt.votes.vote(c.id, a.cols, a.rows)
        rt.applySize()
        return undefined
      }
      case 'pane.attach':
        return this.attach(c, a)
      case 'pane.detach': {
        const id = opt(a, 'paneId')
        const ids = id === undefined ? [...c.attached] : [id]
        for (const p of ids) {
          if (c.attached.delete(p)) this.release(c, p)
          c.stale.delete(p)
        }
        return undefined
      }
      case 'pane.capture': {
        const rt = this.runtime(str(a, 'paneId'))
        return rt.capture(typeof a.lines === 'number' ? Math.max(1, Math.floor(a.lines)) : undefined, a.plain !== false)
      }
      case 'open':
        return this.open(a)
      default:
        throw new Error(`unknown request: ${req.type}`)
    }
  }

  /** `pager open`: a URL goes to the window's browser pane; a path opens in a files block beside the asking pane, or in a new tab. */
  private async open(a: Args): Promise<unknown> {
    const url = opt(a, 'url')
    if (url !== undefined) {
      if (pageUrl(url) === undefined) throw new Error('only http and https pages open')
      if (this.windows() === 0) throw new Error('no window is attached: start the desktop app, then try again')
      this.emit({ event: 'open_url', url })
      return undefined
    }
    const file = str(a, 'path')
    const args = JSON.stringify({ path: file, ...(typeof a.line === 'number' ? { line: a.line } : {}), ...(typeof a.col === 'number' ? { col: a.col } : {}) })
    const dir = path.dirname(path.resolve(file))
    const paneId = opt(a, 'paneId')
    const init = { kind: 'block:files' as PaneKind, cwd: dir, command: args }
    let made: { paneId: string }
    if (paneId !== undefined && a.tab !== true && locatePane(this.sessions, paneId) !== undefined) made = await this.splitOf(paneId, a.dir === 'col' ? 'col' : 'row', init)
    else made = await this.createTab(undefined, init)
    this.emit({ event: 'open_path', path: path.resolve(file), paneId: made.paneId, ...(typeof a.line === 'number' ? { line: a.line } : {}), ...(typeof a.col === 'number' ? { col: a.col } : {}) })
    return made
  }

  // ---- restore ---------------------------------------------------------------------------------------------------

  /** Brings back the panes of the last run: each in its folder, over its old output, agents resuming. */
  private async restore(): Promise<void> {
    const saved = await loadState(path.join(this.o.dir, 'daemon.state'))
    if (saved === undefined) return
    const byId = new Map(saved.panes.map((p) => [p.pane.id, p]))
    const prune = (n: Node): Node | null => {
      if (n.type === 'pane') return byId.has(n.paneId) ? n : null
      const x = prune(n.a)
      const y = prune(n.b)
      return x === null ? y : y === null ? x : { ...n, a: x, b: y }
    }
    const live = new Set<string>()
    for (const s of saved.sessions) {
      s.tabs = s.tabs.flatMap((t) => {
        const root = prune(t.root)
        if (root === null) return []
        for (const id of paneIds(root)) live.add(id)
        return [{ ...t, root, focus: hasPane(root, t.focus) ? t.focus : (paneIds(root)[0] ?? '') }]
      })
      if (!s.tabs.some((t) => t.id === s.activeTab)) s.activeTab = s.tabs[0]?.id ?? ''
    }
    this.sessions = saved.sessions.filter((s) => s.tabs.length > 0)
    this.activeSession = this.sessions.some((s) => s.id === saved.activeSession) ? saved.activeSession : (this.sessions[0]?.id ?? '')
    this.renamedTabs = new Set(saved.renamedTabs)
    const maxOf = (ids: Iterable<string>, prefix: string): number => Math.max(0, ...[...ids].map((i) => Number(i.replace(prefix, '')) || 0))
    this.nextPane = Math.max(saved.nextPane, maxOf(byId.keys(), ''))
    this.nextSession = Math.max(saved.nextSession, maxOf(this.sessions.map((s) => s.id), 's'))
    this.nextTab = Math.max(saved.nextTab, maxOf(this.sessions.flatMap((s) => s.tabs.map((t) => t.id)), 't'))
    await Promise.all(saved.panes.filter((p) => live.has(p.pane.id)).map((p) => this.revive(p)))
  }

  private async revive(sp: SavedPane): Promise<void> {
    const old = sp.pane
    let { kind } = old
    let command = old.command
    let resume: string | undefined
    let start = true
    if (isBlockKind(kind)) start = false
    else if (kind === 'pager') start = !sp.exited
    else if (kind in AGENT_COMMANDS) {
      if (sp.exited) {
        // An agent you had quit stays quit: a plain shell comes back in its folder.
        kind = 'shell'
        command = undefined
      } else resume = RESUME_COMMANDS[kind]
    } else if (kind === 'custom' && sp.exited) {
      kind = 'shell'
      command = undefined
    } else if (kind === 'shell') command = undefined
    const meta: Pane = { ...old, kind, state: 'restored' }
    if (command === undefined) delete meta.command
    else meta.command = command
    delete meta.pid
    delete meta.cpu
    const rt = this.makeRuntime(meta)
    rt.seed(sp.scrollback)
    const when = new Date().toLocaleString()
    rt.seed(Buffer.from(`${MODES_OFF}\r\n\x1b[2m── restored ${when} · ${meta.cwd} ──\x1b[0m\r\n`))
    if (!start) {
      meta.state = isBlockKind(kind) ? 'running' : 'exited'
      if (meta.state === 'exited') meta.exitCode = old.exitCode ?? 0
      return
    }
    try {
      const req: LaunchRequest = { id: meta.id, kind, cwd: meta.cwd, ...(command === undefined ? {} : { command }), ...(resume === undefined ? {} : { resume }) }
      await rt.start(await (this.o.launcher ?? resolveLaunch)(req, this.launchContext()))
    } catch (e) {
      this.log(`cannot restore pane ${meta.id}: ${e instanceof Error ? e.message : String(e)}`)
      meta.state = 'exited'
      meta.exitCode = -1
    }
  }
}

/** Starts the daemon: listens, restores the last run's panes, serves until `close()` or a `daemon.stop` request. */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const d = new Daemon(opts)
  await d.start()
  return { address: d.address, hostAddress: d.hostAddr, stopped: d.stopped, close: () => d.close() }
}
