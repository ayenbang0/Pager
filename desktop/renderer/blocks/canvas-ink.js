// Canvas block: freehand ink (pressure -> smooth variable-width outline), hand-drawn "wobble" paths, and the path-op list
// that both the Canvas2D painter and the SVG exporter consume. No DOM.
//
// A path is an array of ops: ['M', x, y] | ['L', x, y] | ['C', c1x, c1y, c2x, c2y, x, y] | ['Z'].

// ---------------------------------------------------------------- random

/** Small seeded PRNG (mulberry32): the same seed always wobbles the same way, so a drawing never shimmers. */
export function rng(seed) {
  let a = seed >>> 0 || 1
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------- path ops

export function pathToCanvas(ctx, ops, ox = 0, oy = 0) {
  for (const o of ops) {
    switch (o[0]) {
      case 'M': ctx.moveTo(o[1] + ox, o[2] + oy); break
      case 'L': ctx.lineTo(o[1] + ox, o[2] + oy); break
      case 'C': ctx.bezierCurveTo(o[1] + ox, o[2] + oy, o[3] + ox, o[4] + oy, o[5] + ox, o[6] + oy); break
      case 'Z': ctx.closePath(); break
    }
  }
}

const f = (n) => (Math.round(n * 100) / 100).toString()
export function pathToSvg(ops, ox = 0, oy = 0) {
  let d = ''
  for (const o of ops) {
    if (o[0] === 'M' || o[0] === 'L') d += `${o[0]}${f(o[1] + ox)} ${f(o[2] + oy)}`
    else if (o[0] === 'C') d += `C${f(o[1] + ox)} ${f(o[2] + oy)} ${f(o[3] + ox)} ${f(o[4] + oy)} ${f(o[5] + ox)} ${f(o[6] + oy)}`
    else d += 'Z'
  }
  return d
}

const K = 0.5522847498

export function rectPath(w, h, r = 0) {
  r = Math.min(r, w / 2, h / 2)
  if (r <= 0.5) return [['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']]
  const k = r * (1 - K)
  return [
    ['M', r, 0], ['L', w - r, 0], ['C', w - k, 0, w, k, w, r], ['L', w, h - r], ['C', w, h - k, w - k, h, w - r, h],
    ['L', r, h], ['C', k, h, 0, h - k, 0, h - r], ['L', 0, r], ['C', 0, k, k, 0, r, 0], ['Z'],
  ]
}

export function ellipsePath(w, h) {
  const rx = w / 2
  const ry = h / 2
  const kx = rx * K
  const ky = ry * K
  return [
    ['M', rx * 2, ry], ['C', rx * 2, ry + ky, rx + kx, ry * 2, rx, ry * 2], ['C', rx - kx, ry * 2, 0, ry + ky, 0, ry],
    ['C', 0, ry - ky, rx - kx, 0, rx, 0], ['C', rx + kx, 0, rx * 2, ry - ky, rx * 2, ry], ['Z'],
  ]
}

export const diamondPath = (w, h) => [['M', w / 2, 0], ['L', w, h / 2], ['L', w / 2, h], ['L', 0, h / 2], ['Z']]

export function circlePath(cx, cy, r) {
  const k = r * K
  return [
    ['M', cx + r, cy], ['C', cx + r, cy + k, cx + k, cy + r, cx, cy + r], ['C', cx - k, cy + r, cx - r, cy + k, cx - r, cy],
    ['C', cx - r, cy - k, cx - k, cy - r, cx, cy - r], ['C', cx + k, cy - r, cx + r, cy - k, cx + r, cy], ['Z'],
  ]
}

/** The shape outline path in the shape's own frame (0..w, 0..h). */
export function shapeOutline(s) {
  if (s.type === 'ellipse') return ellipsePath(s.w, s.h)
  if (s.type === 'diamond') return diamondPath(s.w, s.h)
  return rectPath(s.w, s.h, s.type === 'rect' && s.round ? Math.min(18, Math.min(s.w, s.h) * 0.2) : s.type === 'sticky' ? 3 : 0)
}

// ---------------------------------------------------------------- hand-drawn wobble

const rnd = (r, span) => (r() - 0.5) * 2 * span

/** One wobbly cubic from (x1,y1) to (x2,y2): jittered ends, bowed middle. */
function wobbleSegment(r, x1, y1, x2, y2, amount) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const off = Math.min(2.4, 0.5 + len * 0.006) * amount
  const nx = -dy / len
  const ny = dx / len
  const j = () => rnd(r, off * 0.7)
  const a = [x1 + j(), y1 + j()]
  const b = [x2 + j(), y2 + j()]
  const bow1 = rnd(r, off)
  const bow2 = rnd(r, off)
  return {
    a, b,
    c1: [x1 + dx / 3 + nx * bow1 + j() * 0.3, y1 + dy / 3 + ny * bow1 + j() * 0.3],
    c2: [x1 + (2 * dx) / 3 + nx * bow2 + j() * 0.3, y1 + (2 * dy) / 3 + ny * bow2 + j() * 0.3],
  }
}

function wobblePolyline(r, pts, closed, amount) {
  const ops = []
  const n = closed ? pts.length : pts.length - 1
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    const g = wobbleSegment(r, p[0], p[1], q[0], q[1], amount)
    ops.push(['M', g.a[0], g.a[1]], ['C', g.c1[0], g.c1[1], g.c2[0], g.c2[1], g.b[0], g.b[1]])
  }
  return ops
}

/** Catmull-Rom through points as cubic beziers (open curve). */
function spline(pts) {
  const ops = [['M', pts[0][0], pts[0][1]]]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    ops.push(['C', p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]])
  }
  return ops
}

function wobbleEllipse(r, w, h, amount) {
  const rx = w / 2
  const ry = h / 2
  const n = Math.max(9, Math.min(28, Math.round((rx + ry) / 7)))
  const start = r() * Math.PI * 2
  const j = Math.min(2.6, 0.7 + (rx + ry) * 0.01) * amount
  const pts = []
  // 1.1 turns: the stroke overshoots where it began, the way a pen circle does
  const steps = Math.round(n * 1.1)
  for (let i = 0; i <= steps; i++) {
    const a = start + (i / n) * Math.PI * 2
    pts.push([rx + (rx + rnd(r, j)) * Math.cos(a), ry + (ry + rnd(r, j)) * Math.sin(a)])
  }
  return pts
}

/**
 * The stroke paths of a hand-drawn shape in its own frame: two slightly different passes. `fill` is a closed path matching
 * the first pass, for the fill colour.
 */
export function roughShape(s, w = s.w, h = s.h) {
  const r = rng(s.seed)
  const amount = Math.max(0.5, Math.min(1.8, 0.8 + (s.sw || 2) * 0.12))
  if (s.type === 'ellipse') {
    const p1 = wobbleEllipse(r, w, h, amount)
    const p2 = wobbleEllipse(r, w, h, amount * 1.2)
    const fill = spline(p1.slice(0, Math.round((p1.length - 1) / 1.1) + 1))
    fill.push(['Z'])
    return { strokes: [spline(p1), spline(p2)], fill }
  }
  const corners = s.type === 'diamond' ? [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]] : [[0, 0], [w, 0], [w, h], [0, h]]
  const jit = Math.min(3, 0.8 + (w + h) * 0.004) * amount
  const c1 = corners.map(([x, y]) => [x + rnd(r, jit), y + rnd(r, jit)])
  const fill = [['M', c1[0][0], c1[0][1]], ...c1.slice(1).map((p) => ['L', p[0], p[1]]), ['Z']]
  return { strokes: [wobblePolyline(r, c1, true, amount), wobblePolyline(r, corners, true, amount * 1.15)], fill }
}

/** A wobbly open polyline (hand-drawn lines and arrows). */
export function roughLine(pts, seed, sw = 2) {
  const r = rng(seed)
  const amount = Math.max(0.5, Math.min(1.8, 0.8 + sw * 0.12))
  return [wobblePolyline(r, pts, false, amount), wobblePolyline(r, pts, false, amount * 1.2)]
}

// ---------------------------------------------------------------- arrowheads

export const headSize = (sw) => Math.max(9, 7 + (sw || 2) * 2.4)

/** Head of a line ending at (x, y) pointing along (ux, uy). Returns { ops, fill }. */
export function headPath(kind, x, y, ux, uy, sw) {
  const L = headSize(sw)
  const nx = -uy
  const ny = ux
  if (kind === 'dot') return { ops: circlePath(x - ux * L * 0.3, y - uy * L * 0.3, L * 0.32), fill: true }
  if (kind === 'bar') return { ops: [['M', x + nx * L * 0.5, y + ny * L * 0.5], ['L', x - nx * L * 0.5, y - ny * L * 0.5]], fill: false }
  const spread = kind === 'triangle' ? 0.42 : 0.5
  const bx = x - ux * L
  const by = y - uy * L
  const ops = [['M', bx + nx * L * spread, by + ny * L * spread], ['L', x, y], ['L', bx - nx * L * spread, by - ny * L * spread]]
  if (kind === 'triangle') ops.push(['Z'])
  return { ops, fill: kind === 'triangle' }
}

export function dashArray(dash, sw) {
  const w = Math.max(1, sw || 2)
  if (dash === 'dashed') return [w * 3 + 5, w * 2 + 5]
  if (dash === 'dotted') return [0.01, w * 2 + 3]
  return []
}

// ---------------------------------------------------------------- ink

/**
 * Fake a pressure for devices that report none (mouse): slower strokes are thicker. `samples` are [x, y, t(ms)] and the
 * result [x, y, pressure 0..1].
 */
export function simulatePressure(samples) {
  const out = []
  let p = 0.55
  for (let i = 0; i < samples.length; i++) {
    const [x, y, t] = samples[i]
    if (i > 0) {
      const q = samples[i - 1]
      const speed = Math.hypot(x - q[0], y - q[1]) / Math.max(1, t - q[2]) // px per ms
      const target = Math.max(0.25, Math.min(0.9, 0.95 - speed * 0.45))
      p += (target - p) * 0.18
    }
    out.push([x, y, p])
  }
  return out
}

function dedupe(pts, minDist) {
  const out = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= minDist) out.push(p)
  }
  if (out.length > 1 && pts.length > 1) {
    const last = pts[pts.length - 1]
    if (out[out.length - 1] !== last) out[out.length - 1] = last
  }
  return out
}

/** Smooth the pressure channel (two-way exponential average: no lag, no spikes). */
export function smoothPressure(pts, k = 0.35) {
  const n = pts.length
  const p = pts.map((q) => (q.length > 2 ? q[2] : 0.5))
  for (let i = 1; i < n; i++) p[i] = p[i - 1] + (p[i] - p[i - 1]) * k
  for (let i = n - 2; i >= 0; i--) p[i] = p[i + 1] + (p[i] - p[i + 1]) * k
  return p
}

/** Ramer-Douglas-Peucker thinning that keeps each kept point's pressure. */
export function simplifyInk(pts, eps = 0.4) {
  if (pts.length < 3) return pts.slice()
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    let max = 0
    let idx = -1
    const [x1, y1] = pts[a]
    const [x2, y2] = pts[b]
    const dx = x2 - x1
    const dy = y2 - y1
    const l2 = dx * dx + dy * dy
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]
      let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
      if (d > max) (max = d), (idx = i)
    }
    if (max > eps && idx > 0) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/**
 * The filled outline of a pressure stroke: a closed polygon (array of [x, y]) around a smoothed centre line whose half-width
 * follows the pressure, with tapered round ends. `width` is the nominal stroke width (the shape's `sw`).
 */
export function inkOutline(pts, width = 3) {
  const src = dedupe(pts, 0.3)
  if (!src.length) return []
  const base = width / 2
  if (src.length === 1) {
    const r = base * (0.5 + (src[0][2] ?? 0.5))
    const poly = []
    for (let i = 0; i < 14; i++) poly.push([src[0][0] + Math.cos((i / 14) * Math.PI * 2) * r, src[0][1] + Math.sin((i / 14) * Math.PI * 2) * r])
    return poly
  }
  const pr = smoothPressure(src)
  // arc length for the end tapers
  const acc = [0]
  for (let i = 1; i < src.length; i++) acc.push(acc[i - 1] + Math.hypot(src[i][0] - src[i - 1][0], src[i][1] - src[i - 1][1]))
  const total = acc[acc.length - 1]
  const taper = Math.min(width * 3, total / 2.5)
  const radius = (i) => {
    let r = base * (0.35 + 1.25 * pr[i])
    if (taper > 0) {
      const e = Math.min(acc[i], total - acc[i]) / taper
      if (e < 1) r *= 0.35 + 0.65 * Math.max(0, e)
    }
    return Math.max(0.35, r)
  }
  // densify with Catmull-Rom so corners are round and the outline has no facets
  const C = []
  const R = []
  for (let i = 0; i < src.length - 1; i++) {
    const p0 = src[Math.max(0, i - 1)]
    const p1 = src[i]
    const p2 = src[i + 1]
    const p3 = src[Math.min(src.length - 1, i + 2)]
    const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const n = Math.max(1, Math.min(12, Math.ceil(d / 2)))
    const r1 = radius(i)
    const r2 = radius(i + 1)
    for (let k = 0; k < n; k++) {
      const t = k / n
      const t2 = t * t
      const t3 = t2 * t
      C.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ])
      R.push(r1 + (r2 - r1) * t)
    }
  }
  C.push([src[src.length - 1][0], src[src.length - 1][1]])
  R.push(radius(src.length - 1))
  const left = []
  const right = []
  for (let i = 0; i < C.length; i++) {
    const a = C[Math.max(0, i - 1)]
    const b = C[Math.min(C.length - 1, i + 1)]
    let tx = b[0] - a[0]
    let ty = b[1] - a[1]
    const l = Math.hypot(tx, ty) || 1
    tx /= l
    ty /= l
    left.push([C[i][0] - ty * R[i], C[i][1] + tx * R[i]])
    right.push([C[i][0] + ty * R[i], C[i][1] - tx * R[i]])
  }
  const cap = (c, r, from) => {
    const out = []
    for (let i = 1; i < 7; i++) {
      const a = from + (i / 7) * Math.PI
      out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r])
    }
    return out
  }
  const n = C.length
  const aEnd = Math.atan2(C[n - 1][1] - C[n - 2 >= 0 ? n - 2 : 0][1], C[n - 1][0] - C[n - 2 >= 0 ? n - 2 : 0][0])
  const aStart = Math.atan2(C[0][1] - C[1][1], C[0][0] - C[1][0])
  return [
    ...left,
    ...cap(C[n - 1], R[n - 1], aEnd - Math.PI / 2),
    ...right.reverse(),
    ...cap(C[0], R[0], aStart - Math.PI / 2),
  ]
}

/** A closed polygon as a smooth path (quadratics through edge midpoints). */
export function smoothClosedPath(poly) {
  const n = poly.length
  if (n < 3) return []
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const ops = []
  const m0 = mid(poly[n - 1], poly[0])
  ops.push(['M', m0[0], m0[1]])
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const m = mid(p, poly[(i + 1) % n])
    // quadratic -> cubic
    const prev = ops[ops.length - 1]
    const sx = prev[prev.length - 2]
    const sy = prev[prev.length - 1]
    ops.push(['C', sx + (2 / 3) * (p[0] - sx), sy + (2 / 3) * (p[1] - sy), m[0] + (2 / 3) * (p[0] - m[0]), m[1] + (2 / 3) * (p[1] - m[1]), m[0], m[1]])
  }
  ops.push(['Z'])
  return ops
}
