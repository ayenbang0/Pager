import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { DOC_PREFIX } from '../docs/store.js'
import type { PagerEvent } from './events.js'
import { FieldCipher } from './cipher.js'
import { opOf } from './ops.js'

const SCHEMA_VERSION = 2

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
  recv_at INTEGER NOT NULL, op TEXT, PRIMARY KEY(conv, author, seq)) WITHOUT ROWID;
CREATE INDEX events_conv_ts ON events(conv, ts);
CREATE TABLE acks(conv TEXT NOT NULL, peer TEXT NOT NULL, author TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(conv, peer, author)) WITHOUT ROWID;
CREATE TABLE joined(conv TEXT NOT NULL, peer TEXT NOT NULL, PRIMARY KEY(conv, peer)) WITHOUT ROWID;
INSERT INTO meta(key, value) VALUES('schema_version', '2');
`

type Row = Record<string, unknown>

const PEER_COLUMNS: Record<string, string> = {
  name: 'name',
  state: 'state',
  note: 'note',
  requestSent: 'request_sent',
  acceptSent: 'accept_sent',
}

const evAad = (conv: string, author: string, seq: number): string => `ev:${conv}:${author}:${seq}`
const convAad = (id: string): string => `conv:${id}`
const peerNameAad = (pk: string): string => `peer.name:${pk}`
const peerNoteAad = (pk: string): string => `peer.note:${pk}`

export class Store {
  private db: DatabaseSync
  private readonly cipher: FieldCipher

  /** `dbKey` seals events.body, convs.title, peers.name and peers.note; without it those fields are plaintext (existing sealed values then refuse to read). */
  constructor(path: string, dbKey?: Buffer) {
    this.cipher = new FieldCipher(dbKey)
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL')
    if (dbKey !== undefined) this.db.exec('PRAGMA secure_delete=ON')
    const hasMeta = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()
    try {
      if (!hasMeta) this.db.exec(SCHEMA)
      else this.migrate()
    } catch (err) {
      this.db.close() // an open handle would keep the file locked on Windows
      throw err
    }
  }

  private migrate(): void {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    const version = Number(r?.value ?? 1)
    if (version > SCHEMA_VERSION) throw new Error('pager.db was written by a newer pager')
    if (version >= SCHEMA_VERSION) return
    this.db.exec('BEGIN')
    try {
      this.db.exec('ALTER TABLE events ADD COLUMN op TEXT')
      this.db.prepare('UPDATE events SET op = ? WHERE body LIKE ?').run('doc', `${DOC_PREFIX}%`)
      this.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private toPeer(r: Row): Peer {
    const pk = r.pk as string
    return {
      pk,
      name: this.cipher.unseal(r.name as string, peerNameAad(pk)),
      state: r.state as PeerState | null,
      note: this.cipher.unseal(r.note as string, peerNoteAad(pk)),
      requestSent: r.request_sent === 1,
      acceptSent: r.accept_sent === 1,
      createdAt: r.created_at as number,
    }
  }

  private toConv(r: Row): Conv {
    const id = r.id as string
    return {
      id,
      kind: r.kind as Conv['kind'],
      title: this.cipher.unseal(r.title as string, convAad(id)),
      creator: r.creator as string | null,
      peer: r.peer as string | null,
      state: r.state as Conv['state'],
      readAt: r.read_at as number,
      createdAt: r.created_at as number,
    }
  }

  private toEvent(r: Row): PagerEvent {
    const conv = r.conv as string
    const author = r.author as string
    const seq = r.seq as number
    return {
      conv,
      author,
      seq,
      ts: r.ts as number,
      kind: r.kind as PagerEvent['kind'],
      body: this.cipher.unseal(r.body as string, evAad(conv, author, seq)),
      sig: r.sig as string,
    }
  }

  close(): void {
    this.db.close()
  }

  getPeer(pk: string): Peer | undefined {
    const r = this.db.prepare('SELECT * FROM peers WHERE pk = ?').get(pk)
    return r ? this.toPeer(r) : undefined
  }

  listPeers(): Peer[] {
    return this.db.prepare('SELECT * FROM peers ORDER BY created_at, pk').all().map((r) => this.toPeer(r))
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
      if (key === 'name') values.push(this.cipher.seal(value as string, peerNameAad(pk)))
      else if (key === 'note') values.push(this.cipher.seal(value as string, peerNoteAad(pk)))
      else values.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as SQLInputValue))
    }
    if (sets.length === 0) return
    this.db.prepare(`UPDATE peers SET ${sets.join(', ')} WHERE pk = ?`).run(...values, pk)
  }

  deletePeer(pk: string): void {
    this.db.prepare('DELETE FROM peers WHERE pk = ?').run(pk)
  }

  getConv(id: string): Conv | undefined {
    const r = this.db.prepare('SELECT * FROM convs WHERE id = ?').get(id)
    return r ? this.toConv(r) : undefined
  }

  listConvs(): Conv[] {
    return this.db.prepare('SELECT * FROM convs ORDER BY created_at, id').all().map((r) => this.toConv(r))
  }

  upsertConv(c: Conv): void {
    this.db
      .prepare(
        `INSERT INTO convs(id, kind, title, creator, peer, state, read_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, creator=excluded.creator,
           peer=excluded.peer, state=excluded.state, read_at=excluded.read_at`,
      )
      .run(c.id, c.kind, this.cipher.seal(c.title, convAad(c.id)), c.creator, c.peer, c.state, c.readAt, c.createdAt)
  }

  markRead(id: string, at: number): void {
    this.db.prepare('UPDATE convs SET read_at = ? WHERE id = ?').run(at, id)
  }

  /** True if the event was new. */
  insertEvent(e: PagerEvent, recvAt: number): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO events(conv, author, seq, ts, kind, body, sig, recv_at, op) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.conv, e.author, e.seq, e.ts, e.kind, this.cipher.seal(e.body, evAad(e.conv, e.author, e.seq)), e.sig, recvAt, opOf(e.body))
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
      .map((r) => this.toEvent(r))
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
      .prepare("SELECT conv, author, seq, body FROM events WHERE kind = 'text' AND author = ? AND op IS NULL ORDER BY ts DESC, seq DESC LIMIT ?")
      .all(author, limit)
    return rows.reverse().map((r) => this.toEvent(r).body)
  }

  /** Text message totals for `me`, plus the (ts, conv, mine) of every text since `since` for activity charts. */
  textStats(me: string, since: number): { sent: number; received: number; recent: { ts: number; conv: string; mine: boolean }[] } {
    const totals = this.db
      .prepare(
        "SELECT COALESCE(SUM(author = ?), 0) AS sent, COALESCE(SUM(author <> ?), 0) AS received FROM events WHERE kind = 'text' AND op IS NULL",
      )
      .get(me, me)
    const rows = this.db.prepare("SELECT ts, conv, author FROM events WHERE kind = 'text' AND ts >= ? AND op IS NULL").all(since)
    return {
      sent: (totals?.sent as number) ?? 0,
      received: (totals?.received as number) ?? 0,
      recent: rows.map((r) => ({ ts: r.ts as number, conv: r.conv as string, mine: r.author === me })),
    }
  }

  /** The last `limit` rows ordered by (ts, author, seq) ascending. */
  listMessages(conv: string, limit: number): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE conv = ? AND (op IS NULL OR op = 'rename') ORDER BY ts DESC, author DESC, seq DESC LIMIT ?")
      .all(conv, limit)
    return rows.reverse().map((r) => ({ ...this.toEvent(r), recvAt: r.recv_at as number }))
  }

  /** Every document operation event, in the order they were written. */
  docEvents(): PagerEvent[] {
    return this.db.prepare("SELECT * FROM events WHERE op = 'doc' ORDER BY ts, author, seq").all().map((r) => this.toEvent(r))
  }

  /** Every reaction event of a conversation, ordered by (author, seq). */
  reactionEvents(conv: string): { author: string; seq: number; body: string }[] {
    return this.db
      .prepare("SELECT conv, author, seq, body FROM events WHERE conv = ? AND op = 'react' ORDER BY author, seq")
      .all(conv)
      .map((r) => ({ author: r.author as string, seq: r.seq as number, body: this.toEvent(r).body }))
  }

  getEvent(conv: string, author: string, seq: number): StoredEvent | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE conv = ? AND author = ? AND seq = ?').get(conv, author, seq)
    return r ? { ...this.toEvent(r), recvAt: r.recv_at as number } : undefined
  }

  /** The newest `limit` text messages (documents excluded) across all conversations, newest first; the search scan window. */
  recentTexts(limit: number): { conv: string; author: string; ts: number; body: string }[] {
    const rows = this.db
      .prepare("SELECT conv, author, seq, ts, body FROM events WHERE kind = 'text' AND op IS NULL ORDER BY ts DESC, author DESC, seq DESC LIMIT ?")
      .all(limit)
    return rows.map((r) => ({ conv: r.conv as string, author: r.author as string, ts: r.ts as number, body: this.toEvent(r).body }))
  }

  /** Per conversation, how many text messages from others arrived after `since` (receive time; documents excluded). */
  textCountsSince(me: string, since: number): Map<string, number> {
    const rows = this.db
      .prepare("SELECT conv, COUNT(*) AS n FROM events WHERE kind = 'text' AND author <> ? AND recv_at > ? AND op IS NULL GROUP BY conv")
      .all(me, since)
    return new Map(rows.map((r) => [r.conv as string, r.n as number]))
  }

  /** Text events from others received after the conv's read_at. */
  unreadCount(conv: string, me: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events e JOIN convs c ON c.id = e.conv
         WHERE e.conv = ? AND e.kind = 'text' AND e.author <> ? AND e.recv_at > c.read_at AND e.op IS NULL`,
      )
      .get(conv, me)
    return (r?.n as number) ?? 0
  }

  members(conv: string): { current: Set<string>; ever: Set<string> } {
    const c = this.getConv(conv)
    if (!c || c.kind !== 'group') throw new Error('members() requires a group conv')
    const ever = new Set<string>()
    if (c.creator) ever.add(c.creator)
    const left = new Set<string>()
    for (const r of this.db.prepare("SELECT conv, kind, author, seq, body FROM events WHERE conv = ? AND kind <> 'text'").all(conv)) {
      if (r.kind === 'member-add') ever.add(this.toEvent(r).body)
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

  /** Seals every plaintext field in one transaction; sealed fields are left alone, so an interrupted run can be repeated. */
  encryptAll(): void {
    if (!this.cipher.enabled) throw new Error('encryptAll needs a key')
    this.convert((plain, aad, stored) => (this.cipher.isSealed(stored) ? stored : this.cipher.seal(plain(), aad)))
  }

  /** Writes every field back as plaintext. */
  decryptAll(): void {
    this.convert((plain, _aad, stored) => (this.cipher.isSealed(stored) ? plain() : stored))
  }

  private convert(next: (plain: () => string, aad: string, stored: string) => string): void {
    this.db.exec('PRAGMA secure_delete=ON')
    this.db.exec('BEGIN')
    try {
      const fix = (table: string, keyCols: string[], col: string, aadOf: (r: Row) => string): void => {
        const where = keyCols.map((c) => `${c} = ?`).join(' AND ')
        const upd = this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${where}`)
        for (const r of this.db.prepare(`SELECT ${keyCols.join(', ')}, ${col} AS v FROM ${table}`).all()) {
          const stored = r.v as string
          const aad = aadOf(r)
          const out = next(() => this.cipher.unseal(stored, aad), aad, stored)
          if (out !== stored) upd.run(out, ...keyCols.map((c) => r[c] as SQLInputValue))
        }
      }
      fix('events', ['conv', 'author', 'seq'], 'body', (r) => evAad(r.conv as string, r.author as string, r.seq as number))
      fix('convs', ['id'], 'title', (r) => convAad(r.id as string))
      fix('peers', ['pk'], 'name', (r) => peerNameAad(r.pk as string))
      fix('peers', ['pk'], 'note', (r) => peerNoteAad(r.pk as string))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.exec('VACUUM')
  }
}
