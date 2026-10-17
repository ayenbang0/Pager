import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DOC_PREFIX, DocStore, docName } from './store.js'

const ANN = 'aa'.repeat(32)
const BOB = 'bb'.repeat(32)

/** Two stores whose published events are queued and delivered on demand, like the sync layer would. */
function pair(): { ann: DocStore; bob: DocStore; sent: string[]; deliver(): void } {
  const toBob: { author: string; body: string }[] = []
  const toAnn: { author: string; body: string }[] = []
  const sent: string[] = []
  const ann = new DocStore(ANN, (_c, body) => {
    sent.push(body)
    toBob.push({ author: ANN, body })
  })
  const bob = new DocStore(BOB, (_c, body) => {
    sent.push(body)
    toAnn.push({ author: BOB, body })
  })
  return {
    ann,
    bob,
    sent,
    deliver() {
      for (const e of toBob.splice(0)) bob.applyEvent({ conv: 'grp:x', author: e.author, ts: Date.now(), body: e.body })
      for (const e of toAnn.splice(0)) ann.applyEvent({ conv: 'grp:x', author: e.author, ts: Date.now(), body: e.body })
    },
  }
}

test('a document created and typed in by one peer appears for the other, and edits merge both ways', () => {
  const { ann, bob, deliver } = pair()
  const doc = ann.create('grp:x', 'Plan')
  assert.equal(typeof doc, 'object')
  if (typeof doc === 'string') return
  assert.equal(doc.name, 'Plan.md')
  ann.insert(doc.id, 0, '# Title\n')
  ann.flush()
  deliver()
  assert.equal(bob.text(doc.id), '# Title\n')
  assert.equal(bob.list()[0]?.name, 'Plan.md')
  ann.insert(doc.id, 8, 'from ann')
  bob.insert(doc.id, 8, 'from bob')
  ann.flush()
  bob.flush()
  deliver()
  assert.equal(ann.text(doc.id), bob.text(doc.id))
  assert.ok(ann.text(doc.id).includes('from ann') && ann.text(doc.id).includes('from bob'))
  assert.deepEqual(ann.activeEditors(doc.id), [BOB])
})

test('typing coalesces into one event; huge pastes split under the body limit; no raw control characters leave', () => {
  const { ann, sent } = pair()
  const doc = ann.create('grp:x', 'a')
  if (typeof doc === 'string') return assert.fail(doc)
  sent.length = 0
  for (const [i, ch] of [...'hello'].entries()) ann.insert(doc.id, i, ch)
  ann.flush()
  assert.equal(sent.length, 1)
  sent.length = 0
  ann.insert(doc.id, 5, `\u007f\u0085${'x'.repeat(9000)}`)
  ann.flush()
  assert.ok(sent.length >= 3)
  for (const body of sent) {
    assert.ok(body.startsWith(DOC_PREFIX))
    assert.ok(body.length <= 4000, `body ${body.length}`)
    assert.equal(/\p{Cc}/u.test(body), false)
  }
})

test('undo and redo walk this user\'s own change groups and replicate', () => {
  const { ann, bob, deliver } = pair()
  const doc = ann.create('grp:x', 'u')
  if (typeof doc === 'string') return assert.fail(doc)
  ann.insert(doc.id, 0, 'one')
  ann.endGroup(doc.id)
  ann.insert(doc.id, 3, ' two')
  ann.endGroup(doc.id)
  assert.equal(ann.undo(doc.id), true)
  assert.equal(ann.text(doc.id), 'one')
  assert.equal(ann.redo(doc.id), true)
  assert.equal(ann.text(doc.id), 'one two')
  ann.undo(doc.id)
  ann.undo(doc.id)
  assert.equal(ann.text(doc.id), '')
  assert.equal(ann.undo(doc.id), false)
  ann.flush()
  deliver()
  assert.equal(bob.text(doc.id), '')
})

test('setText rewrites only the differing middle, so a concurrent edit elsewhere survives', () => {
  const { ann, bob, deliver } = pair()
  const doc = ann.create('grp:x', 'agent')
  if (typeof doc === 'string') return assert.fail(doc)
  ann.insert(doc.id, 0, 'alpha beta gamma')
  ann.flush()
  deliver()
  bob.insert(doc.id, 16, '!')
  bob.flush()
  assert.equal(ann.setText(doc.id, 'alpha BETA gamma'), true)
  deliver()
  assert.equal(ann.text(doc.id), 'alpha BETA gamma!')
  assert.equal(bob.text(doc.id), 'alpha BETA gamma!')
})

test('malformed or foreign events are ignored; names are unique per conversation; remove hides', () => {
  const { ann, bob, deliver } = pair()
  assert.equal(ann.applyEvent({ conv: 'grp:x', author: BOB, ts: 1, body: 'plain chat' }), false)
  assert.equal(ann.applyEvent({ conv: 'grp:x', author: BOB, ts: 1, body: `${DOC_PREFIX}{not json` }), true)
  assert.equal(ann.applyEvent({ conv: 'grp:x', author: BOB, ts: 1, body: `${DOC_PREFIX}${JSON.stringify({ d: 'zz', ops: [] })}` }), true)
  assert.equal(ann.list().length, 0)
  const doc = ann.create('grp:x', 'notes')
  if (typeof doc === 'string') return assert.fail(doc)
  assert.equal(typeof ann.create('grp:x', 'NOTES.md'), 'string')
  assert.equal(ann.find('notes')?.id, doc.id)
  deliver()
  ann.remove(doc.id)
  deliver()
  assert.equal(bob.list().length, 0)
})

test('document names are made safe', () => {
  assert.equal(docName(' my plan '), 'my-plan.md')
  assert.equal(docName('a/b\\c.txt'), 'a-b-c.txt')
  assert.equal(docName('  '), '')
})

test('every published body fits the wire limit even for escape-heavy pastes and huge interleaved deletes, and still replicates', () => {
  const { ann, bob, sent, deliver } = pair()
  const doc = ann.create('grp:x', 'big')
  if (typeof doc === 'string') return assert.fail(doc)
  sent.length = 0
  const quoted = '"\n'.repeat(1500) // JSON turns each pair into 4 characters
  ann.insert(doc.id, 0, quoted)
  for (let i = 0; i < 1200; i++) ann.insert(doc.id, 0, 'x') // typed backwards: every character is its own id range
  ann.flush()
  ann.delete(doc.id, 0, 1200)
  ann.flush()
  assert.ok(sent.length > 3)
  for (const body of sent) assert.ok(body.length <= 4000, `body ${body.length}`)
  deliver()
  assert.equal(bob.text(doc.id), quoted)
  assert.equal(ann.text(doc.id), quoted)
})

test('an anchor on a line survives two collaborators editing above and below it in one delivery', () => {
  const { ann, bob, deliver } = pair()
  const doc = ann.create('grp:x', 'Plan')
  assert.equal(typeof doc, 'object')
  if (typeof doc === 'string') return
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
  ann.insert(doc.id, 0, lines.join('\n'))
  ann.flush()
  deliver()
  const at = bob.text(doc.id).indexOf('line 30')
  const anchor = bob.anchorAt(doc.id, at, false)
  ann.insert(doc.id, ann.text(doc.id).indexOf('line 2'), 'top\n')
  ann.flush()
  ann.insert(doc.id, ann.text(doc.id).indexOf('line 38'), 'bottom\n')
  ann.flush()
  deliver()
  assert.equal(bob.text(doc.id).slice(bob.positionOf(doc.id, anchor)).startsWith('line 30'), true)
  assert.notEqual(bob.positionOf(doc.id, anchor), at)
})
