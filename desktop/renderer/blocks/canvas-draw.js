// Canvas block: painting. Every shape is first turned into a "plan" (paths, colours, text, image), cached per shape object
// because shapes are immutable; the Canvas2D painter and the SVG exporter both draw from the same plan, so the two outputs
// match. The caller owns DPR scaling and the view transform (see paintGrid / paintShapes / renderToCanvas).
import { linePath, paintBounds, union } from './canvas-geom.js'
import { LINE_HEIGHT, setTextMeasurer, wrapText } from './canvas-model.js'
import {
  dashArray, headPath, inkOutline, pathToCanvas, pathToSvg, rectPath, roughLine, roughShape, shapeOutline,
  smoothClosedPath,
} from './canvas-ink.js'

export const FONT_STACK = {
  sans: "'Geist', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  hand: "'Excalifont', 'Segoe Print', 'Bradley Hand', cursive",
  mono: "'Geist Mono', 'Cascadia Mono', Consolas, monospace",
}
export const fontString = (size, font) => `${size}px ${FONT_STACK[font] || FONT_STACK.sans}`

// ---------------------------------------------------------------- text measuring (browser)

let fontEpoch = 0
export const bumpFontEpoch = () => ++fontEpoch

/** Make the model measure text with a real canvas (call once in the window). */
export function installTextMeasurer() {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas')
  const x = c.getContext('2d')
  setTextMeasurer((text, size, font) => {
    x.font = fontString(size, font)
    return x.measureText(text).width
  })
  fontEpoch++
}

// ---------------------------------------------------------------- theme

export const DEFAULT_THEME = { ink: '#ededed', base: '#0f0f12', gridDot: 'rgba(255,255,255,.065)', accent: '#5a8cff', live: '#a86af4', note: '#1b1c20', surface: '#161619', line: 'rgba(255,255,255,.15)' }

/**
 * Read the canvas colours from the live CSS variables of `el`. Each value is resolved by the browser (a probe element's
 * computed `color`), so var(), color-mix() and relative colours all arrive as something a canvas understands.
 */
export function readTheme(el) {
  const cs = getComputedStyle(el)
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
  el.append(probe)
  const v = (name, fallback) => {
    if (!cs.getPropertyValue(name).trim()) return fallback
    probe.style.color = ''
    probe.style.color = `var(${name})`
    return getComputedStyle(probe).color || fallback
  }
  const theme = {
    ink: v('--ink', DEFAULT_THEME.ink),
    base: cs.getPropertyValue('--cv-b').trim() ? v('--cv-b', DEFAULT_THEME.base) : v('--fog', DEFAULT_THEME.base),
    gridDot: cs.getPropertyValue('--cv-dot').trim() ? v('--cv-dot', DEFAULT_THEME.gridDot) : v('--grid-dot', DEFAULT_THEME.gridDot),
    accent: v('--accent', DEFAULT_THEME.accent),
    live: v('--live', DEFAULT_THEME.live),
    note: '#1b1c20',
    surface: v('--card', DEFAULT_THEME.surface),
    line: v('--l3', DEFAULT_THEME.line),
  }
  probe.remove()
  return theme
}

export const resolveColor = (c, th) => (c === 'auto' ? th.ink : c)

// ---------------------------------------------------------------- plans

const plans = new WeakMap()

const hasStroke = (s) => s.sw > 0 && s.stroke !== 'transparent' && s.stroke !== 'none'
const hasFill = (s) => s.fill !== 'transparent' && s.fill !== 'none'

function strokeSpec(s, ops, extra) {
  return { ops, color: s.stroke, width: s.sw, dash: dashArray(s.dash, s.sw), ...extra }
}

function labelPlan(s) {
  if (!s.text) return null
  const pad = s.type === 'sticky' ? 12 : s.type === 'rect' ? 10 : s.type === 'ellipse' ? s.w * 0.14 : s.w * 0.24
  const avail = Math.max(8, s.w - pad * 2)
  const lines = wrapText(s.text, avail, s.size, s.font)
  const lh = s.size * LINE_HEIGHT
  const total = lines.length * lh
  const top = s.type === 'sticky' ? 10 : Math.max(0, (s.h - total) / 2)
  const center = s.type !== 'sticky'
  return {
    lines, font: s.font, size: s.size, lh, align: center ? 'center' : 'left',
    x: center ? s.w / 2 : pad, y: top, color: s.type === 'sticky' ? 'note' : s.stroke === 'transparent' ? 'auto' : s.stroke,
  }
}

function buildPlan(s) {
  const plan = { frame: null, fill: [], stroke: [], solid: [], text: null, image: null }
  switch (s.type) {
    case 'rect':
    case 'ellipse':
    case 'diamond': {
      plan.frame = { x: s.x, y: s.y, w: s.w, h: s.h, angle: s.angle }
      if (s.rough) {
        const r = roughShape(s)
        if (hasFill(s)) plan.fill.push({ ops: r.fill, color: s.fill })
        if (hasStroke(s)) for (const p of r.strokes) plan.stroke.push(strokeSpec(s, p))
      } else {
        const ops = shapeOutline(s)
        if (hasFill(s)) plan.fill.push({ ops, color: s.fill })
        if (hasStroke(s)) plan.stroke.push(strokeSpec(s, ops))
      }
      plan.text = labelPlan(s)
      break
    }
    case 'sticky': {
      plan.frame = { x: s.x, y: s.y, w: s.w, h: s.h, angle: s.angle }
      plan.fill.push({ ops: rectPath(s.w, s.h, 4), color: s.fill, shadow: true })
      if (hasStroke(s) && s.stroke !== 'auto') plan.stroke.push(strokeSpec(s, rectPath(s.w, s.h, 4)))
      plan.text = labelPlan(s)
      break
    }
    case 'text': {
      plan.frame = { x: s.x, y: s.y, w: s.w, h: s.h, angle: s.angle }
      const lines = wrapText(s.text || '', s.fw ? s.w : 0, s.size, s.font)
      const x = s.align === 'center' ? s.w / 2 : s.align === 'right' ? s.w : 0
      plan.text = { lines, font: s.font, size: s.size, lh: s.size * LINE_HEIGHT, align: s.align, x, y: 0, color: s.stroke === 'transparent' ? 'auto' : s.stroke }
      break
    }
    case 'image': {
      plan.frame = { x: s.x, y: s.y, w: s.w, h: s.h, angle: s.angle }
      plan.image = { hash: s.hash, mime: s.mime, w: s.w, h: s.h }
      if (hasStroke(s)) plan.stroke.push(strokeSpec(s, rectPath(s.w, s.h, 0)))
      break
    }
    case 'line':
    case 'arrow': {
      const pts = linePath(s)
      if (hasStroke(s)) {
        if (s.rough) for (const p of roughLine(pts, s.seed, s.sw)) plan.stroke.push(strokeSpec(s, p, { cap: 'round' }))
        else plan.stroke.push(strokeSpec(s, pts.map((p, i) => [i ? 'L' : 'M', p[0], p[1]]), { cap: 'round' }))
        const dirAt = (end) => {
          const tip = end ? pts[pts.length - 1] : pts[0]
          for (let k = 1; k < pts.length; k++) {
            const q = end ? pts[pts.length - 1 - k] : pts[k]
            const dx = tip[0] - q[0]
            const dy = tip[1] - q[1]
            const d = Math.hypot(dx, dy)
            if (d > 0.5) return [tip, dx / d, dy / d]
          }
          return null
        }
        for (const [kind, end] of [[s.head, true], [s.headS, false]]) {
          if (!kind || kind === 'none') continue
          const d = dirAt(end)
          if (!d) continue
          const h = headPath(kind, d[0][0], d[0][1], d[1], d[2], s.sw)
          if (h.fill) plan.solid.push({ ops: h.ops, color: s.stroke })
          else plan.stroke.push({ ops: h.ops, color: s.stroke, width: s.sw, dash: [], cap: 'round' })
        }
      }
      break
    }
    case 'ink': {
      const world = s.pts.map((p) => [s.x + p[0], s.y + p[1], s.pressure ? p[2] : 0.5])
      const ops = smoothClosedPath(inkOutline(world, s.sw))
      if (ops.length) plan.solid.push({ ops, color: s.stroke })
      break
    }
  }
  return plan
}

export function planOf(s) {
  let c = plans.get(s)
  if (!c || c.epoch !== fontEpoch) {
    c = { epoch: fontEpoch, plan: buildPlan(s) }
    plans.set(s, c)
  }
  return c.plan
}

// ---------------------------------------------------------------- canvas painter

function strokeStyle(ctx, st, th, scaleDash = 1) {
  ctx.strokeStyle = resolveColor(st.color, th)
  ctx.lineWidth = st.width
  ctx.lineCap = st.cap || 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash(st.dash.map((d) => d * scaleDash))
}

const planColor = (c, th) => (c === 'note' ? th.note : resolveColor(c, th))

/** Paint one shape in world space (ctx already carries the view transform). `env.image(hash, mime)` returns a drawable or null. */
export function paintShape(ctx, s, env) {
  const plan = planOf(s)
  const th = env.theme
  ctx.save()
  if (s.opacity < 1) ctx.globalAlpha = s.opacity
  const f = plan.frame
  if (f) {
    ctx.translate(f.x + f.w / 2, f.y + f.h / 2)
    if (f.angle) ctx.rotate(f.angle)
    ctx.translate(-f.w / 2, -f.h / 2)
  }
  for (const p of plan.fill) {
    ctx.beginPath()
    pathToCanvas(ctx, p.ops)
    ctx.fillStyle = resolveColor(p.color, th)
    if (p.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,.28)'
      ctx.shadowBlur = 14
      ctx.shadowOffsetY = 4
    }
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
  }
  if (plan.image) {
    const img = env.image ? env.image(plan.image.hash, plan.image.mime) : null
    if (img) ctx.drawImage(img, 0, 0, plan.image.w, plan.image.h)
    else {
      ctx.beginPath()
      pathToCanvas(ctx, rectPath(plan.image.w, plan.image.h, 6))
      ctx.fillStyle = th.surface
      ctx.fill()
      ctx.strokeStyle = th.line
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
  for (const p of plan.solid) {
    ctx.beginPath()
    pathToCanvas(ctx, p.ops)
    ctx.fillStyle = resolveColor(p.color, th)
    ctx.fill()
  }
  for (const p of plan.stroke) {
    ctx.beginPath()
    pathToCanvas(ctx, p.ops)
    strokeStyle(ctx, p, th)
    ctx.stroke()
  }
  ctx.setLineDash([])
  const t = plan.text
  if (t) {
    ctx.font = fontString(t.size, t.font)
    ctx.fillStyle = planColor(t.color, th)
    ctx.textAlign = t.align
    ctx.textBaseline = 'top'
    const off = (t.lh - t.size) / 2
    for (let i = 0; i < t.lines.length; i++) ctx.fillText(t.lines[i], t.x, t.y + i * t.lh + off)
  }
  ctx.restore()
}

/** Paint the visible shapes (`cull` = world rect) in array order. Returns how many were painted. */
export function paintShapes(ctx, shapes, env, cull) {
  let n = 0
  for (const s of shapes) {
    if (env.skip && env.skip.has(s.id)) continue
    if (cull) {
      const b = paintBounds(s)
      if (b.x > cull.x + cull.w || b.y > cull.y + cull.h || b.x + b.w < cull.x || b.y + b.h < cull.y) continue
    }
    paintShape(ctx, s, env)
    n++
  }
  return n
}

/** Dotted grid that scrolls with the view; the spacing doubles as you zoom out so it never turns into a mist. */
export function paintGrid(ctx, view, width, height, th, spacing = 24) {
  let step = spacing
  while (step * view.zoom < 12) step *= 2
  const px = step * view.zoom
  const x0 = Math.floor(view.x / step) * step
  const y0 = Math.floor(view.y / step) * step
  const r = Math.min(1.5, Math.max(0.7, view.zoom * 1.1))
  ctx.fillStyle = th.gridDot
  ctx.beginPath()
  for (let wx = x0; (wx - view.x) * view.zoom <= width + px; wx += step) {
    const sx = (wx - view.x) * view.zoom
    for (let wy = y0; (wy - view.y) * view.zoom <= height + px; wy += step) {
      const sy = (wy - view.y) * view.zoom
      ctx.moveTo(sx + r, sy)
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
    }
  }
  ctx.fill()
}

export const exportBounds = (shapes, pad = 0) => {
  const b = union(shapes.map(paintBounds))
  return b && { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }
}

/**
 * Render shapes to a fresh canvas. `bounds` defaults to the content; `scale` is device pixels per world unit.
 * Used for PNG export and for the agent screenshot of the current view (pass `bounds` = the view rect).
 */
export function renderToCanvas(shapes, { bounds, scale = 2, pad = 24, background, theme = DEFAULT_THEME, image, maxPixels = 40e6 } = {}) {
  const b = bounds || exportBounds(shapes, pad) || { x: 0, y: 0, w: 320, h: 200 }
  let k = scale
  if (b.w * k * b.h * k > maxPixels) k = Math.sqrt(maxPixels / (b.w * b.h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(b.w * k))
  c.height = Math.max(1, Math.round(b.h * k))
  const ctx = c.getContext('2d')
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, c.width, c.height)
  }
  ctx.setTransform(k, 0, 0, k, -b.x * k, -b.y * k)
  paintShapes(ctx, shapes, { theme, image }, b)
  return c
}

// ---------------------------------------------------------------- SVG export

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n2 = (n) => Math.round(n * 100) / 100

/**
 * The shapes as a standalone SVG document string. `images` maps an image hash to its data URL. Colours are resolved against
 * the theme so the file looks the same anywhere.
 */
export function shapesToSvg(shapes, { bounds, pad = 24, background, theme = DEFAULT_THEME, images = new Map() } = {}) {
  const b = bounds || exportBounds(shapes, pad) || { x: 0, y: 0, w: 320, h: 200 }
  const out = []
  for (const s of shapes) {
    const pb = paintBounds(s)
    if (pb.x > b.x + b.w || pb.y > b.y + b.h || pb.x + pb.w < b.x || pb.y + pb.h < b.y) continue
    const plan = planOf(s)
    const f = plan.frame
    const attrs = []
    if (f) {
      attrs.push(`transform="translate(${n2(f.x)} ${n2(f.y)})${f.angle ? ` rotate(${n2((f.angle * 180) / Math.PI)} ${n2(f.w / 2)} ${n2(f.h / 2)})` : ''}"`)
    }
    if (s.opacity < 1) attrs.push(`opacity="${n2(s.opacity)}"`)
    const g = []
    for (const p of plan.fill) {
      g.push(`<path d="${pathToSvg(p.ops)}" fill="${esc(resolveColor(p.color, theme))}"${p.shadow ? ' filter="url(#cv-shadow)"' : ''}/>`)
    }
    if (plan.image) {
      const href = images.get(plan.image.hash)
      if (href) g.push(`<image href="${esc(href)}" x="0" y="0" width="${n2(plan.image.w)}" height="${n2(plan.image.h)}" preserveAspectRatio="none"/>`)
      else g.push(`<rect width="${n2(plan.image.w)}" height="${n2(plan.image.h)}" rx="6" fill="${esc(theme.surface)}" stroke="${esc(theme.line)}" stroke-dasharray="4 4"/>`)
    }
    for (const p of plan.solid) g.push(`<path d="${pathToSvg(p.ops)}" fill="${esc(resolveColor(p.color, theme))}"/>`)
    for (const p of plan.stroke) {
      g.push(
        `<path d="${pathToSvg(p.ops)}" fill="none" stroke="${esc(resolveColor(p.color, theme))}" stroke-width="${n2(p.width)}" stroke-linecap="${p.cap || 'round'}" stroke-linejoin="round"${p.dash.length ? ` stroke-dasharray="${p.dash.map(n2).join(' ')}"` : ''}/>`,
      )
    }
    const t = plan.text
    if (t && t.lines.some((l) => l)) {
      const anchor = t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start'
      const spans = t.lines.map((l, i) => `<tspan x="${n2(t.x)}" y="${n2(t.y + i * t.lh + (t.lh - t.size) / 2)}">${esc(l) || ' '}</tspan>`).join('')
      g.push(`<text font-family="${esc(FONT_STACK[t.font])}" font-size="${t.size}" fill="${esc(planColor(t.color, theme))}" text-anchor="${anchor}" dominant-baseline="hanging" xml:space="preserve">${spans}</text>`)
    }
    out.push(`<g ${attrs.join(' ')}>${g.join('')}</g>`)
  }
  const bg = background ? `<rect x="${n2(b.x)}" y="${n2(b.y)}" width="${n2(b.w)}" height="${n2(b.h)}" fill="${esc(background)}"/>` : ''
  const defs = '<defs><filter id="cv-shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="4" stdDeviation="7" flood-color="#000" flood-opacity=".28"/></filter></defs>'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n2(b.x)} ${n2(b.y)} ${n2(b.w)} ${n2(b.h)}" width="${Math.ceil(b.w)}" height="${Math.ceil(b.h)}">${defs}${bg}${out.join('')}</svg>`
}
