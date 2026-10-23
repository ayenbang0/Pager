import test from 'node:test'
import assert from 'node:assert/strict'
import {
  History, LIMITS, alignShapes, applyOps, byId, cleanBindings, cloneShapes, distributeShapes, diffIds, duplicateShapes, emptyDoc,
  expandUnits, fitView, fitText, groupShapes, layoutShapes, mergeShapes, moveShapes, normalizeDoc, parseShape, reflowBindings, reorder,
  rotateShapes, scaleShapes, ungroupShapes, wrapText,
} from './canvas-model.js'
import { aabb, centerOf } from './canvas-geom.js'

const seq = () => {
  let i = 0
  return () => ((i = (i * 9301 + 49297) % 233280) / 233280 + 0.0001)
}
const rect = (id, x, y, w = 100, h = 60, extra = {}) => parseShape({ id, type: 'rect', x, y, w, h, ...extra })
const ids = (shapes) => shapes.map((s) => s.id)

test('parseShape fills defaults and generates an id and seed', () => {
  const s = parseShape({ type: 'rect', x: 5, y: 6 }, { rng: seq() })
  assert.equal(s.type, 'rect')
  assert.match(s.id, /^s[a-z0-9]{8}$/)
  assert.equal(s.w, 140)
  assert.equal(s.stroke, 'auto')
  assert.equal(s.fill, 'transparent')
  assert.equal(s.dash, 'solid')
  assert.equal(s.opacity, 1)
  assert.ok(Number.isInteger(s.seed) && s.seed > 0)
})

test('parseShape rejects bad input with a path', () => {
  const bad = (raw, re) => assert.throws(() => parseShape(raw), re)
  bad({ type: 'blob' }, /type: must be one of/)
  bad({ type: 'rect', x: NaN }, /x: must be a finite number/)
  bad({ type: 'rect', x: 1e9 }, /x: must be between/)
  bad({ type: 'rect', w: -1 }, /w: must be between/)
  bad({ type: 'rect', stroke: 'url(javascript:1)' }, /stroke: must be a colour/)
  bad({ type: 'rect', fill: '#12' }, /fill: must be a colour/)
  bad({ type: 'rect', opacity: 2 }, /opacity/)
  bad({ type: 'rect', sw: 99 }, /sw/)
  bad({ type: 'rect', dash: 'wavy' }, /dash: must be one of/)
  bad({ type: 'rect', evil: 1 }, /unknown field for a rect/)
  bad({ type: 'rect', id: 'has space' }, /id: must match/)
  bad({ type: 'rect', text: 'x'.repeat(LIMITS.text + 1) }, /longer than/)
  bad({ type: 'line' }, /pts: is required/)
  bad({ type: 'line', pts: [[0, 0]] }, /needs 2/)
  bad({ type: 'line', pts: [[0, 0], [1, 'a']] }, /must be a finite number/)
  bad({ type: 'arrow', pts: [[0, 0], [1, 1]], bind: { s: 'no spaces' } }, /bind\.s/)
  bad({ type: 'arrow', pts: [[0, 0], [1, 1]], bind: { q: 'a' } }, /unknown binding end/)
  bad({ type: 'image', x: 0, y: 0 }, /hash/)
  bad({ type: 'image', hash: 'zz' }, /hash/)
  bad({ type: 'ink', pts: [[0, 0, 5]] }, /between 0 and 1/)
  bad({ type: 'text', size: 2 }, /size/)
  bad(null, /must be an object/)
  bad({ type: 'rect', g: ['ok', 'not ok'] }, /group ids/)
})

test('lines normalise their points to a local origin and accept x1..y2', () => {
  const a = parseShape({ type: 'arrow', x1: 10, y1: 20, x2: 110, y2: 70 })
  assert.deepEqual([a.x, a.y, a.w, a.h], [10, 20, 100, 50])
  assert.deepEqual(a.pts, [[0, 0], [100, 50]])
  assert.equal(a.head, 'arrow')
  const l = parseShape({ type: 'line', x: 100, y: 100, pts: [[0, 0], [-40, 30]] })
  assert.deepEqual([l.x, l.y, l.w, l.h], [60, 100, 40, 30])
  assert.deepEqual(l.pts, [[40, 0], [0, 30]])
  assert.equal(l.head, 'none')
})

test('text shapes size themselves; labels and stickies wrap', () => {
  const t = parseShape({ type: 'text', text: 'Hello\nworld', x: 0, y: 0 })
  assert.ok(t.w > 20 && t.h >= 2 * t.size)
  const bigger = fitText({ ...t, text: 'Hello world, a much longer line of text' })
  assert.ok(bigger.w > t.w)
  const lines = wrapText('alpha beta gamma delta epsilon', 60, 16, 'sans')
  assert.ok(lines.length > 1)
  assert.equal(lines.join(' '), 'alpha beta gamma delta epsilon')
  assert.deepEqual(wrapText('a\n\nb', 0, 16, 'sans'), ['a', '', 'b'])
})

test('normalizeDoc is lenient: drops bad shapes, renames duplicates, clears dangling bindings', () => {
  const d = normalizeDoc({
    name: '  My board  ',
    seq: 7,
    view: { x: 1, y: 2, zoom: 99 },
    shapes: [
      { id: 'a', type: 'rect', x: 0, y: 0, w: 50, h: 50 },
      { id: 'a', type: 'ellipse', x: 100, y: 0, w: 50, h: 50 },
      { type: 'nope' },
      7,
      { id: 'ar', type: 'arrow', pts: [[0, 0], [10, 10]], bind: { s: 'a', e: 'ghost' }, junk: true },
    ],
  })
  assert.equal(d.name, 'My board')
  assert.equal(d.seq, 7)
  assert.equal(d.view.zoom, 1) // out of range: default
  assert.equal(d.shapes.length, 3)
  assert.equal(d.dropped, 2)
  assert.equal(new Set(ids(d.shapes)).size, 3)
  const ar = d.shapes.find((s) => s.type === 'arrow')
  assert.equal(ar.bind.s, 'a')
  assert.equal(ar.bind.e, undefined)
  assert.throws(() => normalizeDoc([]), /JSON object/)
})

test('bound arrows follow their targets', () => {
  const a = rect('a', 0, 0, 100, 60)
  const b = rect('b', 300, 0, 100, 60)
  const ar = parseShape({ id: 'ar', type: 'arrow', x1: 0, y1: 0, x2: 10, y2: 10, from: 'a', to: 'b' })
  let shapes = reflowBindings([a, b, ar])
  let arrow = byId(shapes).get('ar')
  const abs = (s) => s.pts.map((p) => [s.x + p[0], s.y + p[1]])
  assert.ok(Math.abs(abs(arrow)[0][0] - 104) < 0.01, 'starts just right of a (edge + gap)')
  assert.ok(Math.abs(abs(arrow)[1][0] - 296) < 0.01, 'ends just left of b')
  shapes = moveShapes(shapes, new Set(['b']), 0, 200)
  arrow = byId(shapes).get('ar')
  const [p0, p1] = abs(arrow)
  assert.ok(p1[1] > p0[1], 'the arrow now points downward')
  const b2 = byId(shapes).get('b')
  assert.ok(Math.abs(p1[0] - b2.x) < 200 && p1[1] <= b2.y + b2.h)
  // moving the arrow alone detaches it
  const lone = moveShapes(shapes, new Set(['ar']), 5, 5)
  assert.equal(byId(lone).get('ar').bind, undefined)
  // removing a target clears the binding but keeps the arrow
  const r = applyOps(shapes, [{ op: 'remove', ids: ['a'] }])
  assert.ok(r.ok)
  assert.equal(byId(r.shapes).get('ar').bind.s, undefined)
  assert.equal(byId(r.shapes).get('ar').bind.e, 'b')
})

test('ellipse and diamond edge points sit on the outline', () => {
  const e = parseShape({ id: 'e', type: 'ellipse', x: 0, y: 0, w: 200, h: 100 })
  const d = parseShape({ id: 'd', type: 'diamond', x: 0, y: 0, w: 200, h: 100 })
  const ar = parseShape({ id: 'ar', type: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1, from: 'e', to: 'd', pts: undefined })
  void ar
  const arrow = (from, to) => parseShape({ id: 'q', type: 'arrow', pts: [[0, 0], [1, 1]], bind: { s: from, e: to } })
  const shapes = reflowBindings([e, { ...d, x: 500, y: 0 }, arrow('e', 'd')])
  const q = byId(shapes).get('q')
  assert.ok(Math.abs(q.x - 204) < 0.01) // ellipse right extreme (200) + gap
  assert.ok(Math.abs(q.x + q.w - 496) < 0.01) // diamond left vertex (500) - gap
})

test('move, rotate and scale transforms', () => {
  const a = rect('a', 0, 0, 100, 50)
  const s1 = moveShapes([a], new Set(['a']), 10, -5)
  assert.deepEqual([s1[0].x, s1[0].y], [10, -5])
  assert.equal(moveShapes([a], new Set(['a']), 0, 0)[0], a)
  const r = rotateShapes([a], new Set(['a']), centerOf(a), Math.PI / 2)
  assert.ok(Math.abs(r[0].angle - Math.PI / 2) < 1e-9)
  assert.ok(Math.abs(centerOf(r[0])[0] - 50) < 1e-9)
  const ln = parseShape({ id: 'l', type: 'line', pts: [[0, 0], [100, 0]], x: 0, y: 0 })
  const rl = rotateShapes([ln], new Set(['l']), [0, 0], Math.PI / 2)[0]
  assert.ok(Math.abs(rl.w) < 1e-6 && Math.abs(rl.h - 100) < 1e-6, 'a rotated line bakes the rotation into its points')
  const sc = scaleShapes([a], new Set(['a']), { x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 0, w: 200, h: 100 })
  assert.deepEqual([sc[0].x, sc[0].y, sc[0].w, sc[0].h], [0, 0, 200, 100])
  const t = parseShape({ id: 't', type: 'text', text: 'Hi', size: 20, x: 0, y: 0 })
  const st = scaleShapes([t], new Set(['t']), aabb(t), { x: 0, y: 0, w: t.w * 2, h: t.h * 2 })[0]
  assert.ok(st.size > 35 && st.size < 45, 'text scales its font size')
})

test('groups: group, expand, ungroup, nesting', () => {
  let shapes = [rect('a', 0, 0), rect('b', 200, 0), rect('c', 400, 0)]
  const g1 = groupShapes(shapes, new Set(['a', 'b']), 'g1')
  assert.equal(g1.gid, 'g1')
  shapes = g1.shapes
  assert.deepEqual([...expandUnits(shapes, ['a'])].sort(), ['a', 'b'])
  assert.equal(groupShapes(shapes, new Set(['c']), 'x').gid, null, 'a single ungrouped shape cannot be grouped alone')
  const g2 = groupShapes(shapes, new Set(['a', 'c']), 'g2')
  shapes = g2.shapes
  assert.deepEqual(byId(shapes).get('a').g, ['g1', 'g2'])
  assert.deepEqual([...expandUnits(shapes, ['c'])].sort(), ['a', 'b', 'c'])
  const u = ungroupShapes(shapes, new Set(['a']))
  assert.deepEqual(byId(u).get('a').g, ['g1'])
  assert.equal(byId(u).get('c').g, undefined)
  const all = ungroupShapes(u, new Set(), ['g1'])
  assert.equal(byId(all).get('a').g, undefined)
})

test('align, distribute, z-order', () => {
  const shapes = [rect('a', 0, 0, 50, 50), rect('b', 100, 30, 80, 20), rect('c', 400, 70, 50, 50)]
  const all = new Set(['a', 'b', 'c'])
  const left = byId(alignShapes(shapes, all, 'left'))
  assert.deepEqual(['a', 'b', 'c'].map((i) => left.get(i).x), [0, 0, 0])
  const bottom = byId(alignShapes(shapes, all, 'bottom'))
  assert.deepEqual(['a', 'b', 'c'].map((i) => bottom.get(i).y + bottom.get(i).h), [120, 120, 120])
  const mid = byId(alignShapes(shapes, all, 'center'))
  assert.equal(mid.get('a').x + 25, mid.get('b').x + 40)
  const dist = byId(distributeShapes(shapes, all, 'x'))
  const gap1 = dist.get('b').x - (dist.get('a').x + dist.get('a').w)
  const gap2 = dist.get('c').x - (dist.get('b').x + dist.get('b').w)
  assert.ok(Math.abs(gap1 - gap2) < 1e-9)
  assert.equal(dist.get('a').x, 0)
  assert.equal(dist.get('c').x, 400)
  assert.equal(distributeShapes(shapes.slice(0, 2), new Set(['a', 'b']), 'x').length, 2)
  assert.deepEqual(ids(reorder(shapes, new Set(['a']), 'front')), ['b', 'c', 'a'])
  assert.deepEqual(ids(reorder(shapes, new Set(['c']), 'back')), ['c', 'a', 'b'])
  assert.deepEqual(ids(reorder(shapes, new Set(['a']), 'forward')), ['b', 'a', 'c'])
  assert.deepEqual(ids(reorder(shapes, new Set(['c']), 'backward')), ['a', 'c', 'b'])
  assert.deepEqual(ids(reorder(shapes, new Set(['a', 'b']), 'forward')), ['c', 'a', 'b'])
})

test('align keeps groups together', () => {
  let shapes = [rect('a', 0, 0, 50, 50), rect('b', 100, 100, 50, 50), rect('c', 300, 20, 50, 50)]
  shapes = groupShapes(shapes, new Set(['a', 'b']), 'g').shapes
  const out = byId(alignShapes(shapes, new Set(['a', 'b', 'c']), 'top'))
  assert.equal(out.get('b').y - out.get('a').y, 100)
  assert.equal(out.get('c').y, 0)
})

test('layout grid: tidy rows and columns, groups as units', () => {
  const shapes = [rect('a', 300, 10, 100, 50), rect('b', 0, 0, 60, 80), rect('c', 150, 200, 100, 50), rect('d', 20, 400, 40, 40)]
  const out = byId(layoutShapes(shapes, new Set(['a', 'b', 'c', 'd']), { kind: 'grid', columns: 2, gap: 20 }))
  // reading order is b, a, c, d (top row: b,a)
  assert.ok(out.get('b').x < out.get('a').x)
  assert.ok(Math.abs(out.get('b').y + out.get('b').h / 2 - (out.get('a').y + out.get('a').h / 2)) < 1e-6, 'rows are vertically centred')
  assert.ok(out.get('c').y > out.get('b').y + 80)
  const colA = out.get('b').x + out.get('b').w / 2
  const colC = out.get('c').x + out.get('c').w / 2
  assert.ok(colA > 0 && colC > 0)
  const gaps = out.get('a').x - (out.get('b').x + out.get('b').w)
  assert.ok(gaps >= 20 - 1e-6)
  const row = byId(layoutShapes(shapes, new Set(['a', 'b', 'c', 'd']), { kind: 'row', gap: 10 }))
  const ys = [...row.values()].map((s) => s.y + s.h / 2)
  assert.ok(ys.every((y) => Math.abs(y - ys[0]) < 1e-6))
  const col = byId(layoutShapes(shapes, new Set(['a', 'b', 'c', 'd']), { kind: 'column', gap: 10 }))
  const xs = [...col.values()].map((s) => s.x + s.w / 2)
  assert.ok(xs.every((x) => Math.abs(x - xs[0]) < 1e-6))
})

test('layout tree follows the arrows: parents above and centred over their children', () => {
  const n = (id) => rect(id, Math.random() * 500, Math.random() * 500, 80, 40)
  const arrow = (id, from, to) => parseShape({ id, type: 'arrow', pts: [[0, 0], [1, 1]], bind: { s: from, e: to } })
  const shapes = [n('root'), n('l'), n('r'), n('ll'), n('lr'), arrow('1', 'root', 'l'), arrow('2', 'root', 'r'), arrow('3', 'l', 'll'), arrow('4', 'l', 'lr')]
  const out = byId(layoutShapes(shapes, new Set(ids(shapes)), { kind: 'tree', gap: 20 }))
  const cx = (i) => out.get(i).x + out.get(i).w / 2
  assert.ok(out.get('root').y < out.get('l').y && out.get('l').y < out.get('ll').y)
  assert.equal(out.get('l').y, out.get('r').y)
  assert.ok(cx('root') > cx('ll') && cx('root') < cx('r'), 'the root sits over the span of its children')
  assert.ok(Math.abs(cx('l') - (cx('ll') + cx('lr')) / 2) < 1e-6)
  assert.ok(cx('ll') < cx('lr') && cx('lr') < cx('r'), 'subtrees do not overlap')
  // arrows were re-routed to the new positions
  const a1 = out.get('1')
  assert.ok(a1.y >= out.get('root').y + out.get('root').h - 0.01)
  const right = byId(layoutShapes(shapes, new Set(ids(shapes)), { kind: 'tree', gap: 20, dir: 'right' }))
  assert.ok(right.get('root').x < right.get('l').x && right.get('l').x < right.get('ll').x)
  // no edges: falls back to a grid
  const flat = layoutShapes([n('p'), n('q'), n('r')], new Set(['p', 'q', 'r']), { kind: 'tree' })
  assert.equal(flat.length, 3)
})

test('duplicate and clone remap ids, groups and bindings', () => {
  let shapes = [rect('a', 0, 0), rect('b', 200, 0), parseShape({ id: 'ar', type: 'arrow', pts: [[0, 0], [1, 1]], bind: { s: 'a', e: 'b' } })]
  shapes = groupShapes(shapes, new Set(['a', 'b']), 'g').shapes
  const r = duplicateShapes(shapes, new Set(['a']), 30)
  assert.equal(r.ids.length, 2, 'duplicating a grouped shape duplicates the group')
  const copies = r.shapes.filter((s) => r.ids.includes(s.id))
  assert.ok(copies.every((c) => c.g && c.g[0] !== 'g'))
  assert.equal(copies[0].g[0], copies[1].g[0])
  assert.equal(copies[0].x, 30)
  const withArrow = cloneShapes(shapes)
  const arrow = withArrow.find((s) => s.type === 'arrow')
  assert.ok(arrow.bind.s !== 'a' && withArrow.some((s) => s.id === arrow.bind.s), 'binding retargeted to the copy')
  const partial = cloneShapes(shapes.filter((s) => s.id !== 'b'))
  assert.equal(partial.find((s) => s.type === 'arrow').bind.e, undefined)
  const only = cloneShapes([shapes.find((s) => s.type === 'arrow'), shapes.find((s) => s.id === 'a')])
  assert.equal(only.find((s) => s.type === 'arrow').bind.e, undefined, 'a binding to a shape that is not copied is dropped')
})

test('applyOps add / update / remove', () => {
  const r = applyOps([], [
    { op: 'add', shape: { id: 'box', type: 'rect', x: 10, y: 20, w: 120, h: 80, fill: 'rgba(61,111,255,.22)', text: 'Hello' } },
    { op: 'add', shapes: [{ type: 'sticky', text: 'note' }, { type: 'text', text: 'free text' }] },
  ])
  assert.ok(r.ok, JSON.stringify(r.errors))
  assert.equal(r.shapes.length, 3)
  assert.equal(r.created.length, 3)
  const auto = r.shapes.slice(1)
  assert.ok(auto[0].y > 100 && auto[1].y > auto[0].y, 'shapes without a position are stacked below the content')
  const u = applyOps(r.shapes, [{ op: 'update', id: 'box', set: { x: 50, text: 'Changed', stroke: '#ff0000' } }])
  assert.ok(u.ok)
  assert.deepEqual(u.changed, ['box'])
  const box = byId(u.shapes).get('box')
  assert.equal(box.x, 50)
  assert.equal(box.text, 'Changed')
  assert.equal(box.y, 20, 'untouched fields stay')
  // text resize on update
  const t = auto[1]
  const u2 = applyOps(r.shapes, [{ op: 'update', id: t.id, set: { text: 'a much longer piece of text than before' } }])
  assert.ok(byId(u2.shapes).get(t.id).w > t.w)
  // batch update
  const u3 = applyOps(r.shapes, [{ op: 'update', ids: ['box', auto[0].id], set: { opacity: 0.5 } }])
  assert.equal(byId(u3.shapes).get('box').opacity, 0.5)
  assert.equal(byId(u3.shapes).get(auto[0].id).opacity, 0.5)
  const rm = applyOps(r.shapes, [{ op: 'remove', ids: ['box'] }])
  assert.deepEqual(rm.removed, ['box'])
  assert.equal(rm.shapes.length, 2)
  const cl = applyOps(r.shapes, [{ op: 'clear' }])
  assert.equal(cl.shapes.length, 0)
})

test('applyOps arrow convenience: from/to bind and route', () => {
  const base = [rect('a', 0, 0), rect('b', 300, 0)]
  const r = applyOps(base, [{ op: 'add', shape: { id: 'ar', type: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1, from: 'a', to: 'b' } }])
  assert.ok(r.ok, JSON.stringify(r.errors))
  const ar = byId(r.shapes).get('ar')
  assert.deepEqual(ar.bind, { s: 'a', e: 'b' })
  assert.ok(ar.x > 90 && ar.x + ar.w < 310)
  const bad = applyOps(base, [{ op: 'add', shape: { type: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1, from: 'a', to: 'nobody' } }])
  assert.ok(bad.ok, 'a dangling binding is cleared, not an error')
  assert.equal(bad.shapes[2].bind.e, undefined)
})

test('applyOps is atomic and reports every error', () => {
  const base = [rect('a', 0, 0)]
  const r = applyOps(base, [
    { op: 'add', shape: { type: 'rect', x: 1, y: 1 } },
    { op: 'update', id: 'ghost', set: { x: 1 } },
    { op: 'update', id: 'a', set: { stroke: 'not a colour!' } },
    { op: 'frobnicate' },
    { op: 'update', id: 'a', set: { type: 'ellipse' } },
    { op: 'add', shape: { id: 'a', type: 'rect' } },
    { op: 'remove', ids: [] },
    { op: 'update', id: 'a', set: {} },
    'junk',
  ])
  assert.equal(r.ok, false)
  assert.equal(r.shapes, base, 'nothing applied')
  assert.deepEqual(r.errors.map((e) => e.index), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.match(r.errors[0].error, /no shape ghost/)
  assert.match(r.errors[1].error, /stroke/)
  assert.match(r.errors[2].error, /op: must be one of/)
  assert.match(r.errors[3].error, /cannot change/)
  assert.match(r.errors[4].error, /already exists/)
})

test('applyOps limits', () => {
  assert.equal(applyOps([], 'nope').ok, false)
  assert.equal(applyOps([], new Array(LIMITS.ops + 1).fill({ op: 'clear' })).ok, false)
  const many = Array.from({ length: 501 }, () => ({ type: 'rect' }))
  assert.equal(applyOps([], [{ op: 'add', shapes: many }]).ok, false)
  const big = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, type: 'rect', x: i, y: 0 }))
  let shapes = []
  for (let k = 0; k < 10; k++) shapes = applyOps(shapes, [{ op: 'add', shapes: big.map((s) => ({ ...s, id: `${s.id}-${k}` })) }]).shapes
  assert.equal(shapes.length, 5000)
  const over = applyOps(shapes, [{ op: 'add', shape: { type: 'rect' } }])
  assert.equal(over.ok, false)
  assert.match(over.errors[0].error, /at most 5000 shapes/)
  const pts = Array.from({ length: LIMITS.pts + 1 }, (_, i) => [i, 0])
  assert.equal(applyOps([], [{ op: 'add', shape: { type: 'line', pts } }]).ok, false)
})

test('applyOps group / ungroup / layout / align / order', () => {
  const base = [rect('a', 0, 0), rect('b', 200, 50), rect('c', 400, 100)]
  const g = applyOps(base, [{ op: 'group', ids: ['a', 'b'], id: 'grp' }])
  assert.ok(g.ok)
  assert.deepEqual(g.shapes.filter((s) => s.g).map((s) => s.id), ['a', 'b'])
  assert.equal(applyOps(base, [{ op: 'group', ids: ['a'] }]).ok, false)
  assert.equal(applyOps(g.shapes, [{ op: 'group', ids: ['a', 'c'], id: 'grp' }]).ok, false, 'a group id must be new')
  const u = applyOps(g.shapes, [{ op: 'ungroup', id: 'grp' }])
  assert.ok(u.ok)
  assert.ok(u.shapes.every((s) => !s.g))
  const rmg = applyOps(g.shapes, [{ op: 'remove', group: 'grp' }])
  assert.deepEqual(ids(rmg.shapes), ['c'])
  const lay = applyOps(base, [{ op: 'layout', kind: 'row', gap: 10 }])
  assert.ok(lay.ok)
  assert.ok(lay.changed.length > 0)
  const al = applyOps(base, [{ op: 'align', ids: ['a', 'b', 'c'], to: 'top' }])
  assert.deepEqual(al.shapes.map((s) => s.y), [0, 0, 0])
  const ord = applyOps(base, [{ op: 'order', ids: ['a'], to: 'front' }])
  assert.deepEqual(ids(ord.shapes), ['b', 'c', 'a'])
  assert.equal(applyOps(base, [{ op: 'layout', kind: 'spiral' }]).ok, false)
  assert.equal(applyOps(base, [{ op: 'align', ids: ['a'], to: 'diagonal' }]).ok, false)
})

test('diffIds', () => {
  const a = [rect('a', 0, 0), rect('b', 0, 0)]
  const b = [{ ...a[0], x: 5 }, rect('c', 9, 9)]
  assert.deepEqual(diffIds(a, b), { added: ['c'], changed: ['a'], removed: ['b'] })
  assert.deepEqual(diffIds(a, a), { added: [], changed: [], removed: [] })
  assert.deepEqual(diffIds(a, [a[1], a[0]]).changed.sort(), ['a', 'b'])
})

test('mergeShapes: three-way by id and field', () => {
  const a = rect('a', 0, 0)
  const b = rect('b', 100, 0)
  const c = rect('c', 200, 0)
  const base = [a, b, c]
  // local moves a and adds d; remote edits b's colour, removes c, adds e
  const local = [{ ...a, x: 50 }, b, c, rect('d', 1, 1)]
  const remote = [a, { ...b, stroke: '#f00' }, rect('e', 2, 2)]
  const m = byId(mergeShapes(base, local, remote))
  assert.equal(m.get('a').x, 50)
  assert.equal(m.get('b').stroke, '#f00')
  assert.equal(m.has('c'), false)
  assert.ok(m.has('d') && m.has('e'))
  // same shape, different fields: both survive
  const both = byId(mergeShapes([a], [{ ...a, x: 9 }], [{ ...a, stroke: '#0f0' }])).get('a')
  assert.equal(both.x, 9)
  assert.equal(both.stroke, '#0f0')
  // same field changed on both sides: local wins
  assert.equal(byId(mergeShapes([a], [{ ...a, x: 9 }], [{ ...a, x: 7 }])).get('a').x, 9)
  // deleted locally, edited remotely: kept (nothing lost)
  assert.equal(byId(mergeShapes([a], [], [{ ...a, x: 7 }])).get('a').x, 7)
  // edited locally, deleted remotely: kept
  assert.equal(byId(mergeShapes([a], [{ ...a, x: 7 }], [])).get('a').x, 7)
  // deleted on both
  assert.equal(mergeShapes([a], [], []).length, 0)
  // unchanged local adopts the remote exactly
  const remoteOnly = [b, a]
  assert.deepEqual(ids(mergeShapes([a, b], [a, b], remoteOnly)), ['b', 'a'])
  // a local reorder survives when the remote did not reorder
  assert.deepEqual(ids(mergeShapes([a, b], [b, a], [a, b, c])), ['b', 'c', 'a'])
  // dangling bindings are cleaned
  const ar = parseShape({ id: 'ar', type: 'arrow', pts: [[0, 0], [1, 1]], bind: { s: 'a' } })
  assert.equal(byId(mergeShapes([a, ar], [a, ar], [ar])).get('ar').bind, undefined)
})

test('History: undo, redo, branch drop, jump, coalesce, limit', () => {
  let t = 0
  const h = new History([], { limit: 5, now: () => (t += 100) })
  const s1 = [rect('a', 0, 0)]
  const s2 = [rect('a', 0, 0), rect('b', 1, 1)]
  assert.equal(h.canUndo, false)
  assert.equal(h.commit(h.shapes, 'noop'), false, 'same array: nothing to record')
  h.commit(s1, 'Add rectangle')
  h.commit(s2, 'Add rectangle')
  assert.equal(h.shapes, s2)
  assert.equal(h.undo(), s1)
  assert.equal(h.undo().length, 0)
  assert.equal(h.undo(), null)
  assert.equal(h.redo(), s1)
  const s3 = [rect('z', 5, 5)]
  h.commit(s3, 'Draw')
  assert.equal(h.canRedo, false, 'a new edit drops the redo branch')
  assert.deepEqual(h.entries.map((e) => e.label), ['Open', 'Add rectangle', 'Draw'])
  assert.equal(h.jump(1), s1)
  assert.equal(h.jump(9), null)
  // coalescing
  h.jump(2)
  h.commit([{ ...s3[0], opacity: 0.9 }], 'Opacity', { key: 'opacity' })
  const n = h.entries.length
  h.commit([{ ...s3[0], opacity: 0.8 }], 'Opacity', { key: 'opacity' })
  assert.equal(h.entries.length, n, 'same key within the window merges')
  h.commit([{ ...s3[0], opacity: 0.7 }], 'Other', { key: 'stroke' })
  assert.equal(h.entries.length, n + 1)
  for (let i = 0; i < 10; i++) h.commit([rect(`n${i}`, i, i)], `Add ${i}`)
  assert.equal(h.entries.length, 5)
  assert.equal(h.index, 4)
})

test('fitView centres a box with padding', () => {
  const v = fitView({ x: 0, y: 0, w: 1000, h: 500 }, 800, 600, 50, 2)
  assert.ok(Math.abs(v.zoom - 0.7) < 1e-9)
  const cx = v.x + 800 / 2 / v.zoom
  assert.ok(Math.abs(cx - 500) < 1e-9)
  assert.equal(fitView({ x: 0, y: 0, w: 10, h: 10 }, 800, 600, 50, 2).zoom, 2, 'tiny content does not zoom past maxZoom')
  assert.equal(fitView(null, 800, 600).zoom, 1)
})

test('cleanBindings and emptyDoc', () => {
  const a = rect('a', 0, 0)
  const ar = parseShape({ id: 'ar', type: 'arrow', pts: [[0, 0], [1, 1]], bind: { s: 'a', e: 'gone' } })
  const out = cleanBindings([a, ar])
  assert.deepEqual(out[1].bind, { s: 'a' })
  assert.equal(cleanBindings([a]).length, 1)
  const d = emptyDoc('x', 'Name')
  assert.equal(d.shapes.length, 0)
  assert.equal(d.v, 1)
})
