import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import type { Frame } from '../net/wire.js'

// Live shared blocks inside a chat. The host of a share numbers and relays every operation (a star: guests only talk to the host),
// so all participants apply the same sequence. What an operation, snapshot or cursor *means* belongs to the block's own adapter
// in the renderer; here they are opaque JSON texts with size caps and per-peer rate limits.

type ShareFrame = Extract<Frame, { t: 'share' }>

export type ShareMode = 'live' | 'readonly' | 'snapshot'

/** Blocks that may be shared into a chat. `agent` sessions use the engine's shared-agent code instead. */
export const SHARE_BLOCKS: readonly string[] = ['canvas', 'board', 'notebook', 'files', 'tasks', 'git', 'screen']
export const MAX_OP_BYTES = 65_536
export const MAX_SNAPSHOT_BYTES = 180_000
export const MAX_PRESENCE_BYTES = 1024
const MAX_RECORDS = 200
const ENDED_KEEP_MS = 14 * 86_400_000
const MAX_LIVE_HOSTED = 8
const SAVE_MS = 500
/** Steady rate and burst per peer: operations, then cursors. */
const OP_RATE = { perSec: 60, burst: 120 }
const PRESENCE_RATE = { perSec: 20, burst: 40 }

export interface ShareRecord {
  id: string
  conv: string
  block: string
  title: string
  mode: ShareMode
  args?: string
  host: string
  mine: boolean
  state: 'live' | 'ended'
  startedAt: number
  endedAt?: number
  /** I take part (the host always does). */
  joined: boolean
  /** Host side: who joined; guest side: what the host last told. Includes the host. */
  members: string[]
  /** The newest operation number the host assigned that I know. */
  ver: number
}

export interface ShareView {
  shareId: string
  chatId: string
  block: string
  title: string
  hostPk: string
  hostName: string
  mine: boolean
  mode: ShareMode
  state: 'live' | 'ended'
  joined: boolean
  hostOnline: boolean
  members: { pk: string; name: string; me: boolean; hue: number; active: boolean }[]
  startedAt: number
  endedAt?: number
  args?: string
  /** Agent sessions: which agent is busiest, and whether one asks a question. */
  agent?: { name: string; state: 'idle' | 'working' | 'asking'; summary?: string }
  asking?: boolean
  /** The chat that shows the live thing (`shared:<pk>` for a joined agent session, `agents` for mine). */
  openChatId?: string
}

export type ShareEventKind = 'offered' | 'joined' | 'left' | 'ended' | 'presence'

interface Peer {
  send(frame: Frame): boolean
  hello: { caps: readonly string[] }
}

export interface ShareDeps {
  me: string
  link(pk: string): Peer | undefined
  /** The people in `conv` other than me that a share may be offered to. */
  others(conv: string): string[]
  /** May `pk` take part in `conv` (an accepted contact in that DM, a current member of that group)? */
  entitled(pk: string, conv: string): boolean
  nameOf(pk: string): string
  /** Where the records are kept between runs. */
  file?: string
  now?: () => number
}

interface Live {
  rec: ShareRecord
  /** The newest snapshot of the block (host: provided by its window; guest: received). */
  snapshot?: { d: string; ver: number }
}

class Bucket {
  private tokens: number
  private at: number

  constructor(
    private readonly rate: { perSec: number; burst: number },
    now: number,
  ) {
    this.tokens = rate.burst
    this.at = now
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.rate.burst, this.tokens + ((now - this.at) / 1000) * this.rate.perSec)
    this.at = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

const hueOf = (pk: string): number => Number.parseInt(pk.slice(0, 6), 16) % 360

/**
 * Events: 'event' ({kind, record}), 'snapshot' ({id, d, ver, from}), 'op' ({id, from, d, ver}),
 * 'presence' ({id, from, d}), 'joinRequest' ({id, pk}: a guest wants the current state of a block I host).
 */
export class BlockShares extends EventEmitter {
  private readonly shares = new Map<string, Live>()
  private readonly buckets = new Map<string, Bucket>()
  private saveTimer: NodeJS.Timeout | undefined
  private readonly now: () => number
  /** Operations and cursors refused by a cap or rate limit, per peer: a test and `chats.share.list` can see abuse. */
  readonly dropped = new Map<string, number>()

  constructor(private readonly d: ShareDeps) {
    super()
    this.now = d.now ?? Date.now
    this.load()
  }

  // ---- queries -----------------------------------------------------------------------------------------------------

  records(conv?: string): ShareRecord[] {
    return [...this.shares.values()].map((s) => s.rec).filter((r) => conv === undefined || r.conv === conv)
  }

  get(id: string): ShareRecord | undefined {
    return this.shares.get(id)?.rec
  }

  snapshotOf(id: string): { d: string; ver: number } | undefined {
    return this.shares.get(id)?.snapshot
  }

  view(rec: ShareRecord): ShareView {
    const online = (pk: string): boolean => pk === this.d.me || this.d.link(pk) !== undefined
    const members = [...new Set([rec.host, ...rec.members])].map((pk) => ({ pk, name: this.d.nameOf(pk), me: pk === this.d.me, hue: hueOf(pk), active: rec.state === 'live' && online(pk) }))
    return {
      shareId: rec.id,
      chatId: rec.conv,
      block: rec.block,
      title: rec.title,
      hostPk: rec.host,
      hostName: this.d.nameOf(rec.host),
      mine: rec.mine,
      mode: rec.mode,
      state: rec.state,
      joined: rec.joined,
      hostOnline: online(rec.host),
      members: rec.state === 'live' ? members : members.map((m) => ({ ...m, active: false })),
      startedAt: rec.startedAt,
      ...(rec.endedAt === undefined ? {} : { endedAt: rec.endedAt }),
      ...(rec.args === undefined ? {} : { args: rec.args }),
    }
  }

  // ---- my side -----------------------------------------------------------------------------------------------------

  /** Offers a block to a conversation. `snapshot` is its current state (required for `snapshot` mode: it travels inside the offer). */
  start(o: { conv: string; block: string; title: string; mode: ShareMode; args?: string; snapshot?: string }): ShareRecord {
    if (!SHARE_BLOCKS.includes(o.block)) throw new Error(`cannot share a ${o.block} block`)
    if (o.mode === 'snapshot' && (o.snapshot === undefined || o.snapshot === '')) throw new Error('a snapshot share needs the block snapshot')
    if (o.snapshot !== undefined && Buffer.byteLength(o.snapshot) > MAX_SNAPSHOT_BYTES) throw new Error(`the snapshot is too big to share (max ${MAX_SNAPSHOT_BYTES} bytes)`)
    if (o.args !== undefined && o.args.length > 2000) throw new Error('args too long')
    if ([...this.shares.values()].filter((s) => s.rec.mine && s.rec.state === 'live').length >= MAX_LIVE_HOSTED) throw new Error(`at most ${MAX_LIVE_HOSTED} shares at once: end one first`)
    const rec: ShareRecord = {
      id: randomBytes(8).toString('hex'),
      conv: o.conv,
      block: o.block,
      title: o.title,
      mode: o.mode,
      host: this.d.me,
      mine: true,
      state: 'live',
      startedAt: this.now(),
      joined: true,
      members: [this.d.me],
      ver: 0,
      ...(o.args === undefined ? {} : { args: o.args }),
    }
    const live: Live = { rec, ...(o.snapshot === undefined ? {} : { snapshot: { d: o.snapshot, ver: 0 } }) }
    this.shares.set(rec.id, live)
    this.offerTo(live, this.d.others(o.conv))
    this.changed('offered', rec)
    return rec
  }

  /** The host's window provides the block's state: cached for guests that join later. */
  setSnapshot(id: string, d: string, ver?: number): void {
    const s = this.mineLive(id)
    if (Buffer.byteLength(d) > MAX_SNAPSHOT_BYTES) throw new Error(`the snapshot is too big (max ${MAX_SNAPSHOT_BYTES} bytes)`)
    s.snapshot = { d, ver: ver ?? s.rec.ver }
  }

  /** The host's window answers a join request with the block's state right now. */
  sendSnapshot(id: string, to: string, d: string, ver?: number): void {
    const s = this.mineLive(id)
    if (!s.rec.members.includes(to)) throw new Error('that person has not joined')
    this.setSnapshot(id, d, ver)
    this.send(to, { t: 'share', k: 'snap', id, conv: s.rec.conv, ver: s.snapshot!.ver, d })
  }

  join(id: string): ShareRecord {
    const s = this.shares.get(id)
    if (s === undefined || s.rec.state !== 'live') throw new Error('that share is over')
    if (s.rec.mine) return s.rec
    if (s.rec.mode === 'snapshot') {
      s.rec.joined = true
      this.changed('joined', s.rec)
      return s.rec
    }
    if (this.d.link(s.rec.host) === undefined) throw new Error(`${this.d.nameOf(s.rec.host)} is offline`)
    s.rec.joined = true
    this.send(s.rec.host, { t: 'share', k: 'join', id, conv: s.rec.conv })
    this.changed('joined', s.rec)
    return s.rec
  }

  /** A guest leaves; the host ends the share. */
  leave(id: string): ShareRecord {
    const s = this.shares.get(id)
    if (s === undefined) throw new Error('no such share')
    if (s.rec.mine) return this.end(id)
    if (!s.rec.joined) return s.rec
    s.rec.joined = false
    s.rec.members = s.rec.members.filter((pk) => pk !== this.d.me)
    this.send(s.rec.host, { t: 'share', k: 'leave', id, conv: s.rec.conv })
    this.changed('left', s.rec)
    return s.rec
  }

  end(id: string): ShareRecord {
    const s = this.mineLive(id)
    for (const pk of new Set([...s.rec.members, ...this.d.others(s.rec.conv)])) if (pk !== this.d.me) this.send(pk, { t: 'share', k: 'end', id, conv: s.rec.conv })
    this.finish(s, 'ended')
    return s.rec
  }

  /** One block operation. A guest sends it to the host; the host numbers it and relays it to everyone else. Returns its number (host) or 0. */
  op(id: string, d: string): number {
    const s = this.active(id)
    if (s.rec.mode === 'snapshot') throw new Error('this share is a snapshot')
    if (s.rec.mode === 'readonly' && !s.rec.mine) throw new Error('this share is read-only for guests')
    if (Buffer.byteLength(d) > MAX_OP_BYTES) throw new Error(`operation too big (max ${MAX_OP_BYTES} bytes)`)
    if (!this.allow(this.d.me, 'op', OP_RATE)) throw new Error('too many operations: slow down')
    if (!s.rec.mine) {
      this.send(s.rec.host, { t: 'share', k: 'op', id, conv: s.rec.conv, d })
      return 0
    }
    const ver = ++s.rec.ver
    this.relay(s, { t: 'share', k: 'op', id, conv: s.rec.conv, from: this.d.me, ver, d }, this.d.me)
    return ver
  }

  /** A cursor or selection: relayed, never stored, and dropped when it comes too fast. Silently ignored beyond the rate. */
  presence(id: string, d: string): void {
    const s = this.active(id)
    if (Buffer.byteLength(d) > MAX_PRESENCE_BYTES) throw new Error(`presence too big (max ${MAX_PRESENCE_BYTES} bytes)`)
    if (!this.allow(this.d.me, 'presence', PRESENCE_RATE)) return
    if (!s.rec.mine) return void this.send(s.rec.host, { t: 'share', k: 'presence', id, conv: s.rec.conv, d })
    this.relay(s, { t: 'share', k: 'presence', id, conv: s.rec.conv, from: this.d.me, d }, this.d.me)
  }

  // ---- the network's side ------------------------------------------------------------------------------------------

  /** A link opened: re-offer what I host there, and re-join what I joined at that host (their state may have moved on). */
  onOpen(pk: string): void {
    for (const s of this.shares.values()) {
      if (s.rec.state !== 'live') continue
      if (s.rec.mine && this.d.others(s.rec.conv).includes(pk)) this.offerTo(s, [pk])
      else if (!s.rec.mine && s.rec.host === pk && s.rec.joined && s.rec.mode !== 'snapshot') this.send(pk, { t: 'share', k: 'join', id: s.rec.id, conv: s.rec.conv })
      else continue
      this.changed('presence', s.rec)
    }
  }

  onClose(pk: string): void {
    for (const s of this.shares.values()) {
      if (s.rec.state !== 'live') continue
      if (s.rec.mine && s.rec.members.includes(pk)) {
        s.rec.members = s.rec.members.filter((m) => m !== pk)
        this.broadcastMembers(s)
        this.changed('left', s.rec)
      } else if (!s.rec.mine && s.rec.host === pk) this.changed('presence', s.rec)
    }
  }

  onFrame(pk: string, f: ShareFrame): void {
    if (f.k === 'offer') return this.onOffer(pk, f)
    const s = this.shares.get(f.id)
    if (s === undefined || s.rec.state !== 'live') return
    if (s.rec.mine) return this.onGuest(s, pk, f)
    if (pk !== s.rec.host) return // only the host speaks for a share
    switch (f.k) {
      case 'end':
        return this.finish(s, 'ended')
      case 'snap':
        if (f.d === undefined || Buffer.byteLength(f.d) > MAX_SNAPSHOT_BYTES || !s.rec.joined) return
        s.snapshot = { d: f.d, ver: f.ver ?? 0 }
        s.rec.ver = Math.max(s.rec.ver, f.ver ?? 0)
        this.emit('snapshot', { id: s.rec.id, d: f.d, ver: s.snapshot.ver, from: pk })
        return
      case 'op':
        if (f.d === undefined || f.from === undefined || !s.rec.joined || Buffer.byteLength(f.d) > MAX_OP_BYTES) return
        s.rec.ver = Math.max(s.rec.ver, f.ver ?? 0)
        this.emit('op', { id: s.rec.id, from: f.from, d: f.d, ver: f.ver ?? 0 })
        return
      case 'presence':
        if (f.d === undefined || f.from === undefined || !s.rec.joined || Buffer.byteLength(f.d) > MAX_PRESENCE_BYTES) return
        this.emit('presence', { id: s.rec.id, from: f.from, d: f.d })
        return
      case 'members': {
        const list = parseMembers(f.d)
        if (list === undefined) return
        s.rec.members = list.includes(s.rec.host) ? list : [s.rec.host, ...list]
        this.changed('presence', s.rec)
        return
      }
      default:
    }
  }

  close(): void {
    clearTimeout(this.saveTimer)
    this.save()
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  private onOffer(pk: string, f: ShareFrame): void {
    if (f.conv === undefined || f.block === undefined || f.title === undefined || f.mode === undefined || pk === this.d.me) return
    if (!this.d.entitled(pk, f.conv) || !SHARE_BLOCKS.includes(f.block)) return
    if (f.d !== undefined && Buffer.byteLength(f.d) > MAX_SNAPSHOT_BYTES) return
    const known = this.shares.get(f.id)
    if (known !== undefined) {
      // A re-offer (the host reconnected): only the host may repeat it, and it never revives an ended share.
      if (known.rec.host !== pk || known.rec.state !== 'live') return
      if (known.rec.joined && known.rec.mode !== 'snapshot') this.send(pk, { t: 'share', k: 'join', id: f.id, conv: f.conv })
      this.changed('presence', known.rec)
      return
    }
    if ([...this.shares.values()].filter((s) => s.rec.host === pk && s.rec.state === 'live').length >= MAX_LIVE_HOSTED) return
    const rec: ShareRecord = {
      id: f.id,
      conv: f.conv,
      block: f.block,
      title: f.title,
      mode: f.mode,
      host: pk,
      mine: false,
      state: 'live',
      startedAt: this.now(),
      joined: false,
      members: [pk],
      ver: f.ver ?? 0,
      ...(f.args === undefined ? {} : { args: f.args }),
    }
    this.shares.set(rec.id, { rec, ...(f.d === undefined ? {} : { snapshot: { d: f.d, ver: f.ver ?? 0 } }) })
    this.changed('offered', rec)
  }

  /** Host side: a guest asks to join, leaves, sends an operation or a cursor. */
  private onGuest(s: Live, pk: string, f: ShareFrame): void {
    const { rec } = s
    if (!this.d.entitled(pk, rec.conv)) return
    switch (f.k) {
      case 'join': {
        if (rec.mode === 'snapshot') return
        if (!rec.members.includes(pk)) rec.members.push(pk)
        this.broadcastMembers(s)
        if (s.snapshot !== undefined) this.send(pk, { t: 'share', k: 'snap', id: rec.id, conv: rec.conv, ver: s.snapshot.ver, d: s.snapshot.d })
        this.emit('joinRequest', { id: rec.id, pk })
        this.changed('joined', rec)
        return
      }
      case 'leave':
        if (!rec.members.includes(pk)) return
        rec.members = rec.members.filter((m) => m !== pk)
        this.broadcastMembers(s)
        this.changed('left', rec)
        return
      case 'op': {
        if (rec.mode !== 'live' || !rec.members.includes(pk) || f.d === undefined) return
        if (Buffer.byteLength(f.d) > MAX_OP_BYTES || !this.allow(pk, 'op', OP_RATE)) return void this.drop(pk)
        const ver = ++rec.ver
        this.relay(s, { t: 'share', k: 'op', id: rec.id, conv: rec.conv, from: pk, ver, d: f.d }, pk)
        this.emit('op', { id: rec.id, from: pk, d: f.d, ver })
        return
      }
      case 'presence': {
        if (!rec.members.includes(pk) || f.d === undefined || Buffer.byteLength(f.d) > MAX_PRESENCE_BYTES) return
        if (!this.allow(pk, 'presence', PRESENCE_RATE)) return
        this.relay(s, { t: 'share', k: 'presence', id: rec.id, conv: rec.conv, from: pk, d: f.d }, pk)
        this.emit('presence', { id: rec.id, from: pk, d: f.d })
        return
      }
      default:
    }
  }

  private offerTo(s: Live, to: string[]): void {
    const { rec } = s
    for (const pk of to) {
      this.send(pk, { t: 'share', k: 'offer', id: rec.id, conv: rec.conv, block: rec.block, title: rec.title, mode: rec.mode, ver: rec.ver, ...(rec.args === undefined ? {} : { args: rec.args }), ...(rec.mode === 'snapshot' && s.snapshot !== undefined ? { d: s.snapshot.d } : {}) })
    }
  }

  private broadcastMembers(s: Live): void {
    const d = JSON.stringify(s.rec.members)
    for (const pk of s.rec.members) if (pk !== this.d.me) this.send(pk, { t: 'share', k: 'members', id: s.rec.id, conv: s.rec.conv, d })
  }

  /** To every member except the host itself and `except` (the sender). */
  private relay(s: Live, frame: ShareFrame, except: string): void {
    for (const pk of s.rec.members) if (pk !== this.d.me && pk !== except) this.send(pk, frame)
  }

  private send(pk: string, frame: ShareFrame): void {
    const link = this.d.link(pk)
    if (link === undefined || !link.hello.caps.includes('share')) return
    link.send(frame)
  }

  private finish(s: Live, kind: 'ended'): void {
    s.rec.state = 'ended'
    s.rec.endedAt = this.now()
    s.rec.joined = false
    this.changed(kind, s.rec)
  }

  private mineLive(id: string): Live {
    const s = this.shares.get(id)
    if (s === undefined || !s.rec.mine) throw new Error('you do not host that share')
    if (s.rec.state !== 'live') throw new Error('that share is over')
    return s
  }

  private active(id: string): Live {
    const s = this.shares.get(id)
    if (s === undefined || s.rec.state !== 'live') throw new Error('that share is over')
    if (!s.rec.joined) throw new Error('join the share first')
    return s
  }

  private allow(pk: string, kind: 'op' | 'presence', rate: { perSec: number; burst: number }): boolean {
    const key = `${pk}:${kind}`
    let b = this.buckets.get(key)
    if (b === undefined) {
      b = new Bucket(rate, this.now())
      this.buckets.set(key, b)
    }
    return b.take(this.now())
  }

  private drop(pk: string): void {
    this.dropped.set(pk, (this.dropped.get(pk) ?? 0) + 1)
  }

  private changed(kind: ShareEventKind, rec: ShareRecord): void {
    this.emit('event', { kind, record: rec })
    this.scheduleSave()
  }

  // ---- persistence: what the timeline shows survives a restart (a share never does) ---------------------------------

  private scheduleSave(): void {
    if (this.d.file === undefined || this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.save()
    }, SAVE_MS)
    this.saveTimer.unref()
  }

  private save(): void {
    const file = this.d.file
    if (file === undefined) return
    const recs = this.records().sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECORDS)
    try {
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(recs))
      fs.renameSync(tmp, file)
    } catch {
      // the timeline loses its share cards after a restart; sharing itself is unaffected
    }
  }

  private load(): void {
    if (this.d.file === undefined) return
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(this.d.file, 'utf8'))
    } catch {
      return
    }
    if (!Array.isArray(raw)) return
    const now = this.now()
    for (const r of raw as Partial<ShareRecord>[]) {
      if (typeof r?.id !== 'string' || typeof r.conv !== 'string' || typeof r.block !== 'string' || typeof r.host !== 'string' || typeof r.startedAt !== 'number') continue
      const endedAt = r.state === 'ended' ? (r.endedAt ?? now) : now
      if (now - endedAt > ENDED_KEEP_MS) continue
      this.shares.set(r.id, {
        rec: {
          id: r.id,
          conv: r.conv,
          block: r.block,
          title: typeof r.title === 'string' ? r.title : r.block,
          mode: r.mode === 'readonly' || r.mode === 'snapshot' ? r.mode : 'live',
          host: r.host,
          mine: r.mine === true,
          // A share does not outlive the run that hosted it or joined it.
          state: 'ended',
          startedAt: r.startedAt,
          endedAt,
          joined: false,
          members: [r.host],
          ver: 0,
          ...(typeof r.args === 'string' ? { args: r.args } : {}),
        },
      })
    }
  }
}

function parseMembers(d: string | undefined): string[] | undefined {
  if (d === undefined) return undefined
  try {
    const v = JSON.parse(d) as unknown
    if (!Array.isArray(v) || v.length > 64 || !v.every((x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x))) return undefined
    return v as string[]
  } catch {
    return undefined
  }
}
