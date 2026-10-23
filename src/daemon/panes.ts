import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from '@lydell/node-pty'
import { BlockTracker, type CommandBlock } from '../tools/terminal/blocks.js'
import { newTerm, type XTerm } from '../tools/terminal/xterm.js'
import { isBlockKind, type LaunchSpec } from './launch.js'
import type { Pane } from './protocol.js'

export const RING_BYTES = 2 * 1024 * 1024
const COALESCE = 64 * 1024
const PARSE_HIGH = 1024 * 1024
const PARSE_LOW = 256 * 1024
const MIN_COLS = 2
const MAX_COLS = 1000
const MAX_ROWS = 500

export const clampSize = (cols: number, rows: number): { cols: number; rows: number } => ({
  cols: Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(Number.isFinite(cols) ? cols : 80))),
  rows: Math.min(MAX_ROWS, Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 24))),
})

/** The newest `cap` bytes of a pane's output, kept as chunks (small ones merged) so pushing never copies the whole ring. */
export class ByteRing {
  private chunks: Buffer[] = []
  private size = 0
  /** Bytes ever pushed (the replay sequence number), including those the ring dropped. */
  total = 0
  /** The ring dropped output: a replay no longer starts at the pane's beginning. */
  wrapped = false

  constructor(readonly cap: number = RING_BYTES) {}

  push(data: Buffer): void {
    if (data.length === 0) return
    this.total += data.length
    this.size += data.length
    const last = this.chunks[this.chunks.length - 1]
    if (last !== undefined && last.length < 4096 && last.length + data.length <= COALESCE) this.chunks[this.chunks.length - 1] = Buffer.concat([last, data])
    else this.chunks.push(data)
    while (this.size > this.cap) {
      this.wrapped = true
      const first = this.chunks[0]!
      const excess = this.size - this.cap
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.size -= excess
      }
    }
  }

  snapshot(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)]
    return this.chunks[0] ?? Buffer.alloc(0)
  }

  /** The newest `n` bytes without merging the ring. */
  tail(n: number): Buffer {
    const all = this.snapshot()
    return all.length <= n ? all : all.subarray(all.length - n)
  }

  clear(): void {
    this.chunks = []
    this.size = 0
    this.wrapped = false
  }
}

/**
 * Which size a pane runs at when several windows show it: the most recently active client's. Activity is typing, focusing,
 * attaching or resizing; a client that detaches stops voting and the next most recent takes over.
 */
export class SizeVotes {
  private readonly votes = new Map<number, { cols: number; rows: number; at: number }>()
  private clock = 0

  /** `at` defaults to a monotonic counter so ties never depend on the timer's resolution. */
  vote(client: number, cols: number, rows: number): void {
    this.votes.set(client, { cols, rows, at: ++this.clock })
  }

  touch(client: number): void {
    const v = this.votes.get(client)
    if (v !== undefined) v.at = ++this.clock
  }

  drop(client: number): void {
    this.votes.delete(client)
  }

  effective(): { cols: number; rows: number } | undefined {
    let best: { cols: number; rows: number; at: number } | undefined
    for (const v of this.votes.values()) if (best === undefined || v.at > best.at) best = v
    return best === undefined ? undefined : { cols: best.cols, rows: best.rows }
  }
}

// Queries a program prints and the terminal answers (device attributes, cursor position, colors, modes). A replayed screen
// must not make the attaching terminal answer them again: the answers would be typed into the program as input.
const QUERIES = [
  String.raw`\x1b\[[?>=]?[0-9;]*c`, // DA1/DA2/DA3
  String.raw`\x1b\[[?]?[0-9;]*n`, // DSR, cursor position
  String.raw`\x1b\[(?:1[4689]|2[01])(?:;[0-9]*)*t`, // window size / title reports
  String.raw`\x1b\[[?]?[0-9;]*\$p`, // DECRQM
  String.raw`\x1b\[\?u`, // kitty keyboard flags
  String.raw`\x1b\[>[0-9]*q`, // XTVERSION
  String.raw`\x1b\](?:10|11|12|4;[0-9]+);\?(?:\x07|\x1b\\)`, // palette and color queries
  String.raw`\x1bP\$q[^\x1b]*\x1b\\`, // DECRQSS
].join('|')
const QUERY_RE = new RegExp(QUERIES, 'g')

/** Removes terminal queries from recorded output (byte-exact otherwise). */
export function stripQueries(data: Buffer): Buffer {
  if (!data.includes(0x1b)) return data
  const s = data.toString('latin1')
  const out = s.replace(QUERY_RE, '')
  return out.length === s.length ? data : Buffer.from(out, 'latin1')
}

export interface Snapshot {
  replay: Buffer
  cols: number
  rows: number
  seq: number
}

export interface PaneOptions {
  ringBytes?: number
  scrollbackLines?: number
}

type SpawnFn = typeof import('@lydell/node-pty').spawn

/**
 * One pane: a PTY (unless it is a block), the ring of raw output windows replay from, and a headless xterm that tracks
 * titles, cwd, prompt marks and the screen for `capture`. Emits data(Buffer), exit(code), title, cwd, prompt, finished(CommandBlock), bell, resized.
 */
export class PaneRuntime extends EventEmitter {
  readonly ring: ByteRing
  readonly votes = new SizeVotes()
  /** While false the daemon answers the program's terminal queries itself (nobody is attached to answer them). */
  answerQueries = true
  private pty: IPty | undefined
  private term: XTerm | undefined
  private tracker: BlockTracker | undefined
  private launch: LaunchSpec | undefined
  private oscTitle = ''
  private titleLocked = false
  private pending = 0
  private paused = false
  private muted = 0
  private dead = false
  private lastOutput = 0
  private typeTimer: NodeJS.Timeout | undefined

  constructor(
    readonly meta: Pane,
    private readonly opts: PaneOptions = {},
  ) {
    super()
    this.ring = new ByteRing(opts.ringBytes)
    if (!isBlockKind(meta.kind)) this.term = newTerm({ cols: meta.cols, rows: meta.rows, scrollback: opts.scrollbackLines ?? 5000, allowProposedApi: true })
    if (this.term !== undefined) this.attachTerm(this.term)
  }

  get running(): boolean {
    return this.pty !== undefined && !this.dead && this.meta.state !== 'exited'
  }

  lockTitle(title: string): void {
    this.titleLocked = true
    this.meta.title = title
  }

  private attachTerm(term: XTerm): void {
    this.tracker = new BlockTracker(term)
    this.tracker.on('finished', (b: CommandBlock) => this.emit('finished', b))
    term.onData((d) => {
      if (this.answerQueries && this.muted === 0) this.pty?.write(d)
    })
    term.onTitleChange((t) => {
      this.oscTitle = t
      this.refreshTitle()
    })
    term.onBell(() => this.emit('bell'))
    // Returns false so the block tracker's own OSC 133 handler still runs.
    term.parser.registerOscHandler(133, (d) => {
      if (d.startsWith('A')) this.emit('prompt')
      return false
    })
    term.parser.registerOscHandler(7, () => {
      queueMicrotask(() => this.refreshCwd())
      return false
    })
  }

  private refreshCwd(): void {
    const c = this.tracker?.cwd()
    if (c !== undefined && c !== this.meta.cwd) {
      this.meta.cwd = c
      this.emit('cwd', c)
      this.refreshTitle()
    }
  }

  private refreshTitle(): void {
    if (this.titleLocked) return
    const { kind } = this.meta
    // A plain shell shows its folder (pwsh titles itself with its exe path); programs it runs, and non-shell panes, show their own title.
    const own = this.oscTitle !== '' && (!this.launch?.shell || this.tracker?.running() !== undefined || !this.launch.integrated)
    const title = own ? this.oscTitle : kind === 'pager' ? 'Pager' : this.launch?.shell === false && this.meta.command !== undefined ? this.meta.command : folderTitle(this.meta.cwd)
    if (title !== this.meta.title) {
      this.meta.title = title
      this.emit('title', title)
    }
  }

  /** Starts the program. Resolves once the PTY exists. */
  async start(launch: LaunchSpec, spawn?: SpawnFn): Promise<void> {
    this.launch = launch
    const doSpawn = spawn ?? (await import('@lydell/node-pty')).spawn
    const opt = { name: 'xterm-256color', cols: this.meta.cols, rows: this.meta.rows, cwd: launch.cwd, env: launch.env, encoding: null }
    let pty: IPty
    try {
      pty = doSpawn(launch.file, launch.args, process.platform === 'win32' ? { ...opt, useConptyDll: true } : opt)
    } catch (e) {
      if (process.platform !== 'win32') throw e
      // The bundled conpty.dll is the better host; the system one still works if it cannot load.
      pty = doSpawn(launch.file, launch.args, opt)
    }
    this.pty = pty
    this.meta.pid = pty.pid
    this.meta.state = this.meta.state === 'restored' ? 'restored' : 'running'
    this.meta.cwd = launch.cwd
    this.refreshTitle()
    pty.onData((d) => this.onOutput(typeof d === 'string' ? Buffer.from(d, 'utf8') : d))
    pty.onExit((e) => this.onExit(e.exitCode))
    if (launch.typeAhead !== undefined) this.typeAhead(launch.typeAhead, launch.integrated)
  }

  private typeAhead(text: string, integrated: boolean): void {
    const send = (): void => {
      clearTimeout(this.typeTimer)
      this.off('prompt', send)
      if (this.running) this.pty?.write(`${text}\r`)
    }
    if (integrated) this.once('prompt', send)
    this.typeTimer = setTimeout(send, integrated ? 6000 : 900)
  }

  private onOutput(data: Buffer): void {
    this.lastOutput = Date.now()
    this.ring.push(data)
    this.emit('data', data)
    const term = this.term
    if (term === undefined) return
    this.pending += data.length
    term.write(data, () => {
      this.pending -= data.length
      if (this.paused && this.pending < PARSE_LOW) {
        this.paused = false
        this.pty?.resume()
      }
    })
    // A program flooding the pane must not balloon the parse queue: stop reading until the parser catches up.
    if (!this.paused && this.pending > PARSE_HIGH) {
      this.paused = true
      this.pty?.pause()
    }
  }

  private onExit(code: number): void {
    this.dead = true
    clearTimeout(this.typeTimer)
    this.meta.state = 'exited'
    this.meta.exitCode = code
    delete this.meta.pid
    this.emit('exit', code)
  }

  /** Feeds old output (a restored pane's scrollback) into the ring and the screen model, without answering its queries. */
  seed(old: Buffer): void {
    const clean = stripQueries(old)
    this.ring.push(clean)
    if (this.term === undefined) return
    this.muted++
    this.term.write(clean, () => {
      this.muted--
      this.refreshCwd()
    })
  }

  write(data: string | Buffer): void {
    if (this.running) this.pty?.write(data as string)
  }

  paste(text: string): void {
    this.write(this.term?.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text)
  }

  /** Applies the size the votes settle on. */
  applySize(): boolean {
    const eff = this.votes.effective()
    return eff === undefined ? false : this.resize(eff.cols, eff.rows)
  }

  resize(cols: number, rows: number): boolean {
    const { cols: c, rows: r } = clampSize(cols, rows)
    if (c === this.meta.cols && r === this.meta.rows) return false
    this.meta.cols = c
    this.meta.rows = r
    if (this.running) {
      try {
        this.pty?.resize(c, r)
      } catch {
        // the process is going away
      }
    }
    this.term?.resize(c, r)
    this.emit('resized', c, r)
    return true
  }

  /** What an attaching terminal needs to look like this pane: modes the ring no longer holds, then the ring, queries removed. */
  snapshot(): Snapshot {
    const body = stripQueries(this.ring.snapshot())
    const prefix = this.ring.wrapped ? this.modePrefix() : ''
    const replay = prefix === '' ? Buffer.from(body) : Buffer.concat([Buffer.from(prefix, 'latin1'), body])
    return { replay, cols: this.meta.cols, rows: this.meta.rows, seq: this.ring.total }
  }

  private modePrefix(): string {
    const t = this.term
    if (t === undefined) return ''
    let out = '\x1b[0m'
    if (t.buffer.active.type === 'alternate') out += '\x1b[?1049h'
    const m = t.modes
    if (m.applicationCursorKeysMode) out += '\x1b[?1h'
    if (m.bracketedPasteMode) out += '\x1b[?2004h'
    if (m.sendFocusMode) out += '\x1b[?1004h'
    const mouse = { x10: 9, vt200: 1000, drag: 1002, any: 1003, none: 0 }[m.mouseTrackingMode]
    if (mouse) out += `\x1b[?${mouse}h\x1b[?1006h`
    return out
  }

  /** True when the ring lost the start of the screen of a full-screen program: attach should make it repaint. */
  needsRepaint(): boolean {
    return this.ring.wrapped && this.term?.buffer.active.type === 'alternate'
  }

  /** Makes a full-screen program redraw by bouncing the size by one row. */
  nudge(): void {
    if (!this.running) return
    const { cols, rows } = this.meta
    try {
      this.pty?.resize(cols, rows > 1 ? rows - 1 : rows + 1)
      setTimeout(() => {
        if (this.running) this.pty?.resize(this.meta.cols, this.meta.rows)
      }, 60)
    } catch {
      // gone
    }
  }

  async flush(): Promise<void> {
    const term = this.term
    if (term === undefined) return
    await new Promise<void>((resolve) => term.write('', resolve))
  }

  /** Visible screen, or the newest `lines` lines of scrollback + screen, as plain text; or the raw tail of the output with its escapes. */
  async capture(lines: number | undefined, plain: boolean): Promise<{ text: string; cols: number; rows: number; cursor: { x: number; y: number }; alternate: boolean }> {
    await this.flush()
    const term = this.term
    const base = { cols: this.meta.cols, rows: this.meta.rows }
    if (term === undefined) return { ...base, text: '', cursor: { x: 0, y: 0 }, alternate: false }
    const buf = term.buffer.active
    const cursor = { x: buf.cursorX, y: buf.cursorY }
    const alternate = buf.type === 'alternate'
    if (!plain) {
      const text = stripQueries(this.ring.tail(Math.max(4096, (lines ?? this.meta.rows) * 512))).toString('utf8')
      const parts = text.split('\n')
      const n = lines ?? this.meta.rows
      return { ...base, text: parts.slice(Math.max(0, parts.length - n - 1)).join('\n').trimEnd(), cursor, alternate }
    }
    const first = lines === undefined ? buf.baseY : Math.max(0, buf.baseY + buf.cursorY + 1 - lines)
    const last = lines === undefined ? buf.baseY + term.rows - 1 : buf.baseY + buf.cursorY
    const out: string[] = []
    for (let y = first; y <= Math.max(first, last); y++) {
      const line = buf.getLine(y)
      if (line === undefined) continue
      const text = line.translateToString(true)
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text
      else out.push(text)
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    return { ...base, text: out.join('\n'), cursor, alternate }
  }

  /** The pane holds a program whose end would lose work: anything but an idle shell. */
  busy(): boolean {
    if (!this.running) return false
    const k = this.meta.kind
    if (k === 'pager' || k === 'custom') return true
    if (this.launch?.shell !== true) return true
    if (this.tracker?.running() !== undefined) return true
    if (k !== 'shell') return this.tracker?.seen() !== true // an agent typed into a shell without prompt marks: assume it runs
    return false
  }

  /** Whether the shell sits at a prompt (the last command finished) or output went quiet for `ms`. */
  idleFor(): number {
    return Date.now() - this.lastOutput
  }

  atPrompt(): boolean {
    return this.tracker !== undefined && this.tracker.seen() && this.tracker.running() === undefined
  }

  /** Newest command blocks, for `inspect`. */
  blocks(): readonly CommandBlock[] {
    return this.tracker?.list() ?? []
  }

  kill(): void {
    if (this.dead) {
      this.dispose()
      return
    }
    this.dead = true
    clearTimeout(this.typeTimer)
    try {
      this.pty?.kill()
    } catch {
      // already gone
    }
    this.dispose()
  }

  private dispose(): void {
    this.removeAllListeners()
    try {
      this.term?.dispose()
    } catch {
      // disposed twice
    }
    this.term = undefined
  }
}

export function folderTitle(cwd: string): string {
  if (cwd === '') return '~'
  const home = os.homedir()
  if (path.resolve(cwd).toLowerCase() === home.toLowerCase()) return '~'
  return path.basename(cwd) || cwd
}
