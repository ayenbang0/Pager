// Canvas block: pure geometry (no DOM). Shapes are plain immutable objects; this file only reads them.
//   box shapes (rect, ellipse, diamond, sticky, text, image): x, y, w, h, angle (radians, about the centre)
//   poly shapes (line, arrow, ink): x, y = origin; pts = [[dx, dy, pressure?], ...] relative to it; w, h = bounds of pts; angle is 0
// Everything is in world units; zoom is only a parameter where a screen-sized tolerance matters.

export const TAU = Math.PI * 2
export const BOX_TYPES = new Set(['rect', 'ellipse', 'diamond', 'sticky', 'text', 'image'])
export const POLY_TYPES = new Set(['line', 'arrow', 'ink'])
/** Shapes an arrow can attach to. */
export const BINDABLE = new Set(['rect', 'ellipse', 'diamond', 'sticky', 'text', 'image'])

export const isPoly = (s) => POLY_TYPES.has(s.type)
export const isBox = (s) => BOX_TYPES.has(s.type)

export function rotate(px, py, cx, cy, a) {
  if (!a) return [px, py]
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dx = px - cx
  const dy = py - cy
  return [cx + dx * c - dy * s, cy + dx * s + dy * c]
}

export const centerOf = (s) => [s.x + s.w / 2, s.y + s.h / 2]

/** World point -> the shape's own unrotated frame (same origin as x, y). */
export function toLocal(s, wx, wy) {
  if (!s.angle) return [wx, wy]
  const [cx, cy] = centerOf(s)
  return rotate(wx, wy, cx, cy, -s.angle)
}

export function corners(s) {
  const pts = [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]]
  if (!s.angle) return pts
  const [cx, cy] = centerOf(s)
  return pts.map(([x, y]) => rotate(x, y, cx, cy, s.angle))
}

/** Axis-aligned world bounds of a shape (rotation applied, stroke excluded). */
export function aabb(s) {
  if (!s.angle || isPoly(s)) return { x: s.x, y: s.y, w: s.w, h: s.h }
  const c = corners(s)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of c) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Bounds including the stroke (and a bent arrow's bulge): what viewport culling and export use. */
export function paintBounds(s) {
  const b = aabb(s)
  let pad = (s.sw || 0) / 2 + 1
  if (s.type === 'arrow' || s.type === 'line') pad += 10 + (s.sw || 2) * 2.5 // arrowheads
  if (s.type === 'ink') pad = (s.sw || 2) * 1.6 + 1
  if ((s.type === 'arrow' || s.type === 'line') && s.bend && s.pts.length === 2) {
    const d = Math.hypot(s.pts[1][0] - s.pts[0][0], s.pts[1][1] - s.pts[0][1])
    pad += Math.abs(s.bend) * d * 0.5
  }
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }
}

export function union(boxes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const b of boxes) {
    if (b.x < x0) x0 = b.x
    if (b.y < y0) y0 = b.y
    if (b.x + b.w > x1) x1 = b.x + b.w
    if (b.y + b.h > y1) y1 = b.y + b.h
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export const unionOf = (shapes) => union(shapes.map(aabb))

export const intersects = (a, b) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y
export const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
export const inflate = (b, d) => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d })

export function absPts(s) {
  return s.pts.map((p) => (p.length > 2 ? [s.x + p[0], s.y + p[1], p[2]] : [s.x + p[0], s.y + p[1]]))
}

/** Rebuild origin, relative points and bounds from absolute points. */
export function withAbsPts(s, abs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of abs) {
    if (p[0] < x0) x0 = p[0]
    if (p[1] < y0) y0 = p[1]
    if (p[0] > x1) x1 = p[0]
    if (p[1] > y1) y1 = p[1]
  }
  if (x0 === Infinity) return s
  return { ...s, x: x0, y: y0, w: x1 - x0, h: y1 - y0, pts: abs.map((p) => (p.length > 2 ? [p[0] - x0, p[1] - y0, p[2]] : [p[0] - x0, p[1] - y0])) }
}

/** Where a ray from the shape's centre toward (tx, ty) leaves its outline, pushed out by `gap`. */
export function edgePoint(s, tx, ty, gap = 0) {
  const [cx, cy] = centerOf(s)
  const [lx, ly] = s.angle ? rotate(tx, ty, cx, cy, -s.angle) : [tx, ty]
  const dx = lx - cx
  const dy = ly - cy
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return [cx, cy]
  const ux = dx / len
  const uy = dy / len
  const hw = Math.max(s.w / 2, 0.5)
  const hh = Math.max(s.h / 2, 0.5)
  let t
  if (s.type === 'ellipse') t = 1 / Math.sqrt((ux / hw) ** 2 + (uy / hh) ** 2)
  else if (s.type === 'diamond') t = 1 / (Math.abs(ux) / hw + Math.abs(uy) / hh)
  else t = Math.min(Math.abs(ux) > 1e-9 ? hw / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? hh / Math.abs(uy) : Infinity)
  const r = t + gap
  return rotate(cx + ux * r, cy + uy * r, cx, cy, s.angle || 0)
}

export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const l2 = dx * dx + dy * dy
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/** The polyline a line/arrow is drawn along (bent two-point arrows are sampled from their quadratic). */
export function linePath(s, steps = 24) {
  const abs = absPts(s)
  if (abs.length === 2 && s.bend) {
    const [a, b] = abs
    const mx = (a[0] + b[0]) / 2
    const my = (a[1] + b[1]) / 2
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const cx = mx - dy * s.bend
    const cy = my + dx * s.bend
    const out = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const u = 1 - t
      out.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]])
    }
    return out
  }
  return abs
}

/** Control point of a bent two-point arrow, in world coordinates. */
export function bendControl(s) {
  const [a, b] = absPts(s)
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  return [(a[0] + b[0]) / 2 - dy * (s.bend || 0), (a[1] + b[1]) / 2 + dx * (s.bend || 0)]
}

export function pointInPolygon(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export const round = (n, d = 2) => {
  const k = 10 ** d
  return Math.round(n * k) / k
}

export const normAngle = (a) => {
  a %= TAU
  return a < 0 ? a + TAU : a
}
