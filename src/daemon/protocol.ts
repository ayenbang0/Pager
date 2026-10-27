import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Settings } from './settings.js'

/** Bumped when a message changes shape. A newer peer's unknown message types and fields are ignored, never fatal. */
export const PROTOCOL_VERSION = 1

// Frame: u32 LE length (type byte + payload) | u8 type | payload.
export const FRAME_JSON = 0
export const FRAME_DATA = 1
/** A frame above this is a bug or an attack: the connection is closed. */
export const MAX_FRAME = 64 * 1024 * 1024

export type PaneKind = 'pager' | 'shell' | 'omp' | 'claude' | 'opencode' | 'hermes' | 'custom' | `block:${string}`
export type PaneState = 'running' | 'exited' | 'restored'

export interface Pane {
  /** Decimal digits: the id is also the u32 in pane data frames. */
  id: string
  kind: PaneKind
  title: string
  cwd: string
  command?: string
  cols: number
  rows: number
  state: PaneState
  exitCode?: number
  cpu?: number
  pid?: number
}

export type Node = { type: 'pane'; paneId: string } | { type: 'split'; dir: 'row' | 'col'; ratio: number; a: Node; b: Node }
export interface Tab {
  id: string
  title: string
  root: Node
  focus: string
}
export interface Session {
  id: string
  name: string
  tabs: Tab[]
  activeTab: string
}
export interface DaemonState {
  sessions: Session[]
  panes: Pane[]
  activeSession: string
  /** Attached windows (connections that said hello as `window`). */
  clients: number
  settings: Settings
}

export interface Request {
  /** The envelope's call id; a request whose own arguments carry a string `id` uses it in this slot too (the client keeps both by folding them together). */
  id: number | string
  type: string
  [key: string]: unknown
}
export type Reply = { id: number | string; ok: true; result?: unknown } | { id: number | string; ok: false; error: string }
export interface DaemonEvent {
  event: string
  [key: string]: unknown
}

/** Names `pager events --filter` and `events.subscribe{filter}` accept. */
export const EVENT_NAMES = [
  'state',
  'layout_changed',
  'pane_spawned',
  'pane_exited',
  'pane_closed',
  'pane_resized',
  'pane_title',
  'pane_cwd',
  'pane_resync',
  'command_finished',
  'bell',
  'toast',
  'open_url',
  'open_path',
  'client_attached',
  'client_detached',
  'chats_changed',
  'chat_message',
  'chat_typing',
  'chat_presence',
  'chat_call',
  'chat_request',
  'chat_toast',
  'chat_status',
  'chat_share',
  'chat_share_op',
] as const

export type Frame = { kind: 'json'; json: unknown } | { kind: 'data'; paneId: number; data: Buffer } | { kind: 'other'; type: number; payload: Buffer }

export function encodeJson(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const out = Buffer.allocUnsafe(5 + body.length)
  out.writeUInt32LE(body.length + 1, 0)
  out[4] = FRAME_JSON
  body.copy(out, 5)
  return out
}

export function encodeData(paneId: number, data: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(9 + data.length)
  out.writeUInt32LE(data.length + 5, 0)
  out[4] = FRAME_DATA
  out.writeUInt32LE(paneId, 5)
  out.set(data, 9)
  return out
}

/** Incremental decoder: feed socket chunks, get whole frames. Unknown types come back as raw frames for the caller to ignore. */
export class FrameDecoder {
  private chunks: Buffer[] = []
  private have = 0

  push(chunk: Buffer): Frame[] {
    this.chunks.push(chunk)
    this.have += chunk.length
    const out: Frame[] = []
    for (;;) {
      if (this.have < 4) break
      const head = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks)
      if (this.chunks.length > 1) this.chunks = [head]
      const len = head.readUInt32LE(0)
      if (len < 1 || len > MAX_FRAME) throw new Error(`bad frame length ${len}`)
      if (this.have < 4 + len) break
      const type = head[4]!
      const payload = head.subarray(5, 4 + len)
      const rest = head.subarray(4 + len)
      this.chunks = rest.length > 0 ? [rest] : []
      this.have = rest.length
      if (type === FRAME_JSON) {
        let json: unknown
        try {
          json = JSON.parse(payload.toString('utf8'))
        } catch {
          continue // a corrupt JSON message is skipped like an unknown one
        }
        out.push({ kind: 'json', json })
      } else if (type === FRAME_DATA) {
        if (payload.length < 4) continue
        out.push({ kind: 'data', paneId: payload.readUInt32LE(0), data: payload.subarray(4) })
      } else out.push({ kind: 'other', type, payload })
    }
    return out
  }
}

const hash8 = (s: string): string => createHash('sha256').update(path.resolve(s).toLowerCase()).digest('hex').slice(0, 8)

/**
 * The daemon's endpoint. `PAGER_DAEMON_SOCKET` wins. Windows: `\\.\pipe\pager-<USERNAME>`, with a hash of the data dir
 * added when PAGER_HOME is set (a test or second profile must not reach the user's own daemon). Elsewhere: a socket in the data dir.
 */
export function daemonAddress(dir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const given = env.PAGER_DAEMON_SOCKET?.trim()
  if (given) return given
  if (platform === 'win32') {
    const user = (env.USERNAME ?? os.userInfo().username).replace(/[^\w.-]/g, '_')
    return `\\\\.\\pipe\\pager-${user}${env.PAGER_HOME ? `-${hash8(dir)}` : ''}`
  }
  return path.join(dir, 'daemon.sock')
}

/** The pipe that panes use to ask the attached window to show a URL; it lives as long as the daemon. */
export function hostAddress(daemon: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${daemon}-host` : daemon.replace(/\.sock$/, '') + '-host.sock'
}

export function isPaneNode(n: Node): n is { type: 'pane'; paneId: string } {
  return n.type === 'pane'
}
