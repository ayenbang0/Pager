import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bindTargetAt, handleAt, handleCursor, handlePoint, hitAll, hitShape, hitTest, resizeFrame, rotationFrom, selectionFrame, shapesInRect,
  snapAngle, snapGrid, snapMove,
} from './canvas-hit.js'
import { parseShape } from './canvas-model.js'
import { centerOf, rotate } from './canvas-geom.js'

const mk = (raw) => parseShape({ id: raw.id || 'x', ...raw })
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`)

test('rect: unfilled is hit on its outline only, filled inside too', () => {
  const r = mk({ type: 'rect', x: 0, y: 0, w: 100, h: 60 })
  assert.ok(hitShape(r, 0, 30, 4))
  assert.ok(hitShape(r, 50, 0, 4))
  assert.ok(!hitShape(r, 50, 30, 4), 'the empty middle')
  assert.ok(!hitShape(r, 120, 30, 4))
  const f = mk({ type: 'rect', x: 0, y: 0, w: 100, h: 60, fill: '#abc' })
  assert.ok(hitShape(f, 50, 30, 4))
  const labelled = mk({ type: 'rect', x: 0, y: 0, w: 100, h: 60, text: 'hi' })
  assert.ok(hitShape(labelled, 50, 30, 4), 'a shape with a label is grabbed by its middle')
})

test('rotated shapes are hit in their own frame', () => {
  const r = mk({ type: 'rect', x: 0, y: 0, w: 200, h: 20, fill: '#abc', angle: Math.PI / 2 })
  // rotated 90 degrees about (100, 10): occupies x in [90,110], y in [-90,110]
  assert.ok(hitShape(r, 100, 100, 1))
  assert.ok(!hitShape(r, 190, 10, 1))
  assert.ok(hitShape(r, 100, -80, 1))
})

test('ellipse and diamond', () => {
  const e = mk({ type: 'ellipse', x: 0, y: 0, w: 200, h: 100, fill: '#abc' })
  assert.ok(hitShape(e, 100, 50, 2))
  assert.ok(!hitShape(e, 5, 5, 2), 'the bounding-box corner is outside the ellipse')
  assert.ok(hitShape(e, 199, 50, 2))
  const e2 = mk({ type: 'ellipse', x: 0, y: 0, w: 200, h: 100 })
  assert.ok(!hitShape(e2, 100, 50, 2), 'unfilled interior')
  assert.ok(hitShape(e2, 100, 0, 2))
  const d = mk({ type: 'diamond', x: 0, y: 0, w: 100, h: 100, fill: '#abc' })
  assert.ok(hitShape(d, 50, 50, 2))
  assert.ok(!hitShape(d, 5, 5, 2))
  assert.ok(hitShape(d, 50, 0, 2))
  const d2 = mk({ type: 'diamond', x: 0, y: 0, w: 100, h: 100 })
  assert.ok(!hitShape(d2, 50, 50, 2))
  assert.ok(hitShape(d2, 75, 25, 2), 'on the edge')
})

test('lines, arrows (also bent) and ink are hit near their stroke', () => {
  const l = mk({ type: 'line', pts: [[0, 0], [100, 0]], x: 0, y: 0 })
  assert.ok(hitShape(l, 50, 3, 4))
  assert.ok(!hitShape(l, 50, 20, 4))
  const bent = mk({ type: 'arrow', pts: [[0, 0], [100, 0]], x: 0, y: 0, bend: 0.5 })
  // control point at (50, 50): the curve passes through (50, 25)
  assert.ok(hitShape(bent, 50, 25, 3))
  assert.ok(!hitShape(bent, 50, 0, 3), 'the chord is not on a bent arrow')
  const ink = mk({ type: 'ink', pts: [[0, 0, 0.5], [50, 50, 0.5], [100, 0, 0.5]], x: 10, y: 10 })
  assert.ok(hitShape(ink, 35, 35, 3))
  assert.ok(!hitShape(ink, 60, 10, 3))
})

test('text, sticky and image are hit anywhere in their box', () => {
  for (const raw of [{ type: 'text', text: 'abc' }, { type: 'sticky' }, { type: 'image', hash: 'a'.repeat(32), w: 50, h: 40 }]) {
    const s = mk({ ...raw, x: 10, y: 10 })
    assert.ok(hitShape(s, s.x + s.w / 2, s.y + s.h / 2, 2), raw.type)
    assert.ok(!hitShape(s, s.x + s.w + 30, s.y, 2), raw.type)
  }
})

test('hitTest picks the topmost, skips locked, hitAll returns every hit', () => {
  const a = mk({ id: 'a', type: 'rect', x: 0, y: 0, w: 100, h: 100, fill: '#111' })
  const b = mk({ id: 'b', type: 'rect', x: 50, y: 50, w: 100, h: 100, fill: '#222' })
  assert.equal(hitTest([a, b], 75, 75).id, 'b')
  assert.equal(hitTest([b, a], 75, 75).id, 'a')
  assert.equal(hitTest([a, { ...b, locked: true }], 75, 75).id, 'a')
  assert.equal(hitTest([a, { ...b, locked: true }], 75, 75, 4, null).id, 'b')
  assert.equal(hitTest([a, b], 500, 500), null)
  assert.deepEqual(hitAll([a, b], 75, 75).map((s) => s.id), ['a', 'b'])
})

test('marquee: contain vs touch', () => {
  const a = mk({ id: 'a', type: 'rect', x: 0, y: 0, w: 50, h: 50 })
  const b = mk({ id: 'b', type: 'rect', x: 40, y: 40, w: 100, h: 100 })
  const c = mk({ id: 'c', type: 'rect', x: 500, y: 500, w: 10, h: 10, locked: true })
  const rect = { x: -10, y: -10, w: 70, h: 70 }
  assert.deepEqual(shapesInRect([a, b, c], rect, 'contain').map((s) => s.id), ['a'])
  assert.deepEqual(shapesInRect([a, b, c], rect, 'touch').map((s) => s.id), ['a', 'b'])
  assert.deepEqual(shapesInRect([a, b, c], { x: 0, y: 0, w: 1000, h: 1000 }, 'touch').map((s) => s.id), ['a', 'b'], 'locked shapes are not marquee-selected')
})

test('selection frame: own frame for one box shape, union for many', () => {
  const a = mk({ id: 'a', type: 'rect', x: 10, y: 20, w: 100, h: 50, angle: 0.5 })
  const b = mk({ id: 'b', type: 'rect', x: 200, y: 0, w: 10, h: 10 })
  assert.deepEqual(selectionFrame([a]), { x: 10, y: 20, w: 100, h: 50, angle: 0.5 })
  const u = selectionFrame([a, b])
  assert.equal(u.angle, 0)
  assert.ok(u.w > 200)
  assert.equal(selectionFrame([]), null)
  const ln = mk({ type: 'line', pts: [[0, 0], [10, 10]], x: 5, y: 5 })
  assert.equal(selectionFrame([ln]).angle, 0)
})

test('handles: corners, edges, rotation and cursors', () => {
  const frame = { x: 0, y: 0, w: 200, h: 100, angle: 0 }
  assert.equal(handleAt(frame, 0, 0, 1), 'nw')
  assert.equal(handleAt(frame, 200, 100, 1), 'se')
  assert.equal(handleAt(frame, 100, 0, 1), 'n')
  assert.equal(handleAt(frame, 100, 50, 1), null)
  const [rx, ry] = handlePoint(frame, 'rot', 1)
  assert.equal(handleAt(frame, rx, ry, 1), 'rot')
  assert.equal(handleAt(frame, 100, 0, 1, { edges: false }), null)
  assert.equal(handleAt({ x: 0, y: 0, w: 30, h: 30, angle: 0 }, 15, 0, 1), null, 'small frames only offer corners')
  const turned = { ...frame, angle: Math.PI / 2 }
  const [px, py] = handlePoint(turned, 'nw')
  assert.equal(handleAt(turned, px, py, 1), 'nw')
  assert.equal(handleCursor('n'), 'ns-resize')
  assert.equal(handleCursor('se'), 'nwse-resize')
  assert.equal(handleCursor('e', Math.PI / 2), 'ns-resize')
  assert.equal(handleCursor('rot'), 'grab')
  // handle radius is in screen pixels: at zoom 4 it covers a quarter of the world distance
  assert.equal(handleAt(frame, 2, 0, 4), 'nw')
  assert.equal(handleAt(frame, 5, 0, 4), null)
})

test('resizeFrame: opposite corner stays fixed', () => {
  const f = { x: 10, y: 20, w: 100, h: 50, angle: 0 }
  const se = resizeFrame(f, 'se', 210, 120)
  assert.deepEqual(se, { x: 10, y: 20, w: 200, h: 100 })
  const nw = resizeFrame(f, 'nw', 0, 0)
  near(nw.x + nw.w, 110)
  near(nw.y + nw.h, 70)
  assert.deepEqual([nw.x, nw.y], [0, 0])
  const e = resizeFrame(f, 'e', 310, 999)
  assert.deepEqual(e, { x: 10, y: 20, w: 300, h: 50 })
  const ratio = resizeFrame(f, 'se', 210, 70, { keepRatio: true })
  near(ratio.w / ratio.h, 2)
  const centre = resizeFrame(f, 'e', 160, 0, { center: true })
  near(centre.x + centre.w / 2, 60)
  near(centre.w, 200)
  const tiny = resizeFrame(f, 'se', 0, 0, { min: 4 })
  assert.equal(tiny.w, 4)
  assert.equal(tiny.h, 4)
})

test('resizeFrame on a rotated frame keeps the anchored corner in place', () => {
  const f = { x: 0, y: 0, w: 100, h: 60, angle: Math.PI / 6 }
  const c0 = centerOf(f)
  const anchor = rotate(0, 0, c0[0], c0[1], f.angle) // nw corner in world space
  const drag = rotate(100, 60, c0[0], c0[1], f.angle) // se handle
  const out = resizeFrame(f, 'se', drag[0] + 40 * Math.cos(f.angle), drag[1] + 40 * Math.sin(f.angle))
  near(out.w, 140, 1e-6)
  near(out.h, 60, 1e-6)
  const c1 = [out.x + out.w / 2, out.y + out.h / 2]
  const anchor2 = rotate(out.x, out.y, c1[0], c1[1], f.angle)
  near(anchor2[0], anchor[0], 1e-6)
  near(anchor2[1], anchor[1], 1e-6)
})

test('rotationFrom and snapAngle', () => {
  const f = { x: 0, y: 0, w: 100, h: 100, angle: 0 }
  near(rotationFrom(f, 50, -100), 0)
  near(rotationFrom(f, 200, 50), Math.PI / 2)
  near(rotationFrom(f, 200, 45, Math.PI / 12), Math.PI / 2)
  const [x, y] = snapAngle(0, 0, 100, 3)
  near(x, Math.hypot(100, 3) * Math.cos(0), 1e-9)
  near(y, 0, 1e-9)
})

test('snapMove snaps to neighbours and the grid, and reports guides', () => {
  const others = [{ x: 200, y: 0, w: 100, h: 100 }]
  const s = snapMove({ x: 95, y: 3, w: 100, h: 50 }, others, { threshold: 6 })
  assert.equal(s.dx, 5, 'right edge snaps to the neighbour left edge')
  assert.equal(s.dy, -3, 'top edges align')
  assert.ok(s.guides.some((g) => g.axis === 'x' && g.pos === 200))
  assert.ok(s.guides.some((g) => g.axis === 'y' && g.pos === 0))
  const far = snapMove({ x: 20, y: 300, w: 10, h: 10 }, others, { threshold: 6 })
  assert.deepEqual([far.dx, far.dy, far.guides.length], [0, 0, 0])
  const grid = snapMove({ x: 13, y: 27, w: 10, h: 10 }, [], { grid: 24 })
  assert.deepEqual([grid.dx, grid.dy], [11, -3])
  const mix = snapMove({ x: 197, y: 301, w: 10, h: 10 }, others, { threshold: 6, grid: 24 })
  assert.equal(mix.dx, -2, 'object snap wins on its axis (centre to neighbour edge is the nearest)')
  assert.equal(mix.dy, 11, 'grid snap on the other')
  assert.equal(snapGrid(13, 12), 12)
  assert.equal(snapGrid(13, 0), 13)
})

test('bindTargetAt', () => {
  const a = mk({ id: 'a', type: 'rect', x: 0, y: 0, w: 100, h: 100 })
  const e = mk({ id: 'e', type: 'ellipse', x: 200, y: 0, w: 100, h: 100 })
  const ink = mk({ id: 'i', type: 'ink', pts: [[0, 0, 0.5]], x: 0, y: 0 })
  assert.equal(bindTargetAt([a, e], 50, 50, null).id, 'a')
  assert.equal(bindTargetAt([a, e], 250, 50, null).id, 'e')
  assert.equal(bindTargetAt([a, e], 203, 3, null), null, 'the ellipse bounding-box corner is empty')
  assert.equal(bindTargetAt([a, e], 50, 50, new Set(['a'])), null, 'excluded')
  assert.equal(bindTargetAt([ink], 0, 0, null), null, 'ink cannot be bound')
  assert.equal(bindTargetAt([a], 104, 50, null, 6).id, 'a', 'a few pixels outside still binds')
})
