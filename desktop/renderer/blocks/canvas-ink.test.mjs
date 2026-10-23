import test from 'node:test'
import assert from 'node:assert/strict'
import {
  circlePath, dashArray, diamondPath, ellipsePath, headPath, inkOutline, pathToSvg, rectPath, rng, roughLine, roughShape, shapeOutline,
  simplifyInk, simulatePressure, smoothClosedPath, smoothPressure,
} from './canvas-ink.js'

const width = (poly, x) => {
  // vertical extent of the polygon at (nearly) a given x
  const ys = poly.filter((p) => Math.abs(p[0] - x) < 2.5).map((p) => p[1])
  return ys.length ? Math.max(...ys) - Math.min(...ys) : 0
}
const finite = (poly) => poly.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))

test('rng is deterministic per seed and spread over [0,1)', () => {
  const a = rng(42)
  const b = rng(42)
  const seq = Array.from({ length: 5 }, () => a())
  assert.deepEqual(seq, Array.from({ length: 5 }, () => b()))
  assert.notDeepEqual(seq, Array.from({ length: 5 }, ((r) => () => r())(rng(43))))
  assert.ok(seq.every((v) => v >= 0 && v < 1))
})

test('inkOutline: closed polygon wider where the pressure is higher', () => {
  const pts = []
  for (let x = 0; x <= 200; x += 4) pts.push([x, 0, x < 100 ? 0.15 : 0.95])
  const poly = inkOutline(pts, 8)
  assert.ok(poly.length > 40 && finite(poly))
  const thin = width(poly, 50)
  const thick = width(poly, 150)
  assert.ok(thick > thin * 2, `thick ${thick} vs thin ${thin}`)
  // the ends are tapered
  assert.ok(width(poly, 2) < thick)
  // the polygon stays around the stroke
  const ys = poly.map((p) => p[1])
  assert.ok(Math.max(...ys) < 12 && Math.min(...ys) > -12)
})

test('inkOutline: one point makes a dot, none makes nothing, duplicates collapse', () => {
  const dot = inkOutline([[10, 10, 0.5]], 6)
  assert.equal(dot.length, 14)
  assert.ok(dot.every((p) => Math.hypot(p[0] - 10, p[1] - 10) < 6))
  assert.deepEqual(inkOutline([], 6), [])
  const dup = inkOutline([[0, 0, 0.5], [0, 0, 0.5], [0, 0.1, 0.5]], 6)
  assert.ok(dup.length > 0 && finite(dup))
})

test('inkOutline follows a curve without facets: dense, finite, smooth', () => {
  const pts = []
  for (let i = 0; i <= 40; i++) pts.push([100 + Math.cos(i / 6) * 80, 100 + Math.sin(i / 6) * 80, 0.5])
  const poly = inkOutline(pts, 4)
  assert.ok(poly.length > pts.length * 2)
  assert.ok(finite(poly))
  const path = smoothClosedPath(poly)
  assert.equal(path[0][0], 'M')
  assert.equal(path[path.length - 1][0], 'Z')
  assert.ok(path.slice(1, -1).every((o) => o[0] === 'C' && o.length === 7))
})

test('smoothPressure removes spikes without lag at the ends', () => {
  const p = smoothPressure([[0, 0, 0.1], [1, 0, 0.1], [2, 0, 1], [3, 0, 0.1], [4, 0, 0.1]])
  assert.ok(p[2] < 0.5, 'the spike is damped')
  assert.ok(p[0] > 0.05 && p[0] < 0.4)
  assert.deepEqual(smoothPressure([[0, 0]]), [0.5], 'no pressure channel: neutral')
})

test('simulatePressure: fast strokes are thinner than slow ones', () => {
  const slow = []
  const fast = []
  for (let i = 0; i < 40; i++) {
    slow.push([i * 0.5, 0, i * 16])
    fast.push([i * 12, 0, i * 16])
  }
  const s = simulatePressure(slow)
  const f = simulatePressure(fast)
  assert.ok(s[39][2] > f[39][2] + 0.2, `${s[39][2]} vs ${f[39][2]}`)
  assert.ok(s.every((p) => p[2] >= 0.25 && p[2] <= 0.9))
})

test('simplifyInk keeps the ends and the shape, drops collinear points, keeps pressure', () => {
  const line = Array.from({ length: 50 }, (_, i) => [i, i * 0.001, i / 50])
  const out = simplifyInk(line, 0.4)
  assert.equal(out.length, 2)
  assert.equal(out[0], line[0])
  assert.equal(out[1], line[49])
  const zig = [[0, 0, 0.5], [10, 10, 0.7], [20, 0, 0.9], [30, 10, 0.5]]
  assert.deepEqual(simplifyInk(zig, 0.4), zig)
  assert.deepEqual(simplifyInk([[0, 0, 0.5], [1, 1, 0.5]]), [[0, 0, 0.5], [1, 1, 0.5]])
})

test('hand-drawn shapes wobble per seed, deterministically', () => {
  const s = { type: 'rect', w: 200, h: 100, seed: 7, sw: 2 }
  const a = roughShape(s)
  const b = roughShape(s)
  assert.deepEqual(a, b)
  assert.notDeepEqual(a.strokes, roughShape({ ...s, seed: 8 }).strokes)
  assert.equal(a.strokes.length, 2, 'two passes')
  // the wobble is small: every point stays near the real outline
  const pts = a.strokes[0].flatMap((o) => (o[0] === 'M' ? [[o[1], o[2]]] : [[o[5], o[6]]]))
  assert.ok(pts.every(([x, y]) => x > -6 && x < 206 && y > -6 && y < 106))
  assert.notDeepEqual(pts.slice(0, 2), [[0, 0], [200, 0]])
  const e = roughShape({ type: 'ellipse', w: 160, h: 90, seed: 3, sw: 2 })
  assert.equal(e.strokes.length, 2)
  assert.equal(e.fill[e.fill.length - 1][0], 'Z')
  assert.ok(e.strokes[0].every((o) => o.slice(1).every(Number.isFinite)))
  const d = roughShape({ type: 'diamond', w: 100, h: 100, seed: 1, sw: 2 })
  assert.equal(d.strokes[0].filter((o) => o[0] === 'C').length, 4)
  const l = roughLine([[0, 0], [100, 50], [200, 0]], 5, 2)
  assert.equal(l.length, 2)
  assert.equal(l[0].filter((o) => o[0] === 'C').length, 2)
})

test('clean shape paths close and use the frame', () => {
  const r = rectPath(100, 50, 0)
  assert.equal(r.length, 5)
  assert.deepEqual(r[2], ['L', 100, 50])
  const rr = rectPath(100, 50, 10)
  assert.ok(rr.some((o) => o[0] === 'C'))
  assert.equal(rr[rr.length - 1][0], 'Z')
  const rClamped = rectPath(20, 20, 99)
  assert.ok(rClamped.every((o) => o.slice(1).every((n) => n >= 0 && n <= 20)))
  assert.deepEqual(diamondPath(10, 20)[0], ['M', 5, 0])
  assert.equal(ellipsePath(100, 40).filter((o) => o[0] === 'C').length, 4)
  assert.equal(circlePath(0, 0, 5)[0][1], 5)
  assert.equal(shapeOutline({ type: 'rect', w: 100, h: 50, round: true }).some((o) => o[0] === 'C'), true)
  assert.equal(shapeOutline({ type: 'rect', w: 100, h: 50, round: false }).length, 5)
})

test('pathToSvg writes compact commands', () => {
  assert.equal(pathToSvg([['M', 1, 2], ['L', 3.456, 4], ['C', 1, 2, 3, 4, 5, 6], ['Z']]), 'M1 2L3.46 4C1 2 3 4 5 6Z')
  assert.equal(pathToSvg([['M', 0, 0]], 10, 20), 'M10 20')
})

test('arrowheads point along the line, dashes scale with the width', () => {
  const a = headPath('arrow', 100, 0, 1, 0, 2)
  assert.equal(a.fill, false)
  assert.deepEqual(a.ops[1].slice(1), [100, 0])
  assert.ok(a.ops[0][1] < 100 && a.ops[2][1] < 100)
  assert.equal(a.ops[0][2], -a.ops[2][2])
  const t = headPath('triangle', 0, 0, 0, 1, 2)
  assert.equal(t.fill, true)
  assert.equal(t.ops[t.ops.length - 1][0], 'Z')
  assert.equal(headPath('dot', 0, 0, 1, 0, 2).fill, true)
  assert.equal(headPath('bar', 0, 0, 1, 0, 2).ops.length, 2)
  assert.deepEqual(dashArray('solid', 2), [])
  assert.equal(dashArray('dashed', 2).length, 2)
  assert.ok(dashArray('dashed', 6)[0] > dashArray('dashed', 2)[0])
  assert.ok(dashArray('dotted', 2)[0] < 1)
})
