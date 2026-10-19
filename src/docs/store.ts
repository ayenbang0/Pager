import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { isRecord } from '../util/guards.js'
import { TextCrdt, type Anchor, type Id, type Inverse, type InsertOp, type TextOp } from './crdt.js'

/**
 * Document operations travel inside ordinary signed chat events of kind `text`, so peers on older versions keep
 * syncing (they only see an unreadable line). The invisible-separator prefix marks them; every view of the chat
 * filters on it.
 */
export const DOC_PREFIX = '\u2063doc:'

const FLUSH_MS = 250
const BODY_LIMIT = 3600
const MAX_DOC_CHARS = 500_000
const MAX_OPS_PER_EVENT = 200
const MAX_NAME = 64
const RECENT_MS = 30_000

type DocOp = TextOp | { k: 'n'; n: string } | { k: 'x' }

export interface DocInfo {
  id: string
  conv: string
  name: string
  length: number
  /** Latest operation time from anyone, ms. */
  lastEdit: number
}

interface Doc {
  id: string
  conv: string
  name: string
  nameTs: number
  removed: boolean
  lastEdit: number
  crdt: TextCrdt
  /** Author pk -> time of their latest operation. */
  editors: Map<string, number>
  undo: Inverse[][]
  redo: Inverse[][]
  /** The undo group being built (one insert session or one normal-mode command). */
  open: Inverse[] | null
  outbox: TextOp[]
  timer: NodeJS.Timeout | undefined
}

const isId = (v: unknown): v is Id => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1])
const isRange = (v: unknown): v is [string, number, number] =>
  Array.isArray(v) && v.length === 3 && typeof v[0] === 'string' && Number.isInteger(v[1]) && Number.isInteger(v[2]) && (v[2] as number) > 0 && (v[2] as number) <= 100_000

function parseOp(v: unknown): DocOp | null {
  if (!isRecord(v)) return null
  if (v.k === 'i' && Number.isInteger(v.c) && (v.c as number) >= 1 && typeof v.s === 'string' && v.s.length > 0 && v.s.length <= 4000 && (v.p === null || isId(v.p))) {
    return { k: 'i', c: v.c as number, p: v.p, s: v.s }
  }
  if (v.k === 'd' && Array.isArray(v.r) && v.r.length <= 500 && v.r.every(isRange)) return { k: 'd', r: v.r as [string, number, number][] }
  if (v.k === 'n' && typeof v.n === 'string' && v.n.length >= 1 && v.n.length <= MAX_NAME) return { k: 'n', n: v.n }
  if (v.k === 'x') return { k: 'x' }
  return null
}

/** JSON with C1/DEL controls escaped: the wire rejects raw control characters in event bodies. */
function encode(d: string, ops: DocOp[]): string {
  return DOC_PREFIX + JSON.stringify({ d, ops }).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Normalise a user-typed document name: no spaces or path characters, `.md` when it has no extension. */
export function docName(raw: string): string {
  const base = raw.trim().replace(/[\s/\\:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME - 3)
  if (base === '') return ''
  return /\.[A-Za-z0-9]{1,5}$/.test(base) ? base : `${base}.md`
}

export class DocStore extends EventEmitter {
  private readonly docs = new Map<string, Doc>()
  private readonly short: string

  /** `publish` signs and sends one event body to a conversation. */
  constructor(
    private readonly me: string,
    private readonly publish: (conv: string, body: string) => void,
  ) {
    super()
    this.short = me.slice(0, 12)
  }

  // ------------------------------------------------------------ remote / replay

  /** Apply a stored or received event. Returns whether it was a document event. */
  applyEvent(ev: { conv: string; author: string; ts: number; body: string }): boolean {
    if (!ev.body.startsWith(DOC_PREFIX)) return false
    let parsed: unknown
    try {
      parsed = JSON.parse(ev.body.slice(DOC_PREFIX.length))
    } catch {
      return true
    }
    if (!isRecord(parsed) || typeof parsed.d !== 'string' || !/^[0-9a-f]{8}$/.test(parsed.d) || !Array.isArray(parsed.ops)) return true
    let doc = this.docs.get(parsed.d)
    if (doc && doc.conv !== ev.conv) return true
    doc ??= this.blank(parsed.d, ev.conv)
    const author = ev.author.slice(0, 12)
    for (const raw of parsed.ops.slice(0, MAX_OPS_PER_EVENT)) {
      const op = parseOp(raw)
      if (!op) continue
      if (op.k === 'n') {
        if (ev.ts >= doc.nameTs) {
          doc.name = op.n
          doc.nameTs = ev.ts
        }
      } else if (op.k === 'x') doc.removed = true
      else {
        doc.crdt.apply(author, op)
        doc.editors.set(ev.author, ev.ts)
        doc.lastEdit = Math.max(doc.lastEdit, ev.ts)
      }
    }
    this.emit('change')
    return true
  }

  // ------------------------------------------------------------ queries

  list(conv?: string): DocInfo[] {
    return [...this.docs.values()]
      .filter((d) => !d.removed && d.name !== '' && (conv === undefined || d.conv === conv))
      .map((d) => ({ id: d.id, conv: d.conv, name: d.name, length: d.crdt.length, lastEdit: d.lastEdit }))
      .sort((a, b) => b.lastEdit - a.lastEdit || a.name.localeCompare(b.name))
  }

  info(id: string): DocInfo | undefined {
    return this.list().find((d) => d.id === id)
  }

  text(id: string): string {
    return this.docs.get(id)?.crdt.text() ?? ''
  }

  /** An anchor for position `pos` of a document (see TextCrdt.anchorAt). */
  anchorAt(id: string, pos: number, after: boolean): Anchor {
    return this.docs.get(id)?.crdt.anchorAt(pos, after) ?? { id: null, after }
  }

  /** Where an anchor is now. */
  positionOf(id: string, anchor: Anchor): number {
    return this.docs.get(id)?.crdt.positionOf(anchor) ?? 0
  }

  /** Public keys of others who edited this document in the last 30 seconds. */
  activeEditors(id: string, now = Date.now()): string[] {
    const doc = this.docs.get(id)
    if (!doc) return []
    return [...doc.editors].filter(([pk, ts]) => pk !== this.me && now - ts <= RECENT_MS).map(([pk]) => pk)
  }

  /** Whether local edits are still waiting for the flush timer, i.e. not yet published to the other members. */
  unsent(id: string): boolean {
    return (this.docs.get(id)?.outbox.length ?? 0) > 0
  }

  /** Every document with this name (case-insensitive, `.md` optional); names are only unique within one conversation. */
  matches(name: string, conv?: string): DocInfo[] {
    const want = docName(name).toLowerCase()
    const bare = name.trim().toLowerCase()
    return this.list(conv).filter((d) => d.name.toLowerCase() === want || d.name.toLowerCase() === bare)
  }

  /** The document with this name, only when exactly one matches. */
  find(name: string, conv?: string): DocInfo | undefined {
    const all = this.matches(name, conv)
    return all.length === 1 ? all[0] : undefined
  }

  // ------------------------------------------------------------ local edits

  create(conv: string, rawName: string): DocInfo | string {
    const name = docName(rawName)
    if (name === '') return 'Document name cannot be empty'
    if (this.find(name, conv)) return `${name} already exists here`
    const id = randomBytes(4).toString('hex')
    const doc = this.blank(id, conv)
    doc.name = name
    doc.nameTs = Date.now()
    this.publish(conv, encode(id, [{ k: 'n', n: name }]))
    this.emit('change')
    return { id, conv, name, length: 0, lastEdit: 0 }
  }

  rename(id: string, rawName: string): string | null {
    const doc = this.docs.get(id)
    const name = docName(rawName)
    if (!doc || doc.removed) return 'No such document'
    if (name === '') return 'Document name cannot be empty'
    doc.name = name
    doc.nameTs = Date.now()
    this.publish(doc.conv, encode(id, [{ k: 'n', n: name }]))
    this.emit('change')
    return null
  }

  remove(id: string): void {
    const doc = this.docs.get(id)
    if (!doc || doc.removed) return
    this.flush(id)
    doc.removed = true
    this.publish(doc.conv, encode(id, [{ k: 'x' }]))
    this.emit('change')
  }

  insert(id: string, pos: number, s: string): boolean {
    const doc = this.docs.get(id)
    if (!doc || doc.removed || s === '' || doc.crdt.length + s.length > MAX_DOC_CHARS) return false
    const done = doc.crdt.insert(pos, s)
    if (!done) return false
    this.record(doc, done.op, done.inverse)
    return true
  }

  delete(id: string, pos: number, len: number): boolean {
    const doc = this.docs.get(id)
    const done = doc && !doc.removed ? doc.crdt.delete(pos, len) : null
    if (!doc || !done) return false
    this.record(doc, done.op, done.inverse)
    return true
  }

  /** Replace the whole text (used by agents): only the differing middle becomes operations, so concurrent edits elsewhere survive. */
  setText(id: string, next: string): boolean {
    const doc = this.docs.get(id)
    if (!doc || doc.removed) return false
    const prev = doc.crdt.text()
    let head = 0
    while (head < prev.length && head < next.length && prev[head] === next[head]) head++
    let tail = 0
    while (tail < prev.length - head && tail < next.length - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++
    this.endGroup(id)
    const del = this.delete(id, head, prev.length - head - tail)
    const ins = this.insert(id, head, next.slice(head, next.length - tail))
    this.endGroup(id)
    this.flush(id)
    return del || ins
  }

  /** Close the undo group: the next edit starts a new one. */
  endGroup(id: string): void {
    const doc = this.docs.get(id)
    if (doc) doc.open = null
  }

  /** Undo/redo this user's latest change group. Returns false when there is nothing to do. */
  undo(id: string): boolean {
    return this.step(id, 'undo')
  }

  redo(id: string): boolean {
    return this.step(id, 'redo')
  }

  flush(id?: string): void {
    for (const doc of id === undefined ? this.docs.values() : [this.docs.get(id)]) {
      if (!doc) continue
      clearTimeout(doc.timer)
      doc.timer = undefined
      this.send(doc)
    }
  }

  close(): void {
    this.flush()
  }

  // ------------------------------------------------------------ internals

  private blank(id: string, conv: string): Doc {
    const doc: Doc = {
      id,
      conv,
      name: '',
      nameTs: 0,
      removed: false,
      lastEdit: 0,
      crdt: new TextCrdt(this.short),
      editors: new Map(),
      undo: [],
      redo: [],
      open: null,
      outbox: [],
      timer: undefined,
    }
    this.docs.set(id, doc)
    return doc
  }

  private record(doc: Doc, op: TextOp, inverse: Inverse, undoable = true): void {
    if (undoable) {
      if (!doc.open) {
        doc.open = []
        doc.undo.push(doc.open)
        doc.redo = []
      }
      doc.open.push(inverse)
    }
    doc.lastEdit = Date.now()
    doc.editors.set(this.me, doc.lastEdit)
    this.queue(doc, op)
    this.emit('change')
  }

  private step(id: string, dir: 'undo' | 'redo'): boolean {
    const doc = this.docs.get(id)
    if (!doc || doc.removed) return false
    doc.open = null
    const group = (dir === 'undo' ? doc.undo : doc.redo).pop()
    if (!group) return false
    const reverse: Inverse[] = []
    for (const inv of [...group].reverse()) {
      const done = doc.crdt.applyInverse(inv)
      if (!done) continue
      reverse.push(done.inverse)
      this.record(doc, done.op, done.inverse, false)
    }
    if (reverse.length > 0) (dir === 'undo' ? doc.redo : doc.undo).push(reverse)
    return true
  }

  /** Coalesce typing: a run continuing the previous insert extends it instead of becoming another operation. */
  private queue(doc: Doc, op: TextOp): void {
    const last = doc.outbox.at(-1)
    if (op.k === 'i' && last?.k === 'i' && op.c === last.c + last.s.length && op.p?.[0] === this.short && op.p[1] === last.c + last.s.length - 1) {
      last.s += op.s
    } else doc.outbox.push(op.k === 'i' ? { ...op } : op)
    clearTimeout(doc.timer)
    doc.timer = setTimeout(() => this.send(doc), FLUSH_MS)
    doc.timer.unref()
  }

  private send(doc: Doc): void {
    clearTimeout(doc.timer)
    doc.timer = undefined
    const ops = doc.outbox.splice(0).flatMap((op) => shrink(doc.id, op, this.short))
    let batch: DocOp[] = []
    for (const op of ops) {
      if (batch.length > 0 && (batch.length >= MAX_OPS_PER_EVENT || encode(doc.id, [...batch, op]).length > BODY_LIMIT)) {
        this.publish(doc.conv, encode(doc.id, batch))
        batch = []
      }
      batch.push(op)
    }
    if (batch.length > 0) this.publish(doc.conv, encode(doc.id, batch))
  }
}

/**
 * Halve an operation until its encoded event body fits. The size is measured after JSON escaping, because that is what the
 * wire limits: a peer that rejects one of our events would reject every later event from us in that conversation.
 */
function shrink(id: string, op: TextOp, author: string): TextOp[] {
  if (encode(id, [op]).length <= BODY_LIMIT) return [op]
  if (op.k === 'd') {
    if (op.r.length < 2) return [op]
    const mid = op.r.length >> 1
    return [...shrink(id, { k: 'd', r: op.r.slice(0, mid) }, author), ...shrink(id, { k: 'd', r: op.r.slice(mid) }, author)]
  }
  if (op.s.length < 2) return [op]
  const mid = op.s.length >> 1
  const head: InsertOp = { k: 'i', c: op.c, p: op.p, s: op.s.slice(0, mid) }
  const tail: InsertOp = { k: 'i', c: op.c + mid, p: [author, op.c + mid - 1], s: op.s.slice(mid) }
  return [...shrink(id, head, author), ...shrink(id, tail, author)]
}
export const DOCS_ID = 'docs'
