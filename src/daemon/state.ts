import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import type { Pane, Session } from './protocol.js'

// `daemon.state`: what the daemon keeps on disk so panes come back after a reboot or a crash. The layout and each pane's
// newest 2 MiB of output (deflated, 64 MiB in all, the biggest trimmed first). Nothing else is ever written for output.

export const STATE_VERSION = 1
export const PER_PANE_BYTES = 2 * 1024 * 1024
export const TOTAL_BYTES = 64 * 1024 * 1024

const deflate = promisify(zlib.deflate)
const inflate = promisify(zlib.inflate)

export interface SavedPane {
  /** The pane as it was (pid and cpu are not kept). */
  pane: Pane
  /** The program had already ended when the state was written. */
  exited: boolean
  /** The newest bytes of output. */
  scrollback: Buffer
}

export interface SavedState {
  version: number
  savedAt: number
  nextPane: number
  nextTab: number
  nextSession: number
  activeSession: string
  sessions: Session[]
  /** Tabs whose title the user set: they stop following their focused pane's title. */
  renamedTabs: string[]
  panes: SavedPane[]
}

/** What the daemon hands the writer for one pane; `tail` is only called when the pane's output changed since the last write. */
export interface PaneSource {
  pane: Pane
  /** Bytes ever produced: unchanged means the packed copy from the last write is still good. */
  total: number
  tail(n: number): Buffer
}

export interface LayoutSource {
  nextPane: number
  nextTab: number
  nextSession: number
  activeSession: string
  sessions: Session[]
  renamedTabs: string[]
  panes: PaneSource[]
}

interface Packed {
  total: number
  cap: number
  z: Buffer
}

/** Packed scrollback per pane, so a pane that did not change since the last write is not compressed again. */
export class ScrollbackCache {
  private readonly packed = new Map<string, Packed>()

  async pack(src: PaneSource, cap: number): Promise<Buffer> {
    const hit = this.packed.get(src.pane.id)
    if (hit !== undefined && hit.total === src.total && hit.cap <= cap) return hit.z
    // Level 1: this runs while the user types; a fast pass beats the last few percent.
    const z = await deflate(src.tail(cap), { level: 1 })
    this.packed.set(src.pane.id, { total: src.total, cap, z })
    return z
  }

  forget(ids: ReadonlySet<string>): void {
    for (const id of this.packed.keys()) if (!ids.has(id)) this.packed.delete(id)
  }
}

interface FileShape {
  version: number
  savedAt: number
  nextPane: number
  nextTab: number
  nextSession: number
  activeSession: string
  sessions: Session[]
  renamedTabs: string[]
  panes: { pane: Pane; exited: boolean; scrollback: string }[]
}

/** Builds the file's text: every pane's newest bytes capped at 2 MiB, the whole capped at 64 MiB by trimming the largest first. */
export async function encodeState(src: LayoutSource, cache = new ScrollbackCache(), perPane = PER_PANE_BYTES, total = TOTAL_BYTES): Promise<string> {
  const caps = new Map<string, number>(src.panes.map((p) => [p.pane.id, perPane]))
  const packed = new Map<string, Buffer>()
  for (const p of src.panes) packed.set(p.pane.id, await cache.pack(p, perPane))
  const sum = (): number => [...packed.values()].reduce((n, b) => n + b.length, 0)
  for (let guard = 0; sum() > total && guard < 64; guard++) {
    let big: PaneSource | undefined
    for (const p of src.panes) if (big === undefined || packed.get(p.pane.id)!.length > packed.get(big.pane.id)!.length) big = p
    if (big === undefined) break
    const cap = Math.floor(caps.get(big.pane.id)! / 2)
    caps.set(big.pane.id, cap)
    packed.set(big.pane.id, cap < 1024 ? Buffer.alloc(0) : await cache.pack(big, cap))
  }
  cache.forget(new Set(src.panes.map((p) => p.pane.id)))
  const body: FileShape = {
    version: STATE_VERSION,
    savedAt: Date.now(),
    nextPane: src.nextPane,
    nextTab: src.nextTab,
    nextSession: src.nextSession,
    activeSession: src.activeSession,
    sessions: src.sessions,
    renamedTabs: src.renamedTabs,
    panes: src.panes.map((p) => {
      const { pid: _pid, cpu: _cpu, ...pane } = p.pane
      return { pane, exited: p.pane.state === 'exited', scrollback: packed.get(p.pane.id)!.toString('base64') }
    }),
  }
  return JSON.stringify(body)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const int = (v: unknown, d: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : d)

/** Parses the file's text; undefined when it is not a state this build can read (a newer version, or damage). */
export async function decodeState(text: string): Promise<SavedState | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObj(raw) || raw.version !== STATE_VERSION || !Array.isArray(raw.sessions) || !Array.isArray(raw.panes)) return undefined
  const panes: SavedPane[] = []
  for (const p of raw.panes) {
    if (!isObj(p) || !isObj(p.pane) || typeof p.pane.id !== 'string' || typeof p.pane.kind !== 'string') continue
    let scrollback = Buffer.alloc(0)
    try {
      if (typeof p.scrollback === 'string' && p.scrollback !== '') scrollback = await inflate(Buffer.from(p.scrollback, 'base64'))
    } catch {
      // damaged output: the pane still comes back, over an empty screen
    }
    const meta = p.pane as unknown as Pane
    panes.push({
      pane: { ...meta, title: typeof meta.title === 'string' ? meta.title : '', cwd: typeof meta.cwd === 'string' ? meta.cwd : '', cols: int(meta.cols, 80) || 80, rows: int(meta.rows, 24) || 24 },
      exited: p.exited === true,
      scrollback,
    })
  }
  return {
    version: STATE_VERSION,
    savedAt: int(raw.savedAt, 0),
    nextPane: int(raw.nextPane, 0),
    nextTab: int(raw.nextTab, 0),
    nextSession: int(raw.nextSession, 0),
    activeSession: typeof raw.activeSession === 'string' ? raw.activeSession : '',
    sessions: raw.sessions as Session[],
    renamedTabs: Array.isArray(raw.renamedTabs) ? raw.renamedTabs.filter((t): t is string => typeof t === 'string') : [],
    panes,
  }
}

/** Reads the file; one that cannot be read is moved aside (not deleted) so the next write does not destroy evidence. */
export async function loadState(file: string): Promise<SavedState | undefined> {
  let text: string
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch {
    return undefined
  }
  const state = await decodeState(text)
  if (state === undefined) await fs.promises.rename(file, `${file}.bad`).catch(() => {})
  return state
}

let seq = 0
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${seq++}.tmp`
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(tmp, text)
  try {
    await fs.promises.rename(tmp, file)
  } catch {
    // Windows refuses a rename onto a file a scanner has open: one more try, then give up on this write (the next one retries).
    await sleep(50)
    try {
      await fs.promises.rename(tmp, file)
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }
}

export interface WriterOptions {
  /** After a layout change (a tab opened, a pane split): soon, so a crash right after loses nothing visible. */
  layoutMs?: number
  /** After output alone: rarely, so a busy pane does not rewrite megabytes every second. */
  dataMs?: number
  onError?: (e: unknown) => void
}

/** Debounced, serialized, atomic writes of `daemon.state`. */
export class StateWriter {
  private timer: NodeJS.Timeout | undefined
  private due = Number.POSITIVE_INFINITY
  private chain: Promise<void> = Promise.resolve()
  private dirty = false
  private readonly cache = new ScrollbackCache()
  private readonly layoutMs: number
  private readonly dataMs: number

  constructor(
    private readonly file: string,
    private readonly collect: () => LayoutSource,
    private readonly opts: WriterOptions = {},
  ) {
    this.layoutMs = opts.layoutMs ?? 400
    this.dataMs = opts.dataMs ?? 5000
  }

  touch(kind: 'layout' | 'data'): void {
    this.dirty = true
    const at = Date.now() + (kind === 'layout' ? this.layoutMs : this.dataMs)
    if (at >= this.due) return
    this.due = at
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), Math.max(0, at - Date.now()))
    this.timer.unref()
  }

  /** Writes now (after the write in flight), if anything changed. Resolves when the file is on disk. */
  flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    this.due = Number.POSITIVE_INFINITY
    this.chain = this.chain.then(async () => {
      if (!this.dirty) return
      this.dirty = false
      try {
        await writeAtomic(this.file, await encodeState(this.collect(), this.cache))
      } catch (e) {
        this.dirty = true
        this.opts.onError?.(e)
      }
    })
    return this.chain
  }
}
