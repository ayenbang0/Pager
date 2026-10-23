import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Sync } from './canvas-sync.js'
import { History, parseShape } from './canvas-model.js'

const require = createRequire(import.meta.url)
const handler = require('../../electron/blocks/canvas.cjs')

const rect = (id, x = 0, y = 0, extra = {}) => parseShape({ id, type: 'rect', x, y, w: 100, h: 60, seed: 1, ...extra })

/** A tiny editor: history + a Sync wired to the real handler (ephemeral canvas, events delivered like the window would). */
async function client(name, events) {
  const ctx = { emit: (event, payload) => events.forEach((fn) => fn(event, payload)) }
  const c = { hist: new History([]), name, status: [] }
  c.sync = new Sync({
    rpc: (method, args) => handler.methods[method](JSON.parse(JSON.stringify(args)), ctx),
    getShapes: () => c.hist.shapes,
    getDoc: () => ({ view: { x: 0, y: 0, zoom: 1 }, settings: { grid: true, snap: true, hand: false }, name: 'Shared' }),
    onRemote: (shapes, meta) => {
      c.hist.commit(shapes, meta.label)
      c.sync.touch(meta.label)
      c.last = meta
    },
    onStatus: (s) => c.status.push(s),
    delay: 5,
    viewDelay: 5,
  })
  const snap = await c.sync.open({ id: 'shared', ephemeral: true })
  c.hist = new History(snap.doc.shapes)
  events.push((event, payload) => event === 'changed' && c.sync.remote(payload))
  c.edit = (fn, label) => {
    c.hist.commit(fn(c.hist.shapes), label)
    c.sync.touch(label)
  }
  return c
}
const ids = (c) => c.hist.shapes.map((s) => s.id).sort()
const settle = () => new Promise((r) => setTimeout(r, 40))

test('two windows and an agent converge without losing edits', async () => {
  handler._t.reset()
  const events = []
  const a = await client('a', events)
  const b = await client('b', events)
  a.edit((s) => [...s, rect('a1')], 'Add rectangle')
  await a.sync.flush()
  assert.deepEqual(handler._t.docs.get('shared').doc.shapes.map((s) => s.id), ['a1'])
  // b has not seen a1 yet (saves do not echo to other windows); its own save conflicts, merges and succeeds
  b.edit((s) => [...s, rect('b1', 300)], 'Add rectangle')
  await b.sync.flush()
  assert.deepEqual(ids(b), ['a1', 'b1'], 'b merged a1 in')
  assert.equal(b.last.source, 'user', "a's save was broadcast, so b merged it before its own save")
  // an agent edit arrives as an event; a has unsaved local work and merges it
  a.edit((s) => s.map((x) => (x.id === 'a1' ? { ...x, x: 77 } : x)), 'Move shape')
  const r = await handler.methods.edit({ id: 'shared', ops: [{ op: 'add', shape: { id: 'ag', type: 'ellipse', x: 0, y: 300, w: 80, h: 80 } }, { op: 'update', id: 'b1', set: { stroke: '#ff0000' } }] }, { emit: (e, p) => events.forEach((fn) => fn(e, p)) })
  assert.equal(r.ok, true)
  await settle()
  await a.sync.flush()
  await b.sync.flush()
  await settle()
  for (const c of [a, b]) {
    const by = Object.fromEntries(c.hist.shapes.map((s) => [s.id, s]))
    assert.deepEqual(Object.keys(by).sort(), ['a1', 'ag', 'b1'])
    assert.equal(by.a1.x, 77, `${c.name}: local move kept`)
    assert.equal(by.b1.stroke, '#ff0000', `${c.name}: agent update kept`)
  }
  const doc = handler._t.docs.get('shared').doc
  assert.equal(doc.shapes.find((s) => s.id === 'a1').x, 77)
  assert.equal(a.sync.status, 'saved')
  assert.ok(['agent', 'merge', 'user'].includes(b.last.source))
})

test('an agent edit with nothing local to merge is adopted as is and recorded in history', async () => {
  handler._t.reset()
  const events = []
  const a = await client('a', events)
  await handler.methods.edit({ id: 'shared', ops: [{ op: 'add', shape: { id: 'x1', type: 'rect', x: 0, y: 0, w: 50, h: 50 } }], label: 'Agent: sketch' }, { emit: (e, p) => events.forEach((fn) => fn(e, p)) })
  await settle()
  assert.deepEqual(ids(a), ['x1'])
  assert.equal(a.hist.entries.slice(-1)[0].label, 'Agent: sketch')
  assert.equal(a.last.source, 'agent')
  assert.deepEqual(a.last.ids.created, ['x1'])
  a.hist.undo()
  assert.deepEqual(ids(a), [], 'the user can undo the agent edit')
  a.sync.touch('Undo')
  await a.sync.flush()
  assert.equal(handler._t.docs.get('shared').doc.shapes.length, 0, 'and that save wins (no conflict: seq is current)')
})

test('save failures surface as an error status and are retried', async () => {
  handler._t.reset()
  let fail = true
  const c = { hist: new History([]) }
  const status = []
  c.sync = new Sync({
    rpc: async (method, args) => {
      if (method === 'save' && fail) throw new Error('boom')
      return handler.methods[method](args, {})
    },
    getShapes: () => c.hist.shapes,
    getDoc: () => ({ view: { x: 0, y: 0, zoom: 1 }, settings: { grid: true, snap: true, hand: false }, name: 'x' }),
    onRemote: () => {},
    onStatus: (s) => status.push(s),
    delay: 5,
  })
  c.hist = new History((await c.sync.open({ id: 'flaky', ephemeral: true })).doc.shapes)
  c.hist.commit([rect('a')], 'Add')
  c.sync.touch('Add')
  await settle()
  assert.equal(status.includes('error'), true)
  fail = false
  await new Promise((r) => setTimeout(r, 1000))
  c.sync.dispose()
  assert.equal(status[status.length - 1], 'saved')
  assert.equal(handler._t.docs.get('flaky').doc.shapes.length, 1)
})
