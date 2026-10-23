// Canvas block: the document model. Pure data and functions, no DOM, no imports besides the geometry file, so the very
// same module runs in the window (editing) and in the main process (agent edits, merges, validation).
//
// A document is { v:1, id, name, seq, view:{x,y,zoom}, settings:{grid,snap,hand}, shapes:[...] }.
// `shapes` is ordered back to front (array order is z-order). Shapes are IMMUTABLE: every change builds a new object, so an
// undo snapshot is just the previous array and unchanged shapes are shared between snapshots.
import {
  BINDABLE, absPts, centerOf, edgePoint, isBox, isPoly, rotate, round, union, unionOf, withAbsPts,
} from './canvas-geom.js'

export const VERSION = 1
export const LIMITS = {
  shapes: 5000, pts: 4000, totalPts: 400000, text: 20000, coord: 1e6, dim: 1e5, name: 120, ops: 200, ids: 2000, groupDepth: 8,
  size: [4, 600], sw: [0, 40],
}
export const TYPES = ['rect', 'ellipse', 'diamond', 'line', 'arrow', 'text', 'sticky', 'ink', 'image']
export const FONTS = ['sans', 'hand', 'mono']
export const DASHES = ['solid', 'dashed', 'dotted']
export const HEADS = ['none', 'arrow', 'triangle', 'dot', 'bar']
export const ALIGN_EDGES = ['left', 'center', 'right', 'top', 'middle', 'bottom']
export const ORDER_MOVES = ['front', 'back', 'forward', 'backward']
export const LAYOUTS = ['grid', 'tree', 'row', 'column']
export const ZOOM_MIN = 0.05
export const ZOOM_MAX = 8

/** Colours the inspector offers. `auto` = the theme's ink, so a drawing follows light/dark themes. */
export const STROKES = ['auto', '#e5484d', '#f08a24', '#2fae74', '#3d6fff', '#a86af4', '#e255a1', '#8a8a92']
export const FILLS = ['transparent', 'rgba(229,72,77,.22)', 'rgba(240,138,36,.24)', 'rgba(47,174,116,.22)', 'rgba(61,111,255,.22)', 'rgba(168,106,244,.22)', 'rgba(226,85,161,.22)', 'rgba(138,138,146,.24)']
export const STICKY_COLORS = ['#fde68a', '#fdba74', '#fca5a5', '#f9a8d4', '#c4b5fd', '#93c5fd', '#86efac', '#e5e7eb']

export class CanvasError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message)
    this.name = 'CanvasError'
    this.path = path
  }
}

// ---------------------------------------------------------------- ids and small helpers

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const COLOR_RE = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([0-9.,%\s/-]{3,48}\)|[a-z]{3,24})$/i
const MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
export const IMAGE_MIMES = MIME
const HASH_RE = /^[a-f0-9]{32}$/

export function newId(rng = Math.random) {
  let s = ''
  while (s.length < 8) s += Math.floor(rng() * 36).toString(36)
  return 's' + s
}
export const newSeed = (rng = Math.random) => 1 + Math.floor(rng() * 2147483646)
export const isId = (v) => typeof v === 'string' && ID_RE.test(v)
export const isHash = (v) => typeof v === 'string' && HASH_RE.test(v)
export const isColor = (v) => typeof v === 'string' && COLOR_RE.test(v)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ---------------------------------------------------------------- text measuring

/** Replaced by the window with a real canvas measure; the main process keeps the estimate. */
let measurer = null
export function setTextMeasurer(fn) {
  measurer = typeof fn === 'function' ? fn : null
}
const FONT_K = { sans: 1, hand: 1.04, mono: 1.07 }
function charWidth(ch) {
  const c = ch.codePointAt(0)
  if (c > 0x2e80) return 1
  if (c === 32) return 0.28
  if ('iljtf.,;:!|\'`'.includes(ch)) return 0.3
  if ('mwMW@%'.includes(ch)) return 0.88
  if (ch >= 'A' && ch <= 'Z') return 0.66
  if (ch >= '0' && ch <= '9') return 0.58
  return 0.54
}
export function measureLine(text, size, font) {
  if (measurer) return measurer(text, size, font)
  let w = 0
  for (const ch of text) w += font === 'mono' ? 0.6 : charWidth(ch) * FONT_K[font || 'sans']
  return w * size
}
export const LINE_HEIGHT = 1.25

/** Greedy word wrap to maxW (<= 0 means never wrap). Returns an array of lines (explicit newlines kept). */
export function wrapText(text, maxW, size, font) {
  const out = []
  for (const para of String(text).split('\n')) {
    if (!(maxW > 0) || measureLine(para, size, font) <= maxW) {
      out.push(para)
      continue
    }
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      const t = line + word
      if (line && measureLine(t.trimEnd(), size, font) > maxW) {
        out.push(line.trimEnd())
        line = word.trimStart()
        // a single word longer than the line is broken by characters
        while (measureLine(line, size, font) > maxW && line.length > 1) {
          let k = line.length - 1
          while (k > 1 && measureLine(line.slice(0, k), size, font) > maxW) k--
          out.push(line.slice(0, k))
          line = line.slice(k)
        }
      } else line = t
    }
    out.push(line.trimEnd())
  }
  return out
}

export function textSize(text, size, font, wrapW = 0) {
  const lines = wrapText(text, wrapW, size, font)
  let w = 0
  for (const l of lines) w = Math.max(w, measureLine(l, size, font))
  return { w: Math.ceil(w) + 2, h: Math.ceil(lines.length * size * LINE_HEIGHT), lines }
}

/** A text shape sized to its content (width kept when it has a fixed width). */
export function fitText(s) {
  if (s.type !== 'text') return s
  const t = textSize(s.text || '', s.size, s.font, s.fw ? s.w : 0)
  const w = s.fw ? s.w : Math.max(t.w, s.size * 0.6)
  const h = Math.max(t.h, Math.ceil(s.size * LINE_HEIGHT))
  return w === s.w && h === s.h ? s : { ...s, w, h }
}

// ---------------------------------------------------------------- shape schema

const COMMON = ['id', 'type', 'x', 'y', 'w', 'h', 'angle', 'stroke', 'fill', 'sw', 'dash', 'opacity', 'rough', 'seed', 'g', 'locked', 'name']
const EXTRA = {
  rect: ['round', 'text', 'size', 'font'],
  ellipse: ['text', 'size', 'font'],
  diamond: ['text', 'size', 'font'],
  sticky: ['text', 'size', 'font'],
  text: ['text', 'size', 'font', 'align', 'fw'],
  line: ['pts', 'bind', 'head', 'headS', 'bend', 'x1', 'y1', 'x2', 'y2', 'from', 'to'],
  arrow: ['pts', 'bind', 'head', 'headS', 'bend', 'x1', 'y1', 'x2', 'y2', 'from', 'to'],
  ink: ['pts', 'pressure'],
  image: ['hash', 'mime', 'nw', 'nh'],
}
const allowed = (type) => new Set([...COMMON, ...EXTRA[type]])

export const DEFAULTS = {
  rect: { w: 140, h: 90, round: true },
  ellipse: { w: 140, h: 90 },
  diamond: { w: 140, h: 100 },
  sticky: { w: 180, h: 150, fill: '#fde68a', font: 'hand', size: 20, text: '' },
  text: { size: 20, font: 'sans', align: 'left', text: '' },
  line: { head: 'none' },
  arrow: { head: 'arrow' },
  ink: { sw: 3 },
  image: { w: 240, h: 160, sw: 0 },
}

function num(v, path, lo, hi, { int = false } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CanvasError('must be a finite number', path)
  if (v < lo || v > hi) throw new CanvasError(`must be between ${lo} and ${hi}`, path)
  return int ? Math.round(v) : v
}
function oneOf(v, list, path) {
  if (!list.includes(v)) throw new CanvasError(`must be one of ${list.join(', ')}`, path)
  return v
}
function str(v, path, max) {
  if (typeof v !== 'string') throw new CanvasError('must be a string', path)
  if (v.length > max) throw new CanvasError(`is longer than ${max} characters`, path)
  return v
}
function color(v, path) {
  if (!isColor(v)) throw new CanvasError('must be a colour (#rgb, #rrggbb, rgb(), hsl(), a name, transparent or auto)', path)
  return v
}

function parsePts(raw, type, path) {
  if (!Array.isArray(raw)) throw new CanvasError('must be an array of [x, y] points', path)
  const min = type === 'ink' ? 1 : 2
  if (raw.length < min || raw.length > LIMITS.pts) throw new CanvasError(`needs ${min}..${LIMITS.pts} points`, path)
  return raw.map((p, i) => {
    if (!Array.isArray(p) || p.length < 2 || p.length > 3) throw new CanvasError('must be [x, y] or [x, y, pressure]', `${path}[${i}]`)
    const x = num(p[0], `${path}[${i}][0]`, -LIMITS.coord, LIMITS.coord)
    const y = num(p[1], `${path}[${i}][1]`, -LIMITS.coord, LIMITS.coord)
    if (type === 'ink') return [round(x, 2), round(y, 2), p.length > 2 ? round(num(p[2], `${path}[${i}][2]`, 0, 1), 3) : 0.5]
    return [x, y]
  })
}

/**
 * Validate and normalise one shape. `strict` (agent input) rejects unknown fields; lenient (loading a file) ignores them.
 * Always returns a complete shape with every default filled in.
 */
export function parseShape(raw, { strict = true, rng = Math.random, path = 'shape' } = {}) {
  if (!isObj(raw)) throw new CanvasError('must be an object', path)
  const type = oneOf(raw.type, TYPES, `${path}.type`)
  const ok = allowed(type)
  if (strict) for (const k of Object.keys(raw)) if (!ok.has(k)) throw new CanvasError(`unknown field for a ${type}`, `${path}.${k}`)
  const d = { angle: 0, stroke: 'auto', fill: 'transparent', sw: 2, dash: 'solid', opacity: 1, rough: false, ...DEFAULTS[type] }
  if (type === 'sticky') d.stroke = 'auto'
  const get = (k) => (raw[k] === undefined || raw[k] === null ? d[k] : raw[k])
  const s = { id: raw.id === undefined ? newId(rng) : raw.id, type }
  if (!isId(s.id)) throw new CanvasError('must match [A-Za-z0-9_-]{1,40}', `${path}.id`)
  s.angle = isPoly({ type }) ? 0 : round(num(get('angle'), `${path}.angle`, -1e3, 1e3), 4)
  s.stroke = color(get('stroke'), `${path}.stroke`)
  s.fill = color(get('fill'), `${path}.fill`)
  s.sw = num(get('sw'), `${path}.sw`, LIMITS.sw[0], LIMITS.sw[1])
  s.dash = oneOf(get('dash'), DASHES, `${path}.dash`)
  s.opacity = num(get('opacity'), `${path}.opacity`, 0, 1)
  s.rough = !!get('rough')
  s.seed = raw.seed === undefined ? newSeed(rng) : num(raw.seed, `${path}.seed`, 1, 2147483646, { int: true })
  if (raw.g !== undefined && raw.g !== null) {
    const g = typeof raw.g === 'string' ? [raw.g] : raw.g
    if (!Array.isArray(g) || g.length > LIMITS.groupDepth || !g.every(isId)) throw new CanvasError('must be an array of group ids', `${path}.g`)
    if (g.length) s.g = g.slice()
  }
  if (raw.locked) s.locked = true
  if (raw.name !== undefined && raw.name !== null && raw.name !== '') s.name = str(raw.name, `${path}.name`, LIMITS.name)

  if (type === 'line' || type === 'arrow' || type === 'ink') {
    let pts = raw.pts
    if (pts === undefined && type !== 'ink' && raw.x1 !== undefined) {
      const c = ['x1', 'y1', 'x2', 'y2'].map((k) => num(raw[k], `${path}.${k}`, -LIMITS.coord, LIMITS.coord))
      pts = [[c[0], c[1]], [c[2], c[3]]]
      raw = { ...raw, x: 0, y: 0 }
    }
    if (pts === undefined) throw new CanvasError('is required (an array of [x, y] points)', `${path}.pts`)
    const rel = parsePts(pts, type, `${path}.pts`)
    const ox = raw.x === undefined ? 0 : num(raw.x, `${path}.x`, -LIMITS.coord, LIMITS.coord)
    const oy = raw.y === undefined ? 0 : num(raw.y, `${path}.y`, -LIMITS.coord, LIMITS.coord)
    Object.assign(s, withAbsPts({ ...s, x: 0, y: 0, w: 0, h: 0, pts: rel }, rel.map((p) => [p[0] + ox, p[1] + oy, ...p.slice(2)])))
    if (type !== 'ink') {
      s.head = oneOf(get('head'), HEADS, `${path}.head`)
      s.headS = oneOf(raw.headS === undefined ? 'none' : raw.headS, HEADS, `${path}.headS`)
      const bend = raw.bend === undefined ? 0 : num(raw.bend, `${path}.bend`, -2, 2)
      if (bend && s.pts.length === 2) s.bend = round(bend, 3)
      const bind = {}
      if (raw.bind !== undefined && raw.bind !== null) {
        if (!isObj(raw.bind)) throw new CanvasError('must be { s?, e? } shape ids', `${path}.bind`)
        for (const k of Object.keys(raw.bind)) {
          if (k !== 's' && k !== 'e') throw new CanvasError('unknown binding end', `${path}.bind.${k}`)
          const v = raw.bind[k]
          if (v === null || v === undefined) continue
          if (!isId(v)) throw new CanvasError('must be a shape id', `${path}.bind.${k}`)
          bind[k] = v
        }
      }
      for (const [k, src] of [['s', 'from'], ['e', 'to']]) {
        if (raw[src] === undefined || raw[src] === null) continue
        if (!isId(raw[src])) throw new CanvasError('must be a shape id', `${path}.${src}`)
        bind[k] = raw[src]
      }
      if (bind.s || bind.e) s.bind = bind
    } else {
      s.pressure = raw.pressure === undefined ? s.pts.some((p) => p[2] !== 0.5) : !!raw.pressure
    }
    return s
  }

  s.x = raw.x === undefined ? 0 : num(raw.x, `${path}.x`, -LIMITS.coord, LIMITS.coord)
  s.y = raw.y === undefined ? 0 : num(raw.y, `${path}.y`, -LIMITS.coord, LIMITS.coord)
  s.w = num(get('w') === undefined ? 1 : get('w'), `${path}.w`, 0, LIMITS.dim)
  s.h = num(get('h') === undefined ? 1 : get('h'), `${path}.h`, 0, LIMITS.dim)

  if (type === 'image') {
    s.hash = raw.hash
    if (!isHash(s.hash)) throw new CanvasError('must be the 32-hex-digit hash of a stored image', `${path}.hash`)
    s.mime = oneOf(raw.mime === undefined ? 'image/png' : raw.mime, Object.keys(MIME), `${path}.mime`)
    s.nw = raw.nw === undefined ? s.w : num(raw.nw, `${path}.nw`, 1, 1e5)
    s.nh = raw.nh === undefined ? s.h : num(raw.nh, `${path}.nh`, 1, 1e5)
    s.fill = 'transparent'
    if (raw.w === undefined && raw.h === undefined) {
      const k = Math.min(1, 480 / Math.max(s.nw, s.nh))
      s.w = Math.round(s.nw * k)
      s.h = Math.round(s.nh * k)
    }
    return s
  }
  if (type === 'rect') s.round = !!get('round')
  if ('text' in d || EXTRA[type].includes('text')) {
    const t = raw.text === undefined || raw.text === null ? d.text || '' : raw.text
    if (t !== '') s.text = str(t, `${path}.text`, LIMITS.text)
    else if (type === 'text' || type === 'sticky') s.text = ''
    s.size = num(get('size') === undefined ? 20 : get('size'), `${path}.size`, LIMITS.size[0], LIMITS.size[1])
    s.font = oneOf(get('font') === undefined ? 'sans' : get('font'), FONTS, `${path}.font`)
  }
  if (type === 'text') {
    s.align = oneOf(get('align'), ['left', 'center', 'right'], `${path}.align`)
    s.fw = !!raw.fw
    const sized = raw.w !== undefined && raw.h !== undefined
    if (!sized || s.w < 1 || s.h < 1) {
      const f = fitText({ ...s, w: s.fw && raw.w ? s.w : 0, h: 0 })
      s.w = f.w
      s.h = f.h
    }
  }
  return s
}

// ---------------------------------------------------------------- document

export const DEFAULT_VIEW = { x: -120, y: -80, zoom: 1 }
export const DEFAULT_SETTINGS = { grid: true, snap: true, hand: false }

export function emptyDoc(id, name = 'Untitled canvas') {
  return { v: VERSION, id, name, seq: 0, view: { ...DEFAULT_VIEW }, settings: { ...DEFAULT_SETTINGS }, shapes: [] }
}

function parseView(v) {
  const d = { ...DEFAULT_VIEW }
  if (!isObj(v)) return d
  const ok = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi
  if (ok(v.x, -LIMITS.coord * 2, LIMITS.coord * 2)) d.x = v.x
  if (ok(v.y, -LIMITS.coord * 2, LIMITS.coord * 2)) d.y = v.y
  if (ok(v.zoom, ZOOM_MIN, ZOOM_MAX)) d.zoom = v.zoom
  return d
}
function parseSettings(v) {
  const d = { ...DEFAULT_SETTINGS }
  if (isObj(v)) for (const k of Object.keys(d)) if (typeof v[k] === 'boolean') d[k] = v[k]
  return d
}

/**
 * Load a document from untrusted JSON: invalid shapes are dropped (and counted), duplicate ids renamed, dangling
 * bindings cleared. Never throws for content problems, only when `raw` is not an object at all.
 */
export function normalizeDoc(raw, { id, rng = Math.random } = {}) {
  if (!isObj(raw)) throw new CanvasError('the document must be a JSON object')
  const seen = new Set()
  const shapes = []
  let dropped = 0
  if (Array.isArray(raw.shapes)) {
    for (const r of raw.shapes.slice(0, LIMITS.shapes)) {
      try {
        let s = parseShape(r, { strict: false, rng })
        if (seen.has(s.id)) s = { ...s, id: newId(rng) }
        seen.add(s.id)
        shapes.push(s)
      } catch {
        dropped++
      }
    }
    dropped += Math.max(0, raw.shapes.length - LIMITS.shapes)
  }
  const doc = {
    v: VERSION,
    id: typeof raw.id === 'string' && isId(raw.id) ? raw.id : id || 'main',
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, LIMITS.name) : 'Untitled canvas',
    seq: Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0,
    view: parseView(raw.view),
    settings: parseSettings(raw.settings),
    shapes: reflowBindings(cleanBindings(shapes)),
  }
  if (dropped) doc.dropped = dropped
  return doc
}

export function countPts(shapes) {
  let n = 0
  for (const s of shapes) if (s.pts) n += s.pts.length
  return n
}

// ---------------------------------------------------------------- groups, units, selection

export const outerGroup = (s) => (s.g && s.g.length ? s.g[s.g.length - 1] : null)

/** All ids that move together with `ids`: whole outermost groups. */
export function expandUnits(shapes, ids) {
  const want = new Set(ids)
  const groups = new Set()
  for (const s of shapes) if (want.has(s.id) && outerGroup(s)) groups.add(outerGroup(s))
  if (!groups.size) return want
  for (const s of shapes) if (s.g && s.g.some((g) => groups.has(g))) want.add(s.id)
  return want
}

/** The shapes as moving entities: a whole group, or a lone shape. */
export function entitiesOf(shapes, idSet) {
  const byGroup = new Map()
  const out = []
  for (const s of shapes) {
    if (!idSet.has(s.id)) continue
    const g = outerGroup(s)
    if (g) {
      let e = byGroup.get(g)
      if (!e) byGroup.set(g, (e = { key: g, shapes: [] })), out.push(e)
      e.shapes.push(s)
    } else out.push({ key: s.id, shapes: [s] })
  }
  for (const e of out) e.box = unionOf(e.shapes)
  return out
}

export function groupShapes(shapes, idSet, gid = newId()) {
  const ids = expandUnits(shapes, idSet)
  if (ids.size < 2) return { shapes, gid: null }
  let depthErr = false
  const out = shapes.map((s) => {
    if (!ids.has(s.id)) return s
    const g = [...(s.g || []), gid]
    if (g.length > LIMITS.groupDepth) depthErr = true
    return { ...s, g }
  })
  return depthErr ? { shapes, gid: null } : { shapes: out, gid }
}

/** Remove the outermost group of each given shape's unit (or the named groups). */
export function ungroupShapes(shapes, idSet, groupIds) {
  const gids = new Set(groupIds || [])
  if (!groupIds) for (const s of shapes) if (idSet.has(s.id) && outerGroup(s)) gids.add(outerGroup(s))
  if (!gids.size) return shapes
  return shapes.map((s) => {
    if (!s.g || !s.g.some((g) => gids.has(g))) return s
    const g = s.g.filter((x) => !gids.has(x))
    const { g: _drop, ...rest } = s
    return g.length ? { ...rest, g } : rest
  })
}

export function byId(shapes) {
  const m = new Map()
  for (const s of shapes) m.set(s.id, s)
  return m
}

// ---------------------------------------------------------------- bindings

/** Clear bindings that point at shapes which no longer exist (or can't be bound). */
export function cleanBindings(shapes) {
  const ids = byId(shapes)
  let changed = false
  const out = shapes.map((s) => {
    if (!s.bind) return s
    const bind = {}
    for (const k of ['s', 'e']) {
      const t = ids.get(s.bind[k])
      if (t && t !== s && BINDABLE.has(t.type)) bind[k] = s.bind[k]
    }
    if (bind.s === s.bind.s && bind.e === s.bind.e && Object.keys(bind).length === Object.keys(s.bind).length) return s
    changed = true
    const { bind: _b, ...rest } = s
    return bind.s || bind.e ? { ...rest, bind } : rest
  })
  return changed ? out : shapes
}

export const ARROW_GAP = 4

/** Recompute the endpoints of bound lines and arrows from the shapes they are attached to. */
export function reflowBindings(shapes) {
  let map = null
  let changed = false
  const out = shapes.map((s) => {
    if (!s.bind || (s.type !== 'arrow' && s.type !== 'line')) return s
    map ||= byId(shapes)
    const abs = absPts(s)
    const n = abs.length
    const A = s.bind.s && map.get(s.bind.s)
    const B = s.bind.e && map.get(s.bind.e)
    if (!A && !B) return s
    const next = abs.map((p) => p.slice())
    // the direction an end looks toward: the other bound shape's centre, or the neighbouring point
    if (A) {
      const toward = B && n === 2 ? centerOf(B) : abs[1]
      const q = edgePoint(A, toward[0], toward[1], ARROW_GAP)
      next[0] = [q[0], q[1]]
    }
    if (B) {
      const toward = A && n === 2 ? centerOf(A) : abs[n - 2]
      const q = edgePoint(B, toward[0], toward[1], ARROW_GAP)
      next[n - 1] = [q[0], q[1]]
    }
    const same = next.every((p, i) => Math.abs(p[0] - abs[i][0]) < 0.01 && Math.abs(p[1] - abs[i][1]) < 0.01)
    if (same) return s
    changed = true
    return withAbsPts(s, next)
  })
  return changed ? out : shapes
}

// ---------------------------------------------------------------- transforms

const replaceIn = (shapes, idSet, fn) => {
  let changed = false
  const out = shapes.map((s) => {
    if (!idSet.has(s.id)) return s
    const n = fn(s)
    if (n !== s) changed = true
    return n
  })
  return changed ? out : shapes
}

const detachMoved = (s, set) => {
  if (!s.bind) return s
  const bind = {}
  for (const k of ['s', 'e']) if (s.bind[k] && set.has(s.bind[k])) bind[k] = s.bind[k]
  if (bind.s === s.bind.s && bind.e === s.bind.e) return s
  const { bind: _b, ...rest } = s
  return bind.s || bind.e ? { ...rest, bind } : rest
}

export function moveShapes(shapes, idSet, dx, dy) {
  if (!dx && !dy) return shapes
  return reflowBindings(replaceIn(shapes, idSet, (s) => detachMoved({ ...s, x: s.x + dx, y: s.y + dy }, idSet)))
}

/** Rotate shapes by `da` radians about a pivot. Poly shapes are baked (their points move), box shapes keep a angle. */
export function rotateShapes(shapes, idSet, pivot, da) {
  if (!da) return shapes
  const [px, py] = pivot
  return reflowBindings(replaceIn(shapes, idSet, (s) => {
    if (isPoly(s)) return detachMoved(withAbsPts(s, absPts(s).map((p) => [...rotate(p[0], p[1], px, py, da), ...p.slice(2)])), idSet)
    const [cx, cy] = centerOf(s)
    const [nx, ny] = rotate(cx, cy, px, py, da)
    return { ...s, x: nx - s.w / 2, y: ny - s.h / 2, angle: s.angle + da }
  }))
}

/** Scale shapes from box `a` to box `b` (a resize drag). Text scales its font; other box shapes stretch. */
export function scaleShapes(shapes, idSet, a, b) {
  const sx = a.w > 1e-6 ? b.w / a.w : 1
  const sy = a.h > 1e-6 ? b.h / a.h : 1
  return reflowBindings(replaceIn(shapes, idSet, (s) => {
    if (isPoly(s)) {
      return detachMoved(withAbsPts(s, absPts(s).map((p) => [b.x + (p[0] - a.x) * sx, b.y + (p[1] - a.y) * sy, ...p.slice(2)])), idSet)
    }
    const [cx, cy] = centerOf(s)
    const ncx = b.x + (cx - a.x) * sx
    const ncy = b.y + (cy - a.y) * sy
    if (s.type === 'text') {
      const k = Math.max(0.1, Math.sqrt(Math.abs(sx * sy)))
      const size = Math.min(LIMITS.size[1], Math.max(LIMITS.size[0], round(s.size * k, 1)))
      const f = fitText({ ...s, size, fw: false })
      return { ...f, x: ncx - f.w / 2, y: ncy - f.h / 2 }
    }
    const w = Math.max(2, s.w * Math.abs(sx))
    const h = Math.max(2, s.h * Math.abs(sy))
    return { ...s, x: ncx - w / 2, y: ncy - h / 2, w, h }
  }))
}

export function reorder(shapes, idSet, how) {
  const sel = shapes.filter((s) => idSet.has(s.id))
  if (!sel.length) return shapes
  const rest = shapes.filter((s) => !idSet.has(s.id))
  if (how === 'front') return [...rest, ...sel]
  if (how === 'back') return [...sel, ...rest]
  const out = shapes.slice()
  if (how === 'forward') {
    for (let i = out.length - 2; i >= 0; i--) if (idSet.has(out[i].id) && !idSet.has(out[i + 1].id)) [out[i], out[i + 1]] = [out[i + 1], out[i]]
  } else if (how === 'backward') {
    for (let i = 1; i < out.length; i++) if (idSet.has(out[i].id) && !idSet.has(out[i - 1].id)) [out[i], out[i - 1]] = [out[i - 1], out[i]]
  } else return shapes
  return out
}

/** Translate whole entities (groups stay together) by per-entity deltas. */
function applyEntityDeltas(shapes, entities, deltas) {
  const move = new Map()
  entities.forEach((e, i) => {
    const [dx, dy] = deltas[i]
    if (dx || dy) for (const s of e.shapes) move.set(s.id, [dx, dy])
  })
  if (!move.size) return shapes
  const set = new Set(move.keys())
  return reflowBindings(shapes.map((s) => {
    const d = move.get(s.id)
    return d ? detachMoved({ ...s, x: s.x + d[0], y: s.y + d[1] }, set) : s
  }))
}

export function alignShapes(shapes, idSet, edge) {
  const ents = entitiesOf(shapes, idSet)
  if (ents.length < 2) return shapes
  const all = union(ents.map((e) => e.box))
  const deltas = ents.map((e) => {
    const b = e.box
    switch (edge) {
      case 'left': return [all.x - b.x, 0]
      case 'right': return [all.x + all.w - (b.x + b.w), 0]
      case 'center': return [all.x + all.w / 2 - (b.x + b.w / 2), 0]
      case 'top': return [0, all.y - b.y]
      case 'bottom': return [0, all.y + all.h - (b.y + b.h)]
      case 'middle': return [0, all.y + all.h / 2 - (b.y + b.h / 2)]
      default: return [0, 0]
    }
  })
  return applyEntityDeltas(shapes, ents, deltas)
}

/** Even gaps between entities along an axis; the outermost two stay where they are. */
export function distributeShapes(shapes, idSet, axis) {
  const ents = entitiesOf(shapes, idSet)
  if (ents.length < 3) return shapes
  const x = axis === 'x'
  const pos = (e) => (x ? e.box.x : e.box.y)
  const len = (e) => (x ? e.box.w : e.box.h)
  const sorted = ents.slice().sort((a, b) => pos(a) - pos(b))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = pos(last) + len(last) - pos(first)
  const total = sorted.reduce((n, e) => n + len(e), 0)
  const gap = (span - total) / (sorted.length - 1)
  let cursor = pos(first) + len(first) + gap
  const delta = new Map()
  for (let i = 1; i < sorted.length - 1; i++) {
    delta.set(sorted[i], cursor - pos(sorted[i]))
    cursor += len(sorted[i]) + gap
  }
  return applyEntityDeltas(shapes, ents, ents.map((e) => (delta.has(e) ? (x ? [delta.get(e), 0] : [0, delta.get(e)]) : [0, 0])))
}

// ---------------------------------------------------------------- auto layout

/**
 * Arrange the selected shapes (groups as units; lines and arrows are not nodes, bound ones simply follow).
 *   grid / row / column: reading order, cells sized to their column and row
 *   tree: the arrows between the shapes define parents and children; shapes are laid out in layers (dir 'down' or 'right')
 */
export function layoutShapes(shapes, idSet, { kind = 'grid', gap = 40, columns, dir = 'down' } = {}) {
  const nodes = new Set()
  for (const s of shapes) if (idSet.has(s.id) && s.type !== 'arrow' && s.type !== 'line') nodes.add(s.id)
  const ents = entitiesOf(shapes, expandUnits(shapes, nodes))
  if (ents.length < 2) return shapes
  const origin = union(ents.map((e) => e.box))
  const place = new Map() // entity -> [x, y] target top-left

  const gridLike = (list, cols) => {
    const rows = []
    for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols))
    const colW = Array.from({ length: cols }, (_, c) => Math.max(0, ...rows.map((r) => (r[c] ? r[c].box.w : 0))))
    const rowH = rows.map((r) => Math.max(...r.map((e) => e.box.h)))
    let y = origin.y
    rows.forEach((r, ri) => {
      let x = origin.x
      r.forEach((e, ci) => {
        place.set(e, [x + (colW[ci] - e.box.w) / 2, y + (rowH[ri] - e.box.h) / 2])
        x += colW[ci] + gap
      })
      y += rowH[ri] + gap
    })
  }
  const reading = () => {
    const tol = Math.max(8, ents.reduce((n, e) => n + e.box.h, 0) / ents.length / 2)
    return ents.slice().sort((a, b) => {
      const ra = Math.round(a.box.y / tol)
      const rb = Math.round(b.box.y / tol)
      return ra - rb || a.box.x - b.box.x || a.box.y - b.box.y
    })
  }

  const entityOf = new Map()
  for (const e of ents) for (const s of e.shapes) entityOf.set(s.id, e)
  const children = new Map(ents.map((e) => [e, []]))
  const hasParent = new Set()
  let edges = 0
  if (kind === 'tree') {
    for (const s of shapes) {
      if (s.type !== 'arrow' || !s.bind || !s.bind.s || !s.bind.e) continue
      const a = entityOf.get(s.bind.s)
      const b = entityOf.get(s.bind.e)
      if (!a || !b || a === b || hasParent.has(b) || children.get(a).includes(b)) continue
      children.get(a).push(b)
      hasParent.add(b)
      edges++
    }
  }
  if (kind === 'row') gridLike(reading(), ents.length)
  else if (kind === 'column') gridLike(reading(), 1)
  else if (kind === 'grid' || edges === 0) {
    const n = ents.length
    gridLike(reading(), Math.max(1, Math.min(n, Math.round(columns) || Math.ceil(Math.sqrt(n)))))
  } else {
    const down = dir !== 'right'
    const size = (e) => (down ? e.box.w : e.box.h) // extent along the spread axis
    const depthSize = (e) => (down ? e.box.h : e.box.w)
    const seen = new Set()
    const span = new Map()
    const measure = (e, path) => {
      seen.add(e)
      const kids = children.get(e).filter((k) => !path.has(k) && !seen.has(k))
      children.set(e, kids)
      let w = 0
      for (const k of kids) w += measure(k, new Set([...path, e])) + gap
      w = kids.length ? Math.max(size(e), w - gap) : size(e)
      span.set(e, w)
      return w
    }
    const roots = ents.filter((e) => !hasParent.has(e))
    for (const e of ents) if (!seen.has(e) && (roots.includes(e) || hasParent.has(e) === false)) measure(e, new Set())
    for (const e of ents) if (!seen.has(e)) (roots.push(e), measure(e, new Set()))
    // layer thickness
    const depth = new Map()
    const walk = (e, d) => {
      depth.set(e, d)
      for (const k of children.get(e)) walk(k, d + 1)
    }
    for (const r of roots) walk(r, 0)
    const thick = []
    for (const [e, d] of depth) thick[d] = Math.max(thick[d] || 0, depthSize(e))
    const offs = [0]
    for (let i = 1; i < thick.length; i++) offs[i] = offs[i - 1] + thick[i - 1] + gap * 1.5
    const put = (e, start) => {
      const mine = span.get(e)
      const pos = start + (mine - size(e)) / 2
      const d = depth.get(e)
      const dd = offs[d] + (thick[d] - depthSize(e)) / 2
      place.set(e, down ? [origin.x + pos, origin.y + dd] : [origin.x + dd, origin.y + pos])
      let cursor = start
      for (const k of children.get(e)) {
        put(k, cursor + (mine - childrenSpan(e)) / 2)
        cursor += span.get(k) + gap
      }
    }
    const childrenSpan = (e) => {
      const kids = children.get(e)
      return kids.length ? kids.reduce((n, k) => n + span.get(k), 0) + gap * (kids.length - 1) : 0
    }
    let cursor = 0
    for (const r of roots) {
      put(r, cursor)
      cursor += span.get(r) + gap * 2
    }
  }
  return applyEntityDeltas(shapes, ents, ents.map((e) => {
    const p = place.get(e)
    return p ? [p[0] - e.box.x, p[1] - e.box.y] : [0, 0]
  }))
}

// ---------------------------------------------------------------- copy, paste, duplicate

/** Copies of the shapes (groups kept together under fresh group ids) with `offset` applied. Bindings survive only between copies. */
export function cloneShapes(list, { dx = 0, dy = 0, rng = Math.random } = {}) {
  const idMap = new Map()
  const gMap = new Map()
  for (const s of list) idMap.set(s.id, newId(rng))
  const mapG = (g) => {
    if (!gMap.has(g)) gMap.set(g, newId(rng))
    return gMap.get(g)
  }
  return list.map((s) => {
    const c = { ...s, id: idMap.get(s.id), x: s.x + dx, y: s.y + dy, seed: newSeed(rng) }
    if (s.g) c.g = s.g.map(mapG)
    if (s.bind) {
      const bind = {}
      for (const k of ['s', 'e']) if (s.bind[k] && idMap.has(s.bind[k])) bind[k] = idMap.get(s.bind[k])
      if (bind.s || bind.e) c.bind = bind
      else delete c.bind
    }
    delete c.locked
    return c
  })
}

export function duplicateShapes(shapes, idSet, offset = 20, rng = Math.random) {
  const ids = expandUnits(shapes, idSet)
  const copies = cloneShapes(shapes.filter((s) => ids.has(s.id)), { dx: offset, dy: offset, rng })
  // bound arrows that stayed attached to a copied-away target keep their world position (no binding)
  return { shapes: reflowBindings([...shapes, ...copies]), ids: copies.map((c) => c.id) }
}

/** Free spot below the content: where shapes added without a position go. */
export function nextFreeSpot(shapes, gap = 40) {
  const b = unionOf(shapes)
  return b ? { x: b.x, y: b.y + b.h + gap } : { x: 0, y: 0 }
}

// ---------------------------------------------------------------- viewport

export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

/** View (top-left world point + zoom) that shows `box` centred in a w x h screen with padding. */
export function fitView(box, w, h, pad = 64, maxZoom = 2) {
  if (!box || w <= 0 || h <= 0) return { ...DEFAULT_VIEW }
  const bw = Math.max(box.w, 1)
  const bh = Math.max(box.h, 1)
  const zoom = clampZoom(Math.min(maxZoom, (w - pad * 2) / bw, (h - pad * 2) / bh))
  return { x: box.x + box.w / 2 - w / 2 / zoom, y: box.y + box.h / 2 - h / 2 / zoom, zoom }
}

// ---------------------------------------------------------------- edit operations (agents and the window)

const OPS = ['add', 'update', 'remove', 'group', 'ungroup', 'layout', 'align', 'distribute', 'order', 'clear']

function idList(op, path, { max = LIMITS.ids, key = 'ids' } = {}) {
  let ids = op[key]
  if (ids === undefined && op.id !== undefined) ids = [op.id]
  if (!Array.isArray(ids) || !ids.length) throw new CanvasError(`needs ${key}: [shape ids]`, path)
  if (ids.length > max) throw new CanvasError(`has more than ${max} ids`, `${path}.${key}`)
  ids.forEach((id, i) => {
    if (!isId(id)) throw new CanvasError('must be a shape id', `${path}.${key}[${i}]`)
  })
  return ids
}

function scalePoly(s, w, h) {
  const sx = s.w > 1e-6 ? w / s.w : 1
  const sy = s.h > 1e-6 ? h / s.h : 1
  return { ...s, pts: s.pts.map((p) => [p[0] * sx, p[1] * sy, ...p.slice(2)]), w, h }
}

/**
 * Apply a list of operations atomically: either every op is valid and applied, or nothing changes and `errors` says why.
 *   { op:'add', shape:{type,...} } | { op:'add', shapes:[...] }
 *   { op:'update', id|ids, set:{...} }          { op:'remove', ids|id|group }
 *   { op:'group', ids, id? }  { op:'ungroup', id|ids }
 *   { op:'layout', kind:'grid'|'tree'|'row'|'column', ids?, gap?, columns?, dir? }
 *   { op:'align', ids, to }  { op:'distribute', ids, axis }  { op:'order', ids, to }  { op:'clear' }
 * Returns { ok, shapes, created, changed, removed, errors, results } (`shapes` is the new array when ok).
 */
export function applyOps(shapesIn, ops, { rng = Math.random } = {}) {
  const errors = []
  const results = []
  if (!Array.isArray(ops)) return { ok: false, shapes: shapesIn, created: [], changed: [], removed: [], errors: [{ index: -1, error: 'ops must be an array' }], results }
  if (ops.length > LIMITS.ops) return { ok: false, shapes: shapesIn, created: [], changed: [], removed: [], errors: [{ index: -1, error: `at most ${LIMITS.ops} operations per call` }], results }
  let shapes = shapesIn
  const created = []
  const touched = new Set()
  const removed = new Set()
  const known = () => byId(shapes)

  ops.forEach((op, i) => {
    const path = `ops[${i}]`
    try {
      if (!isObj(op)) throw new CanvasError('must be an object', path)
      oneOf(op.op, OPS, `${path}.op`)
      const res = { op: op.op }
      switch (op.op) {
        case 'add': {
          const list = op.shapes !== undefined ? op.shapes : [op.shape]
          if (!Array.isArray(list) || !list.length || list.length > 500) throw new CanvasError('needs shape: {...} or shapes: [...] (1..500)', path)
          const ids = new Set(shapes.map((s) => s.id))
          const added = []
          const spot = nextFreeSpot(shapes)
          let offsetY = 0
          list.forEach((raw, k) => {
            const p = `${path}.${op.shape !== undefined ? 'shape' : `shapes[${k}]`}`
            let s = parseShape(raw, { strict: true, rng, path: p })
            if (ids.has(s.id)) throw new CanvasError(`id ${s.id} already exists`, `${p}.id`)
            if (isBox(s) && isObj(raw) && raw.x === undefined && raw.y === undefined) {
              s = { ...s, x: spot.x, y: spot.y + offsetY }
              offsetY += s.h + 24
            }
            ids.add(s.id)
            added.push(s)
          })
          shapes = [...shapes, ...added]
          for (const s of added) (created.push(s.id), touched.add(s.id))
          res.ids = added.map((s) => s.id)
          break
        }
        case 'update': {
          const ids = idList(op, path)
          if (!isObj(op.set) || !Object.keys(op.set).length) throw new CanvasError('needs set: {fields}', `${path}.set`)
          const m = known()
          for (const id of ids) if (!m.has(id)) throw new CanvasError(`no shape ${id}`, `${path}.ids`)
          const patch = op.set
          if (patch.id !== undefined || (patch.type !== undefined && ids.some((id) => m.get(id).type !== patch.type))) throw new CanvasError('id and type cannot change', `${path}.set`)
          const sel = new Set(ids)
          shapes = shapes.map((s) => {
            if (!sel.has(s.id)) return s
            let base = s
            const p = { ...patch }
            if (isPoly(s) && p.pts === undefined && (p.w !== undefined || p.h !== undefined)) {
              base = scalePoly(s, num(p.w === undefined ? s.w : p.w, `${path}.set.w`, 0, LIMITS.dim), num(p.h === undefined ? s.h : p.h, `${path}.set.h`, 0, LIMITS.dim))
              delete p.w
              delete p.h
            }
            if (isPoly(s) && p.pts !== undefined && p.x === undefined && p.y === undefined) (p.x = 0), (p.y = 0)
            const merged = { ...base, ...p }
            if (isPoly(s) && p.pts === undefined) merged.pts = base.pts
            if (s.type === 'text' && (p.text !== undefined || p.size !== undefined || p.font !== undefined) && p.w === undefined && p.h === undefined) {
              merged.w = merged.fw ? s.w : 0
              merged.h = 0
            }
            let n = parseShape(merged, { strict: true, rng, path: `${path}.set` })
            if (s.type === 'text') n = fitText(n)
            if (s.bind && n.bind === undefined && p.bind === undefined && p.pts === undefined) n = { ...n, bind: s.bind }
            touched.add(s.id)
            return n
          })
          break
        }
        case 'remove': {
          let ids
          if (op.group !== undefined) {
            if (!isId(op.group)) throw new CanvasError('must be a group id', `${path}.group`)
            ids = shapes.filter((s) => s.g && s.g.includes(op.group)).map((s) => s.id)
            if (!ids.length) throw new CanvasError(`no group ${op.group}`, `${path}.group`)
          } else ids = idList(op, path)
          const m = known()
          for (const id of ids) if (!m.has(id)) throw new CanvasError(`no shape ${id}`, `${path}.ids`)
          const sel = new Set(ids)
          shapes = cleanBindings(shapes.filter((s) => !sel.has(s.id)))
          for (const id of ids) (removed.add(id), touched.delete(id))
          res.ids = ids
          break
        }
        case 'group': {
          const ids = idList(op, path)
          const m = known()
          for (const id of ids) if (!m.has(id)) throw new CanvasError(`no shape ${id}`, `${path}.ids`)
          if (expandUnits(shapes, ids).size < 2) throw new CanvasError('needs at least two shapes', `${path}.ids`)
          if (op.id !== undefined && (!isId(op.id) || shapes.some((s) => s.g && s.g.includes(op.id)))) throw new CanvasError('group id must be a new id', `${path}.id`)
          const r = groupShapes(shapes, new Set(ids), op.id)
          if (!r.gid) throw new CanvasError(`groups nest at most ${LIMITS.groupDepth} deep`, path)
          shapes = r.shapes
          for (const id of expandUnits(shapes, ids)) touched.add(id)
          res.group = r.gid
          break
        }
        case 'ungroup': {
          const ids = op.id !== undefined || op.ids !== undefined ? idList(op, path) : null
          if (!ids) throw new CanvasError('needs id (a group id or shape id) or ids', path)
          const gids = ids.filter((id) => shapes.some((s) => s.g && s.g.includes(id)))
          const members = new Set(ids.filter((id) => !gids.includes(id)))
          for (const id of members) if (!shapes.some((s) => s.id === id)) throw new CanvasError(`no shape or group ${id}`, path)
          const before = shapes
          shapes = ungroupShapes(shapes, members, gids.length ? gids : undefined)
          for (let k = 0; k < shapes.length; k++) if (shapes[k] !== before[k]) touched.add(shapes[k].id)
          break
        }
        case 'layout': {
          const kind = oneOf(op.kind === undefined ? 'grid' : op.kind, LAYOUTS, `${path}.kind`)
          const ids = op.ids === undefined ? shapes.map((s) => s.id) : idList(op, path)
          const m = known()
          for (const id of ids) if (!m.has(id)) throw new CanvasError(`no shape ${id}`, `${path}.ids`)
          const gap = op.gap === undefined ? 40 : num(op.gap, `${path}.gap`, 0, 2000)
          const columns = op.columns === undefined ? undefined : num(op.columns, `${path}.columns`, 1, 100, { int: true })
          const dir = op.dir === undefined ? 'down' : oneOf(op.dir, ['down', 'right'], `${path}.dir`)
          const before = shapes
          shapes = layoutShapes(shapes, new Set(ids), { kind, gap, columns, dir })
          for (let k = 0; k < shapes.length; k++) if (shapes[k] !== before[k]) touched.add(shapes[k].id)
          break
        }
        case 'align':
        case 'distribute': {
          const ids = idList(op, path)
          const m = known()
          for (const id of ids) if (!m.has(id)) throw new CanvasError(`no shape ${id}`, `${path}.ids`)
          const before = shapes
          if (op.op === 'align') shapes = alignShapes(shapes, new Set(ids), oneOf(op.to, ALIGN_EDGES, `${path}.to`))
          else shapes = distributeShapes(shapes, new Set(ids), oneOf(op.axis, ['x', 'y'], `${path}.axis`))
          for (let k = 0; k < shapes.length; k++) if (shapes[k] !== before[k]) touched.add(shapes[k].id)
          break
        }
        case 'order': {
          const ids = idList(op, path)
          const m = known()
          for (const id of ids) if (!m.has(id)) throw new CanvasError(`no shape ${id}`, `${path}.ids`)
          shapes = reorder(shapes, expandUnits(shapes, ids), oneOf(op.to, ORDER_MOVES, `${path}.to`))
          for (const id of ids) touched.add(id)
          break
        }
        case 'clear':
          for (const s of shapes) (removed.add(s.id), touched.delete(s.id))
          shapes = []
          break
      }
      results.push(res)
    } catch (e) {
      if (!(e instanceof CanvasError)) throw e
      errors.push({ index: i, error: e.message })
      results.push({ op: isObj(op) ? op.op : undefined, error: e.message })
    }
  })

  if (!errors.length) {
    shapes = reflowBindings(cleanBindings(shapes))
    if (shapes.length > LIMITS.shapes) errors.push({ index: -1, error: `a canvas holds at most ${LIMITS.shapes} shapes` })
    else if (countPts(shapes) > LIMITS.totalPts) errors.push({ index: -1, error: `a canvas holds at most ${LIMITS.totalPts} points` })
  }
  if (errors.length) return { ok: false, shapes: shapesIn, created: [], changed: [], removed: [], errors, results }
  const live = new Set(shapes.map((s) => s.id))
  return {
    ok: true,
    shapes,
    created,
    changed: [...touched].filter((id) => live.has(id) && !created.includes(id)),
    removed: [...removed].filter((id) => !live.has(id)),
    errors,
    results,
  }
}

// ---------------------------------------------------------------- diff and merge

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** Which ids were added, changed or removed between two shape arrays. */
export function diffIds(prev, next) {
  const a = byId(prev)
  const b = byId(next)
  const added = []
  const changed = []
  const removed = []
  for (const [id, s] of b) {
    const o = a.get(id)
    if (!o) added.push(id)
    else if (!same(o, s)) changed.push(id)
  }
  for (const id of a.keys()) if (!b.has(id)) removed.push(id)
  // a pure re-order shows up as the moved ids
  if (!added.length && !removed.length && !changed.length && prev.some((s, i) => s.id !== next[i].id)) {
    const order = new Map(prev.map((s, i) => [s.id, i]))
    next.forEach((s, i) => order.get(s.id) !== i && changed.push(s.id))
  }
  return { added, changed, removed }
}

/**
 * Three-way merge of shape arrays by id: `base` is what both sides started from, `local` what this side has now, `remote`
 * what the other side saved. A field changed on one side only is taken from that side; both sides changing the same field keeps
 * local. A shape deleted on one side and edited on the other is kept (nothing is lost silently).
 */
export function mergeShapes(base, local, remote) {
  const B = byId(base)
  const L = byId(local)
  const R = byId(remote)
  const merged = new Map()
  const ids = new Set([...B.keys(), ...L.keys(), ...R.keys()])
  for (const id of ids) {
    const b = B.get(id)
    const l = L.get(id)
    const r = R.get(id)
    let m
    if (same(l, b)) m = r
    else if (same(r, b)) m = l
    else if (same(l, r)) m = l
    else if (!l) m = same(r, b) ? undefined : r
    else if (!r) m = l
    else {
      m = { ...r }
      for (const k of new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b || {})])) {
        const lv = l[k]
        const bv = b ? b[k] : undefined
        if (!same(lv, bv)) {
          if (lv === undefined) delete m[k]
          else m[k] = lv
        }
      }
    }
    if (m) merged.set(id, m)
  }
  const order = (list) => list.map((s) => s.id).filter((id) => merged.has(id))
  const baseOrder = order(base)
  const remoteOrder = order(remote)
  const remoteMoved = remoteOrder.filter((id) => B.has(id)).join() !== baseOrder.filter((id) => R.has(id)).join()
  const skeleton = remoteMoved ? remoteOrder : order(local)
  const out = skeleton.slice()
  const have = new Set(out)
  const insertAfterPrev = (list) => {
    list.forEach((id, i) => {
      if (have.has(id)) return
      let at = -1
      for (let k = i - 1; k >= 0 && at < 0; k--) at = out.indexOf(list[k])
      out.splice(at + 1, 0, id)
      have.add(id)
    })
  }
  insertAfterPrev(order(local))
  insertAfterPrev(order(remote))
  return reflowBindings(cleanBindings(out.map((id) => merged.get(id))))
}

// ---------------------------------------------------------------- history

/** Undo/redo over immutable shape arrays. An entry is the state AFTER its change; entry 0 is the loaded document. */
export class History {
  constructor(shapes, { limit = 200, now = () => Date.now() } = {}) {
    this.limit = limit
    this.now = now
    this.entries = [{ label: 'Open', ts: now(), shapes }]
    this.index = 0
  }
  get shapes() {
    return this.entries[this.index].shapes
  }
  get canUndo() {
    return this.index > 0
  }
  get canRedo() {
    return this.index < this.entries.length - 1
  }
  /** Record a new state (dropping the redo branch). `key` merges rapid repeats (a slider drag) into one step. */
  commit(shapes, label, { key, window = 800 } = {}) {
    if (shapes === this.shapes) return false
    const ts = this.now()
    const top = this.entries[this.index]
    this.entries.length = this.index + 1
    if (key && top.key === key && ts - top.ts < window && this.index > 0) {
      this.entries[this.index] = { label: top.label, ts, key, shapes }
      return true
    }
    this.entries.push({ label, ts, key, shapes })
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    this.index = this.entries.length - 1
    return true
  }
  undo() {
    if (!this.canUndo) return null
    this.index--
    return this.shapes
  }
  redo() {
    if (!this.canRedo) return null
    this.index++
    return this.shapes
  }
  jump(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.entries.length) return null
    this.index = i
    return this.shapes
  }
}
