import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { DOC_PREFIX } from './docs/store.js'
import type { PagerEvent } from './events.js'

/** LIKE pattern matching document-operation event bodies (see DOC_PREFIX). */
const DOC_LIKE = `${DOC_PREFIX}%`

export type PeerState = 'outgoing' | 'incoming' | 'accepted' | 'blocked'
export interface Peer {
  pk: string
  name: string
  state: PeerState | null
  note: string
  requestSent: boolean
  acceptSent: boolean
  createdAt: number
}
export interface Conv {
  id: string
  kind: 'dm' | 'group'
  title: string
  creator: string | null
  peer: string | null
  state: 'active' | 'invited' | 'left'
  readAt: number
  createdAt: number
}
export interface StoredEvent extends PagerEvent {
  recvAt: number
}

const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE peers(
  pk TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
  state TEXT CHECK(state IN ('outgoing','incoming','accepted','blocked')),
  note TEXT NOT NULL DEFAULT '', request_sent INTEGER NOT NULL DEFAULT 0, accept_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE TABLE convs(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('dm','group')), title TEXT NOT NULL DEFAULT '',
  creator TEXT, peer TEXT, state TEXT NOT NULL CHECK(state IN ('active','invited','left')),
  read_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE events(
  conv TEXT NOT NULL, author TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text','member-add','member-leave')), body TEXT NOT NULL, sig TEXT NOT NULL,
  recv_at INTEGER NOT NULL, PRIMARY KEY(conv, author, seq)) WITHOUT ROWID;
CREATE INDEX events_conv_ts ON events(conv, ts);
CREATE TABLE acks(conv TEXT NOT NULL, peer TEXT NOT NULL, author TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(conv, peer, author)) WITHOUT ROWID;
CREATE TABLE joined(conv TEXT NOT NULL, peer TEXT NOT NULL, PRIMARY KEY(conv, peer)) WITHOUT ROWID;
INSERT INTO meta(key, value) VALUES('schema_version', '1');
`

type Row = Record<string, unknown>

function toPeer(r: Row): Peer {
  return {
    pk: r.pk as string,
    name: r.name as string,
    state: r.state as PeerState | null,
    note: r.note as string,
    requestSent: r.request_sent === 1,
    acceptSent: r.accept_sent === 1,
    createdAt: r.created_at as number,
  }
}

function toConv(r: Row): Conv {
  return {
    id: r.id as string,
    kind: r.kind as Conv['kind'],
    title: r.title as string,
    creator: r.creator as string | null,
    peer: r.peer as string | null,
    state: r.state as Conv['state'],
    readAt: r.read_at as number,
    createdAt: r.created_at as number,
  }
}

function toEvent(r: Row): PagerEvent {
  return {
    conv: r.conv as string,
    author: r.author as string,
    seq: r.seq as number,
    ts: r.ts as number,
    kind: r.kind as PagerEvent['kind'],
    body: r.body as string,
    sig: r.sig as string,
  }
}

const PEER_COLUMNS: Record<string, string> = {
  name: 'name',
  state: 'state',
  note: 'note',
  requestSent: 'request_sent',
  acceptSent: 'accept_sent',
}

export class Store {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL')
    const hasMeta = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()
    if (!hasMeta) this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  getPeer(pk: string): Peer | undefined {
    const r = this.db.prepare('SELECT * FROM peers WHERE pk = ?').get(pk)
    return r ? toPeer(r) : undefined
  }

  listPeers(): Peer[] {
    return this.db.prepare('SELECT * FROM peers ORDER BY created_at, pk').all().map(toPeer)
  }

  /** Insert with defaults if missing, else update only the given fields. */
  upsertPeer(pk: string, patch: Partial<Omit<Peer, 'pk' | 'createdAt'>>, now: number): void {
    this.db.prepare('INSERT OR IGNORE INTO peers(pk, created_at) VALUES(?, ?)').run(pk, now)
    const sets: string[] = []
    const values: SQLInputValue[] = []
    for (const [key, value] of Object.entries(patch)) {
      const col = PEER_COLUMNS[key]
      if (col === undefined || value === undefined) continue
      sets.push(`${col} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as SQLInputValue))
    }
    if (sets.length === 0) return
    this.db.prepare(`UPDATE peers SET ${sets.join(', ')} WHERE pk = ?`).run(...values, pk)
  }

  deletePeer(pk: string): void {
    this.db.prepare('DELETE FROM peers WHERE pk = ?').run(pk)
  }

  getConv(id: string): Conv | undefined {
    const r = this.db.prepare('SELECT * FROM convs WHERE id = ?').get(id)
    return r ? toConv(r) : undefined
  }

  listConvs(): Conv[] {
    return this.db.prepare('SELECT * FROM convs ORDER BY created_at, id').all().map(toConv)
  }

  upsertConv(c: Conv): void {
    this.db
      .prepare(
        `INSERT INTO convs(id, kind, title, creator, peer, state, read_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, creator=excluded.creator,
           peer=excluded.peer, state=excluded.state, read_at=excluded.read_at`,
      )
      .run(c.id, c.kind, c.title, c.creator, c.peer, c.state, c.readAt, c.createdAt)
  }

  markRead(id: string, at: number): void {
    this.db.prepare('UPDATE convs SET read_at = ? WHERE id = ?').run(at, id)
  }

  /** True if the event was new. */
  insertEvent(e: PagerEvent, recvAt: number): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO events(conv, author, seq, ts, kind, body, sig, recv_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.conv, e.author, e.seq, e.ts, e.kind, e.body, e.sig, recvAt)
    return res.changes === 1
  }

  lastSeq(conv: string, author: string): number {
    const r = this.db.prepare('SELECT MAX(seq) AS m FROM events WHERE conv = ? AND author = ?').get(conv, author)
    return (r?.m as number | null) ?? 0
  }

  haveVector(conv: string): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.db.prepare('SELECT author, MAX(seq) AS m FROM events WHERE conv = ? GROUP BY author').all(conv)) {
      out[r.author as string] = r.m as number
    }
    return out
  }

  eventsAfter(conv: string, author: string, seq: number, limit: number): PagerEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE conv = ? AND author = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(conv, author, seq, limit)
      .map(toEvent)
  }

  authorsOf(conv: string): string[] {
    return this.db
      .prepare('SELECT DISTINCT author FROM events WHERE conv = ? ORDER BY author')
      .all(conv)
      .map((r) => r.author as string)
  }

  /** The bodies of the last `limit` text messages `author` sent, oldest first. */
  sentTexts(author: string, limit: number): string[] {
    const rows = this.db
      .prepare("SELECT body FROM events WHERE kind = 'text' AND author = ? AND body NOT LIKE ? ORDER BY ts DESC, seq DESC LIMIT ?")
      .all(author, DOC_LIKE, limit)
    return rows.reverse().map((r) => r.body as string)
  }

  /** Text message totals for `me`, plus the (ts, conv, mine) of every text since `since` for activity charts. */
  textStats(me: string, since: number): { sent: number; received: number; recent: { ts: number; conv: string; mine: boolean }[] } {
    const totals = this.db
      .prepare(
        "SELECT COALESCE(SUM(author = ?), 0) AS sent, COALESCE(SUM(author <> ?), 0) AS received FROM events WHERE kind = 'text' AND body NOT LIKE ?",
      )
      .get(me, me, DOC_LIKE)
    const rows = this.db.prepare("SELECT ts, conv, author FROM events WHERE kind = 'text' AND ts >= ? AND body NOT LIKE ?").all(since, DOC_LIKE)
    return {
      sent: (totals?.sent as number) ?? 0,
      received: (totals?.received as number) ?? 0,
      recent: rows.map((r) => ({ ts: r.ts as number, conv: r.conv as string, mine: r.author === me })),
    }
  }

  /** The last `limit` rows ordered by (ts, author, seq) ascending. */
  listMessages(conv: string, limit: number): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE conv = ? AND body NOT LIKE ? ORDER BY ts DESC, author DESC, seq DESC LIMIT ?')
      .all(conv, DOC_LIKE, limit)
    return rows.reverse().map((r) => ({ ...toEvent(r), recvAt: r.recv_at as number }))
  }

  /** Every document operation event, in the order they were written. */
  docEvents(): PagerEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE body LIKE ? ORDER BY ts, author, seq').all(DOC_LIKE).map(toEvent)
  }

  /** Text events from others received after the conv's read_at. */
  unreadCount(conv: string, me: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events e JOIN convs c ON c.id = e.conv
         WHERE e.conv = ? AND e.kind = 'text' AND e.author <> ? AND e.recv_at > c.read_at AND e.body NOT LIKE ?`,
      )
      .get(conv, me, DOC_LIKE)
    return (r?.n as number) ?? 0
  }

  members(conv: string): { current: Set<string>; ever: Set<string> } {
    const c = this.getConv(conv)
    if (!c || c.kind !== 'group') throw new Error('members() requires a group conv')
    const ever = new Set<string>()
    if (c.creator) ever.add(c.creator)
    const left = new Set<string>()
    for (const r of this.db.prepare("SELECT kind, author, body FROM events WHERE conv = ? AND kind <> 'text'").all(conv)) {
      if (r.kind === 'member-add') ever.add(r.body as string)
      else left.add(r.author as string)
    }
    const current = new Set([...ever].filter((pk) => !left.has(pk)))
    return { current, ever }
  }

  /** Keeps the max. */
  setAck(conv: string, peer: string, author: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO acks(conv, peer, author, seq) VALUES(?, ?, ?, ?)
         ON CONFLICT(conv, peer, author) DO UPDATE SET seq = MAX(seq, excluded.seq)`,
      )
      .run(conv, peer, author, seq)
  }

  getAck(conv: string, peer: string, author: string): number {
    const r = this.db.prepare('SELECT seq FROM acks WHERE conv = ? AND peer = ? AND author = ?').get(conv, peer, author)
    return (r?.seq as number | undefined) ?? 0
  }

  markJoined(conv: string, peer: string): void {
    this.db.prepare('INSERT OR IGNORE INTO joined(conv, peer) VALUES(?, ?)').run(conv, peer)
  }

  isJoined(conv: string, peer: string): boolean {
    return this.db.prepare('SELECT 1 FROM joined WHERE conv = ? AND peer = ?').get(conv, peer) !== undefined
  }
}
