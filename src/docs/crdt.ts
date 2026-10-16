/**
 * A replicated text (RGA): every character has a unique id (author, clock) and remembers the character
 * it was typed after. Replicas that apply the same operations in any causal order converge to the same text.
 * Deleted characters stay as tombstones so late inserts can still anchor to them.
 */

/** Author ids are the first 12 hex chars of the public key; collisions among <= 16 members are negligible. */
export type Id = readonly [author: string, clock: number]

/** `s` is a run of characters with clocks c, c+1, ...; the event author supplies the author id. `p` is the id it was typed after. */
export interface InsertOp {
  k: 'i'
  c: number
  p: Id | null
  s: string
}
/** Ranges of characters to delete: [author, firstClock, length]. */
export interface DeleteOp {
  k: 'd'
  r: [string, number, number][]
}
export type TextOp = InsertOp | DeleteOp

/** What undoing a local change means, expressed on ids so concurrent edits do not shift it. */
export type Inverse = { k: 'del'; r: [string, number, number][] } | { k: 'ins'; after: Id | null; s: string }

interface El {
  a: string
  c: number
  ch: string
  del: boolean
}

const key = (a: string, c: number): string => `${a}:${c}`
/** (clock, author) lexicographic: the RGA tie-break between concurrent inserts after the same character. */
const newer = (x: El, y: { a: string; c: number }): boolean => x.c > y.c || (x.c === y.c && x.a > y.a)

export class TextCrdt {
  private els: El[] = []
  private readonly byId = new Map<string, El>()
  private pending: { author: string; op: TextOp }[] = []
  private clock = 1
  private cached: string | null = ''
  readonly me: string

  constructor(me: string) {
    this.me = me
  }

  text(): string {
    this.cached ??= this.els.reduce((s, e) => (e.del ? s : s + e.ch), '')
    return this.cached
  }

  get length(): number {
    return this.text().length
  }

  /** Remote operations whose dependencies have not arrived yet. */
  get blocked(): number {
    return this.pending.length
  }

  /** Visible index of `id`, or -1 when absent or deleted. */
  indexOf(id: Id): number {
    const target = this.byId.get(key(id[0], id[1]))
    if (!target || target.del) return -1
    let n = 0
    for (const e of this.els) {
      if (e === target) return n
      if (!e.del) n++
    }
    return -1
  }

  /** Insert `s` at visible position `pos`. */
  insert(pos: number, s: string): { op: InsertOp; inverse: Inverse } | null {
    if (s === '') return null
    const origin = pos <= 0 ? null : this.idAt(Math.min(pos, this.length) - 1)
    return this.insertAfter(origin, s)
  }

  /** Insert `s` right after the character `origin` (null = document start), tombstones included. */
  insertAfter(origin: Id | null, s: string): { op: InsertOp; inverse: Inverse } | null {
    if (s === '' || (origin !== null && !this.byId.has(key(origin[0], origin[1])))) return null
    const op: InsertOp = { k: 'i', c: this.clock, p: origin, s }
    this.integrateRun(this.me, op)
    return { op, inverse: { k: 'del', r: [[this.me, op.c, s.length]] } }
  }

  /** Delete `len` visible characters from `pos`. */
  delete(pos: number, len: number): { op: DeleteOp; inverse: Inverse } | null {
    const start = Math.max(0, pos)
    const end = Math.min(this.length, pos + len)
    if (end <= start) return null
    const ranges: [string, number, number][] = []
    let text = ''
    let seen = 0
    let lastBefore: Id | null = null
    for (const e of this.els) {
      if (e.del) continue
      if (seen < start) lastBefore = [e.a, e.c]
      else if (seen < end) {
        const last = ranges.at(-1)
        if (last && last[0] === e.a && last[1] + last[2] === e.c) last[2]++
        else ranges.push([e.a, e.c, 1])
        text += e.ch
      }
      seen++
      if (seen >= end) break
    }
    const after = lastBefore
    for (const [a, c, n] of ranges) this.markDeleted(a, c, n)
    return { op: { k: 'd', r: ranges }, inverse: { k: 'ins', after, s: text } }
  }

  /** Apply the inverse of an earlier local change; returns the new operation to publish. */
  applyInverse(inv: Inverse): { op: TextOp; inverse: Inverse } | null {
    if (inv.k === 'ins') return this.insertAfter(inv.after, inv.s)
    const live: [string, number, number][] = []
    for (const [a, c, n] of inv.r) {
      for (let i = 0; i < n; i++) {
        const e = this.byId.get(key(a, c + i))
        if (!e || e.del) continue
        const last = live.at(-1)
        if (last && last[0] === a && last[1] + last[2] === c + i) last[2]++
        else live.push([a, c + i, 1])
      }
    }
    if (live.length === 0) return null
    // Re-derive the reverse inverse from the live characters' current text and left neighbour.
    let text = ''
    let after: Id | null = null
    let prev: Id | null = null
    let found = false
    for (const e of this.els) {
      if (!found && !e.del && live[0] && e.a === live[0][0] && e.c === live[0][1]) {
        after = prev
        found = true
      }
      if (!e.del) prev = [e.a, e.c]
    }
    for (const [a, c, n] of live) for (let i = 0; i < n; i++) text += this.byId.get(key(a, c + i))?.ch ?? ''
    for (const [a, c, n] of live) this.markDeleted(a, c, n)
    return { op: { k: 'd', r: live }, inverse: { k: 'ins', after, s: text } }
  }

  /** Apply an operation from `author`. Returns false while its dependencies are missing (it is retried automatically). */
  apply(author: string, op: TextOp): boolean {
    if (!this.ready(op)) {
      this.pending.push({ author, op })
      return false
    }
    this.run(author, op)
    let progressed = true
    while (progressed && this.pending.length > 0) {
      progressed = false
      for (const [i, p] of this.pending.entries()) {
        if (!this.ready(p.op)) continue
        this.pending.splice(i, 1)
        this.run(p.author, p.op)
        progressed = true
        break
      }
    }
    return true
  }

  /** The id of the visible character at `pos`. */
  idAt(pos: number): Id | null {
    let n = 0
    for (const e of this.els) {
      if (e.del) continue
      if (n === pos) return [e.a, e.c]
      n++
    }
    return null
  }

  private ready(op: TextOp): boolean {
    if (op.k === 'i') return op.p === null || this.byId.has(key(op.p[0], op.p[1]))
    return op.r.every(([a, c, n]) => {
      for (let i = 0; i < n; i++) if (!this.byId.has(key(a, c + i))) return false
      return true
    })
  }

  private run(author: string, op: TextOp): void {
    if (op.k === 'i') {
      this.integrateRun(author, op)
      this.clock = Math.max(this.clock, op.c + op.s.length)
    } else for (const [a, c, n] of op.r) this.markDeleted(a, c, n)
  }

  private integrateRun(author: string, op: InsertOp): void {
    let origin: Id | null = op.p
    for (let i = 0; i < op.s.length; i++) {
      const el: El = { a: author, c: op.c + i, ch: op.s[i] ?? '', del: false }
      if (!this.byId.has(key(el.a, el.c))) this.integrate(el, origin)
      origin = [el.a, el.c]
    }
    this.clock = Math.max(this.clock, op.c + op.s.length)
  }

  private integrate(el: El, origin: Id | null): void {
    let i = 0
    if (origin !== null) {
      const o = this.byId.get(key(origin[0], origin[1]))
      i = o ? this.els.indexOf(o) + 1 : 0
    }
    while (i < this.els.length && newer(this.els[i] as El, el)) i++
    this.els.splice(i, 0, el)
    this.byId.set(key(el.a, el.c), el)
    this.cached = null
  }

  private markDeleted(a: string, c: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const e = this.byId.get(key(a, c + i))
      if (e) e.del = true
    }
    this.cached = null
  }
}
