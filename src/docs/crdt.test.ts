import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TextCrdt, type TextOp } from './crdt.js'

function replicate(from: TextCrdt, ops: TextOp[], to: TextCrdt[]): void {
  for (const t of to) for (const op of ops) t.apply(from.me, op)
}

test('concurrent inserts at the same spot converge and keep each author\'s run together', () => {
  const a = new TextCrdt('aaaa')
  const b = new TextCrdt('bbbb')
  const base = a.insert(0, 'ac')
  assert.ok(base)
  b.apply('aaaa', base.op)
  const x = a.insert(1, 'XX')
  const y = b.insert(1, 'YY')
  assert.ok(x && y)
  a.apply('bbbb', y.op)
  b.apply('aaaa', x.op)
  assert.equal(a.text(), b.text())
  assert.match(a.text(), /^a(XXYY|YYXX)c$/)
})

test('a delete and an insert that raced converge; deleting twice is harmless', () => {
  const a = new TextCrdt('aaaa')
  const b = new TextCrdt('bbbb')
  const base = a.insert(0, 'hello world')
  assert.ok(base)
  b.apply('aaaa', base.op)
  const del = a.delete(0, 6)
  const ins = b.insert(11, '!')
  assert.ok(del && ins)
  a.apply('bbbb', ins.op)
  b.apply('aaaa', del.op)
  b.apply('aaaa', del.op)
  assert.equal(a.text(), 'world!')
  assert.equal(b.text(), 'world!')
})

test('operations that arrive before their dependency wait and then apply', () => {
  const a = new TextCrdt('aaaa')
  const b = new TextCrdt('bbbb')
  const one = a.insert(0, 'ab')
  const two = a.insert(2, 'cd')
  const gone = a.delete(1, 2)
  assert.ok(one && two && gone)
  assert.equal(b.apply('aaaa', gone.op), false)
  assert.equal(b.apply('aaaa', two.op), false)
  assert.equal(b.blocked, 2)
  assert.equal(b.apply('aaaa', one.op), true)
  assert.equal(b.blocked, 0)
  assert.equal(b.text(), a.text())
  assert.equal(b.text(), 'ad')
})

test('undo of an insert and of a delete restores the text and replicates', () => {
  const a = new TextCrdt('aaaa')
  const b = new TextCrdt('bbbb')
  const ops: TextOp[] = []
  const typed = a.insert(0, 'one two three')
  assert.ok(typed)
  ops.push(typed.op)
  const cut = a.delete(3, 4)
  assert.ok(cut)
  ops.push(cut.op)
  assert.equal(a.text(), 'one three')
  const back = a.applyInverse(cut.inverse)
  assert.ok(back)
  ops.push(back.op)
  assert.equal(a.text(), 'one two three')
  const redone = a.applyInverse(back.inverse)
  assert.ok(redone)
  ops.push(redone.op)
  assert.equal(a.text(), 'one three')
  const gone = a.applyInverse(typed.inverse)
  assert.ok(gone)
  ops.push(gone.op)
  assert.equal(a.text(), '')
  replicate(a, ops, [b])
  assert.equal(b.text(), '')
})

test('undoing a delete lands where the text was even after a collaborator typed nearby', () => {
  const a = new TextCrdt('aaaa')
  const b = new TextCrdt('bbbb')
  const base = a.insert(0, 'abcdef')
  assert.ok(base)
  b.apply('aaaa', base.op)
  const cut = a.delete(2, 2)
  assert.ok(cut)
  const edit = b.insert(0, '> ')
  assert.ok(edit)
  a.apply('bbbb', edit.op)
  assert.equal(a.text(), '> abef')
  const back = a.applyInverse(cut.inverse)
  assert.ok(back)
  assert.equal(a.text(), '> abcdef')
  b.apply('aaaa', cut.op)
  b.apply('aaaa', back.op)
  assert.equal(b.text(), '> abcdef')
})

test('random concurrent editing on three replicas always converges', () => {
  let seed = 12345
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  for (let round = 0; round < 40; round++) {
    const reps = [new TextCrdt('aaaa'), new TextCrdt('bbbb'), new TextCrdt('cccc')]
    const outbox: TextOp[][] = [[], [], []]
    for (let step = 0; step < 30; step++) {
      const i = rnd(3)
      const r = reps[i] as TextCrdt
      const len = r.length
      const res = rnd(3) === 0 && len > 0 ? r.delete(rnd(len), 1 + rnd(3)) : r.insert(rnd(len + 1), 'abc'.slice(0, 1 + rnd(3)))
      if (res) (outbox[i] as TextOp[]).push(res.op)
      if (rnd(4) === 0) {
        // Partial sync: a random replica receives another's ops in a shuffled order.
        const from = rnd(3)
        const to = rnd(3)
        if (from !== to) {
          const ops = [...(outbox[from] as TextOp[])].sort(() => rnd(3) - 1)
          for (const op of ops) (reps[to] as TextCrdt).apply((reps[from] as TextCrdt).me, op)
        }
      }
    }
    for (const [from, rep] of reps.entries()) {
      const ops = [...(outbox[from] as TextOp[])].sort(() => rnd(3) - 1)
      for (const [to, other] of reps.entries()) if (to !== from) for (const op of ops) other.apply(rep.me, op)
    }
    assert.equal((reps[0] as TextCrdt).text(), (reps[1] as TextCrdt).text(), `round ${round}`)
    assert.equal((reps[1] as TextCrdt).text(), (reps[2] as TextCrdt).text(), `round ${round}`)
    for (const r of reps) assert.equal(r.blocked, 0)
  }
})
