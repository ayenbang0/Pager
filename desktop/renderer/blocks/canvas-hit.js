// Canvas block: hit-testing, selection geometry, resize maths and snapping. Pure functions over shape arrays, no DOM.
import {
  BINDABLE, aabb, centerOf, contains, distToSegment, intersects, isPoly, linePath, paintBounds, pointInPolygon, rotate, toLocal, unionOf,
} from './canvas-geom.js'

// ---------------------------------------------------------------- hit tests

function diamondPoly(s) {
  const { x, y, w, h } = s
  return [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]]
}

function nearPolyline(pts, px, py, r) {
  for (let i = 1; i < pts.length; i++) if (distToSegment(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r) return true
  return pts.length === 1 && Math.hypot(px - pts[0][0], py - pts[0][1]) <= r
}

const isFilled = (s) => s.fill !== 'transparent' && s.fill !== 'none'

/** Is world point (x, y) on this shape? `tol` is the slack in world units (a few screen pixels / zoom). */
export function hitShape(s, x, y, tol = 4) {
  if (s.type === 'line' || s.type === 'arrow') return nearPolyline(linePath(s), x, y, tol + (s.sw || 2) / 2 + 1)
  if (s.type === 'ink') {
    const pts = s.pts.map((p) => [s.x + p[0], s.y + p[1]])
    return nearPolyline(pts, x, y, tol + (s.sw || 2) * 0.8)
  }
  const [lx, ly] = toLocal(s, x, y)
  const pad = tol + (s.sw || 0) / 2
  if (s.type === 'text' || s.type === 'sticky' || s.type === 'image') {
    return lx >= s.x - tol && lx <= s.x + s.w + tol && ly >= s.y - tol && ly <= s.y + s.h + tol
  }
  const filled = isFilled(s) || !!s.text
  if (s.type === 'rect') {
    const inside = (p) => lx >= s.x - p && lx <= s.x + s.w + p && ly >= s.y - p && ly <= s.y + s.h + p
    if (!inside(pad)) return false
    return filled || !inside(-pad)
  }
  if (s.type === 'ellipse') {
    const cx = s.x + s.w / 2
    const cy = s.y + s.h / 2
    const inEll = (p) => {
      const rx = s.w / 2 + p
      const ry = s.h / 2 + p
      return rx > 0 && ry > 0 && ((lx - cx) / rx) ** 2 + ((ly - cy) / ry) ** 2 <= 1
    }
    if (!inEll(pad)) return false
    return filled || !inEll(-pad)
  }
  if (s.type === 'diamond') {
    const poly = diamondPoly(s)
    if (filled && pointInPolygon(lx, ly, poly)) return true
    for (let i = 0; i < 4; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % 4]
      if (distToSegment(lx, ly, a[0], a[1], b[0], b[1]) <= pad) return true
    }
    return false
  }
  return false
}

/** Topmost shape at the point, or null. `skip(s)` excludes shapes (locked ones by default). */
export function hitTest(shapes, x, y, tol = 4, skip = (s) => s.locked) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i]
    if (skip && skip(s)) continue
    const b = paintBounds(s)
    if (x < b.x - tol || y < b.y - tol || x > b.x + b.w + tol || y > b.y + b.h + tol) continue
    if (hitShape(s, x, y, tol)) return s
  }
  return null
}

/** Every shape under the point (the eraser removes all of them). */
export function hitAll(shapes, x, y, tol = 4, skip = (s) => s.locked) {
  const out = []
  for (const s of shapes) {
    if (skip && skip(s)) continue
    const b = paintBounds(s)
    if (x < b.x - tol || y < b.y - tol || x > b.x + b.w + tol || y > b.y + b.h + tol) continue
    if (hitShape(s, x, y, tol)) out.push(s)
  }
  return out
}

/** Marquee: shapes fully inside `rect` (`mode: 'contain'`) or touched by it (`'touch'`). */
export function shapesInRect(shapes, rect, mode = 'contain', skip = (s) => s.locked) {
  const out = []
  for (const s of shapes) {
    if (skip && skip(s)) continue
    const b = aabb(s)
    if (mode === 'contain' ? contains(rect, b) : intersects(rect, b)) out.push(s)
  }
  return out
}

/** Topmost shape an arrow end can attach to at this point. */
export function bindTargetAt(shapes, x, y, exclude, tol = 6) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i]
    if (!BINDABLE.has(s.type) || (exclude && exclude.has(s.id)) || s.locked) continue
    const [lx, ly] = toLocal(s, x, y)
    if (lx < s.x - tol || lx > s.x + s.w + tol || ly < s.y - tol || ly > s.y + s.h + tol) continue
    if (s.type === 'ellipse') {
      const rx = s.w / 2 + tol
      const ry = s.h / 2 + tol
      if (((lx - s.x - s.w / 2) / rx) ** 2 + ((ly - s.y - s.h / 2) / ry) ** 2 > 1) continue
    } else if (s.type === 'diamond') {
      const k = Math.abs(lx - s.x - s.w / 2) / (s.w / 2 + tol) + Math.abs(ly - s.y - s.h / 2) / (s.h / 2 + tol)
      if (k > 1) continue
    }
    return s
  }
  return null
}

// ---------------------------------------------------------------- selection frame and handles

/** The frame drawn around the selection: the shape's own rotated frame for one box shape, else the axis-aligned union. */
export function selectionFrame(shapes) {
  if (!shapes.length) return null
  if (shapes.length === 1 && !isPoly(shapes[0])) {
    const s = shapes[0]
    return { x: s.x, y: s.y, w: s.w, h: s.h, angle: s.angle || 0 }
  }
  const b = unionOf(shapes)
  return b && { ...b, angle: 0 }
}

export const HANDLES = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
}
export const ROTATE_OFFSET = 26 // screen px above the top edge

export function handlePoint(frame, name, zoom = 1) {
  const [cx, cy] = [frame.x + frame.w / 2, frame.y + frame.h / 2]
  let px
  let py
  if (name === 'rot') {
    px = frame.x + frame.w / 2
    py = frame.y - ROTATE_OFFSET / zoom
  } else {
    const [u, v] = HANDLES[name]
    px = frame.x + frame.w * u
    py = frame.y + frame.h * v
  }
  return rotate(px, py, cx, cy, frame.angle || 0)
}

/** Which handle of the frame (if any) is under the world point. Rotation first, then corners, then edge midpoints. */
export function handleAt(frame, wx, wy, zoom = 1, { rotation = true, edges = true } = {}) {
  if (!frame) return null
  const r = 9 / zoom
  if (rotation) {
    const [px, py] = handlePoint(frame, 'rot', zoom)
    if (Math.hypot(wx - px, wy - py) <= r) return 'rot'
  }
  const small = frame.w * zoom < 40 || frame.h * zoom < 40
  for (const name of ['nw', 'ne', 'se', 'sw']) {
    const [px, py] = handlePoint(frame, name)
    if (Math.hypot(wx - px, wy - py) <= r) return name
  }
  if (edges && !small) {
    for (const name of ['n', 'e', 's', 'w']) {
      const [px, py] = handlePoint(frame, name)
      if (Math.hypot(wx - px, wy - py) <= r) return name
    }
  }
  return null
}

const CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize']
const DIR_INDEX = { n: 0, ne: 1, e: 2, se: 3, s: 0, sw: 1, w: 2, nw: 3 }
export function handleCursor(name, angle = 0) {
  if (name === 'rot') return 'grab'
  const step = Math.round(((angle % Math.PI) + Math.PI) % Math.PI / (Math.PI / 4))
  return CURSORS[(DIR_INDEX[name] + step) % 4]
}

/**
 * Drag a resize handle: returns the new frame { x, y, w, h } (angle unchanged).
 * The opposite edge or corner stays put (or the centre with `center`), `keepRatio` holds the aspect ratio on corners.
 */
export function resizeFrame(frame, name, wx, wy, { keepRatio = false, center = false, min = 4 } = {}) {
  const angle = frame.angle || 0
  const oc = [frame.x + frame.w / 2, frame.y + frame.h / 2]
  const [px, py] = angle ? rotate(wx, wy, oc[0], oc[1], -angle) : [wx, wy]
  let l = frame.x
  let r = frame.x + frame.w
  let t = frame.y
  let b = frame.y + frame.h
  const W = name.includes('w')
  const E = name.includes('e')
  const N = name.includes('n')
  const S = name.includes('s')
  if (W) l = px
  if (E) r = px
  if (N) t = py
  if (S) b = py
  if (center) {
    if (W) r = 2 * oc[0] - l
    if (E) l = 2 * oc[0] - r
    if (N) b = 2 * oc[1] - t
    if (S) t = 2 * oc[1] - b
  }
  let w = Math.max(min, r - l)
  let h = Math.max(min, b - t)
  if (keepRatio && frame.w > 0 && frame.h > 0 && name.length === 2) {
    const k = Math.max(w / frame.w, h / frame.h)
    w = Math.max(min, frame.w * k)
    h = Math.max(min, frame.h * k)
  } else if (keepRatio && frame.w > 0 && frame.h > 0) {
    if (name === 'n' || name === 's') w = Math.max(min, (frame.w * h) / frame.h)
    else h = Math.max(min, (frame.h * w) / frame.w)
  }
  // anchor: the fixed edge/corner (or the centre) keeps its world position
  let ax = W ? frame.x + frame.w : E ? frame.x : oc[0]
  let ay = N ? frame.y + frame.h : S ? frame.y : oc[1]
  if (center) (ax = oc[0]), (ay = oc[1])
  // new local rect measured from the anchor
  const nl = center ? ax - w / 2 : W ? ax - w : E ? ax : oc[0] - w / 2
  const nt = center ? ay - h / 2 : N ? ay - h : S ? ay : oc[1] - h / 2
  const lc = [nl + w / 2, nt + h / 2]
  const wc = angle ? rotate(lc[0], lc[1], oc[0], oc[1], angle) : lc
  return { x: wc[0] - w / 2, y: wc[1] - h / 2, w, h }
}

/** New angle for dragging the rotation handle with the pointer at (wx, wy); `step` snaps (radians, 0 = free). */
export function rotationFrom(frame, wx, wy, step = 0) {
  const cx = frame.x + frame.w / 2
  const cy = frame.y + frame.h / 2
  let a = Math.atan2(wy - cy, wx - cx) + Math.PI / 2
  if (step) a = Math.round(a / step) * step
  return a
}

// ---------------------------------------------------------------- snapping

const SNAP_AXES = (b) => [b.x, b.x + b.w / 2, b.x + b.w]

/**
 * Snap a box being moved to other boxes' edges/centres, else to the grid.
 * Returns { dx, dy, guides } where guides are [{ axis:'x'|'y', pos, a, b }] world-space lines to draw.
 */
export function snapMove(box, others, { threshold = 6, grid = 0, objects = true } = {}) {
  let dx = 0
  let dy = 0
  const best = { x: Infinity, y: Infinity } // signed smallest delta per axis (Infinity: none within the threshold)
  const guides = []
  if (objects) {
    const mine = { x: SNAP_AXES(box), y: [box.y, box.y + box.h / 2, box.y + box.h] }
    for (const o of others) {
      const theirs = { x: SNAP_AXES(o), y: [o.y, o.y + o.h / 2, o.y + o.h] }
      for (const axis of ['x', 'y']) {
        for (const m of mine[axis]) {
          for (const t of theirs[axis]) {
            const d = t - m
            if (Math.abs(d) <= threshold && Math.abs(d) < Math.abs(best[axis])) best[axis] = d
          }
        }
      }
    }
    if (best.x !== Infinity) dx = best.x
    if (best.y !== Infinity) dy = best.y
  }
  if (grid > 0) {
    if (best.x === Infinity) dx = Math.round(box.x / grid) * grid - box.x
    if (best.y === Infinity) dy = Math.round(box.y / grid) * grid - box.y
  }
  if (objects && (Math.abs(best.x) <= threshold || Math.abs(best.y) <= threshold)) {
    const nb = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }
    for (const axis of ['x', 'y']) {
      if (Math.abs(best[axis]) > threshold) continue
      const mine = axis === 'x' ? SNAP_AXES(nb) : [nb.y, nb.y + nb.h / 2, nb.y + nb.h]
      for (const m of mine) {
        for (const o of others) {
          const theirs = axis === 'x' ? SNAP_AXES(o) : [o.y, o.y + o.h / 2, o.y + o.h]
          if (theirs.some((t) => Math.abs(t - m) < 0.01)) {
            const [a0, a1] = axis === 'x' ? [Math.min(nb.y, o.y), Math.max(nb.y + nb.h, o.y + o.h)] : [Math.min(nb.x, o.x), Math.max(nb.x + nb.w, o.x + o.w)]
            if (!guides.some((g) => g.axis === axis && Math.abs(g.pos - m) < 0.01)) guides.push({ axis, pos: m, a: a0, b: a1 })
          }
        }
      }
    }
  }
  return { dx, dy, guides }
}

/** Snap one coordinate to the grid. */
export const snapGrid = (v, grid) => (grid > 0 ? Math.round(v / grid) * grid : v)

/** Constrain (x, y) to a multiple of `step` radians around (ox, oy) (shift while drawing a line). */
export function snapAngle(ox, oy, x, y, step = Math.PI / 12) {
  const a = Math.atan2(y - oy, x - ox)
  const d = Math.hypot(x - ox, y - oy)
  const q = Math.round(a / step) * step
  return [ox + Math.cos(q) * d, oy + Math.sin(q) * d]
}

export { centerOf }
