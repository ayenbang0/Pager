// Canvas block: a native whiteboard. Infinite pan/zoom surface, shapes, freehand ink with pressure, images, selection tools,
// groups, alignment and auto-layout, undo history, export. The document model, hit-testing, painting and persistence client live
// in canvas-model/-hit/-draw/-ink/-sync; this file is the interaction layer and the floating chrome. The main-process handler
// (desktop/electron/blocks/canvas.cjs, contract in CANVAS.md) owns the file on disk and the agent hooks.
import { h, fromHTML, clamp } from '../ui/dom.js'
import { I } from './canvas-icons.js'
import { aabb, centerOf, isPoly, unionOf, withAbsPts, absPts, round, bendControl, linePath, distToSegment } from './canvas-geom.js'
import {
  DEFAULT_SETTINGS, DEFAULT_VIEW, DEFAULTS, FILLS, History, STICKY_COLORS, STROKES, alignShapes, cleanBindings, cloneShapes, byId,
  clampZoom, distributeShapes, duplicateShapes, expandUnits, fitText, fitView, groupShapes, layoutShapes, moveShapes, newId, parseShape,
  reflowBindings, reorder, rotateShapes, scaleShapes, ungroupShapes, wrapText, LINE_HEIGHT, ZOOM_MAX, ZOOM_MIN, normalizeDoc,
} from './canvas-model.js'
import {
  bindTargetAt, handleAt, handleCursor, handlePoint, hitAll, hitTest, resizeFrame, rotationFrom, selectionFrame, shapesInRect, snapAngle,
  snapGrid, snapMove, HANDLES,
} from './canvas-hit.js'
import {
  bumpFontEpoch, exportBounds, fontString, installTextMeasurer, paintGrid, paintShapes, readTheme, renderToCanvas, resolveColor, shapesToSvg,
} from './canvas-draw.js'
import { simplifyInk, simulatePressure } from './canvas-ink.js'
import { Sync } from './canvas-sync.js'

const ic = (name) => fromHTML(I[name])
const GRID = 24
const CLIP_PREFIX = 'pager-canvas/v1:'
const LAST_KEY = 'pager.canvas.last'
const TOOLS = [
  [
    { id: 'select', key: 'v', icon: 'select', label: 'Select' },
    { id: 'hand', key: 'h', icon: 'hand', label: 'Pan' },
  ],
  [
    { id: 'rect', key: 'r', icon: 'rect', label: 'Rectangle' },
    { id: 'ellipse', key: 'o', icon: 'ellipse', label: 'Ellipse' },
    { id: 'diamond', key: 'd', icon: 'diamond', label: 'Diamond' },
    { id: 'line', key: 'l', icon: 'line', label: 'Line' },
    { id: 'arrow', key: 'a', icon: 'arrow', label: 'Arrow' },
  ],
  [
    { id: 'text', key: 't', icon: 'text', label: 'Text' },
    { id: 'sticky', key: 'n', icon: 'sticky', label: 'Sticky note' },
    { id: 'pen', key: 'p', icon: 'pen', label: 'Pen' },
    { id: 'eraser', key: 'e', icon: 'eraser', label: 'Eraser' },
    { id: 'image', key: 'i', icon: 'image', label: 'Image' },
  ],
]
const TOOL_BY_KEY = Object.fromEntries(TOOLS.flat().map((t) => [t.key, t.id]))
const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'diamond', 'sticky'])
const DRAW_TOOLS = new Set(['rect', 'ellipse', 'diamond', 'line', 'arrow', 'text', 'sticky', 'pen'])
const SIZES = [['S', 14], ['M', 20], ['L', 28], ['XL', 40]]
const WIDTHS = [1, 2, 4, 6]
const TEXT_TYPES = new Set(['text', 'sticky', 'rect', 'ellipse', 'diamond'])
const LABEL = { rect: 'rectangle', ellipse: 'ellipse', diamond: 'diamond', line: 'line', arrow: 'arrow', text: 'text', sticky: 'sticky note', ink: 'drawing', image: 'image' }

let cssReady = null
/** Load canvas.css once (the shell may also load it); resolves when it applies. */
function ensureCss() {
  if (cssReady) return cssReady
  const existing = document.querySelector('link[data-cv-css]')
  const link = existing || h('link', { rel: 'stylesheet', href: new URL('./canvas.css', import.meta.url).href, dataset: { cvCss: '1' } })
  cssReady = new Promise((resolve) => {
    if (existing && existing.sheet) return resolve()
    link.addEventListener('load', () => resolve(), { once: true })
    link.addEventListener('error', () => resolve(), { once: true })
  })
  if (!existing) document.head.append(link)
  return cssReady
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const mod = (e) => (isMac ? e.metaKey : e.ctrlKey)
const kbd = (s) => (isMac ? s.replace('Ctrl', '⌘').replace('Shift', '⇧').replace('Alt', '⌥') : s)

const slug = (s) => String(s || 'canvas').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'canvas'

function download(blobOrUrl, name) {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl)
  const a = h('a', { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 4000)
}

const b64 = (buf) => {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

// ---------------------------------------------------------------- the block

export default {
  id: 'canvas',
  title: 'Canvas',
  icon: I.canvas,
  mount(el, ctx) {
    const cssLoaded = ensureCss()
    installTextMeasurer()
    const args = ctx.args || {}
    const S = {
      id: null, name: 'Canvas', ephemeral: false,
      view: { ...DEFAULT_VIEW }, settings: { ...DEFAULT_SETTINGS },
      hist: new History([]), live: null, mapOf: null, map: null,
      sel: new Set(), tool: 'select', lock: false,
      style: { stroke: 'auto', fill: 'transparent', sw: 2, dash: 'solid', opacity: 1, rough: false, round: true, size: 20, font: 'sans', align: 'left', head: 'arrow', headS: 'none' },
      size: { w: 800, h: 600, dpr: 1 }, theme: null, dirty: true,
      I: null, hover: null, guides: [], marquee: null, pointer: null, space: false,
      editing: null, clip: null, pasteN: 0, images: new Map(), imageData: new Map(),
      flash: null, fly: null, bind: null, eraser: null, status: 'saved', dead: false, savedAt: 0,
    }
    const shapes = () => S.live || S.hist.shapes
    const mapOf = () => {
      const a = shapes()
      if (S.mapOf !== a) (S.map = byId(a)), (S.mapOf = a)
      return S.map
    }
    const selShapes = () => {
      const m = mapOf()
      const out = []
      for (const id of S.sel) {
        const s = m.get(id)
        if (s) out.push(s)
      }
      return out
    }

    // ---- DOM ----------------------------------------------------------------------------------------------------
    const root = h('div', { class: 'cv', tabIndex: 0 })
    const canvas = h('canvas', { class: 'cv-canvas' })
    const stage = h('div', { class: 'cv-stage' }, canvas)
    const editorLayer = h('div', { class: 'cv-editor-layer' })
    const empty = h('div', { class: 'cv-empty' }, h('div', { class: 'cv-empty-ic' }, ic('canvas')), h('div', { class: 'cv-empty-t' }, 'Draw something'), h('div', { class: 'cv-empty-s' }, 'Press R, O or P, paste an image, or ask an agent to sketch it.'))
    const nameBtn = h('button', { type: 'button', class: 'cv-name', title: 'Canvases and export', onClick: () => openDocMenu() }, h('span', { class: 'cv-name-ic' }, ic('canvas')), h('span', { class: 'cv-name-t' }, S.name), h('span', { class: 'cv-name-c' }, ic('chevD')))
    const statusEl = h('span', { class: 'cv-status', title: 'Saved to disk' }, ic('cloud'), h('span', { class: 'cv-status-t' }, 'Saved'))
    const top = h('div', { class: 'cv-top cv-glass' }, nameBtn, statusEl)
    const insp = h('div', { class: 'cv-insp cv-glass', hidden: true })
    const toolbar = h('div', { class: 'cv-tools cv-glass', role: 'toolbar', 'aria-label': 'Canvas tools' })
    const toolBtns = new Map()
    TOOLS.forEach((group, gi) => {
      if (gi) toolbar.append(h('span', { class: 'cv-sep' }))
      for (const t of group) {
        const b = h('button', { type: 'button', class: 'cv-tool', title: `${t.label}  ${t.key.toUpperCase()}`, dataset: { tool: t.id }, onClick: () => setTool(t.id) }, ic(t.icon))
        toolBtns.set(t.id, b)
        toolbar.append(b)
      }
    })
    const undoBtn = h('button', { type: 'button', class: 'cv-btn', title: `Undo  ${kbd('Ctrl+Z')}`, onClick: () => undo() }, ic('undo'))
    const redoBtn = h('button', { type: 'button', class: 'cv-btn', title: `Redo  ${kbd('Ctrl+Shift+Z')}`, onClick: () => redo() }, ic('redo'))
    const histBtn = h('button', { type: 'button', class: 'cv-btn', title: 'History', onClick: () => toggleHistory() }, ic('clock'))
    const bl = h('div', { class: 'cv-bl cv-glass' }, undoBtn, redoBtn, h('span', { class: 'cv-sep' }), histBtn)
    const zoomLabel = h('button', { type: 'button', class: 'cv-zoom-l', title: 'Reset to 100%', onClick: () => zoomTo(1) }, '100%')
    const br = h('div', { class: 'cv-br cv-glass' },
      h('button', { type: 'button', class: 'cv-btn', title: `Zoom out  ${kbd('Ctrl+-')}`, onClick: () => zoomBy(1 / 1.25) }, ic('minus')),
      zoomLabel,
      h('button', { type: 'button', class: 'cv-btn', title: `Zoom in  ${kbd('Ctrl+=')}`, onClick: () => zoomBy(1.25) }, ic('plus')),
      h('span', { class: 'cv-sep' }),
      h('button', { type: 'button', class: 'cv-btn', title: 'Zoom to fit  Shift+1', onClick: () => fitToContent() }, ic('fit')))
    const histPanel = h('div', { class: 'cv-hist cv-glass', hidden: true })
    const toastEl = h('div', { class: 'cv-toast', hidden: true })
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, class: 'cv-file', onChange: () => onFiles(fileInput.files, S.pointer).finally(() => { fileInput.value = '' }) })
    root.append(stage, editorLayer, empty, top, insp, toolbar, bl, br, histPanel, toastEl, fileInput)
    el.append(root)
    const c2 = canvas.getContext('2d')

    // ---- helpers ------------------------------------------------------------------------------------------------
    const toWorld = (sx, sy) => [S.view.x + sx / S.view.zoom, S.view.y + sy / S.view.zoom]
    const toScreen = (wx, wy) => [(wx - S.view.x) * S.view.zoom, (wy - S.view.y) * S.view.zoom]
    const local = (e) => {
      const r = stage.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top]
    }
    const worldOf = (e) => {
      const [sx, sy] = local(e)
      return toWorld(sx, sy)
    }
    const viewRect = () => ({ x: S.view.x, y: S.view.y, w: S.size.w / S.view.zoom, h: S.size.h / S.view.zoom })
    const gridSize = () => (S.settings.snap ? GRID : 0)

    function toast(text, tone = 'info') {
      toastEl.textContent = text
      toastEl.dataset.tone = tone
      toastEl.hidden = false
      clearTimeout(toast.t)
      toast.t = setTimeout(() => { toastEl.hidden = true }, tone === 'error' ? 6000 : 2600)
      try {
        if (tone === 'error' && ctx.toast) ctx.toast('error', text)
      } catch { /* no toast host */ }
    }

    // ---- redraw (rAF, dirty only) -------------------------------------------------------------------------------
    let raf = 0
    function invalidate() {
      S.dirty = true
      if (!raf && !S.dead) raf = requestAnimationFrame(frame)
    }

    function imageFor(hash, mime) {
      const rec = S.images.get(hash)
      if (rec) return rec.state === 'ready' ? rec.bmp : null
      S.images.set(hash, { state: 'loading' })
      ctx.rpc('getBlob', { id: S.id, hash }).then(async (r) => {
        const bin = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0))
        const bmp = await createImageBitmap(new Blob([bin], { type: r.mime || mime }))
        S.images.set(hash, { state: 'ready', bmp })
        S.imageData.set(hash, `data:${r.mime || mime};base64,${r.data}`)
        invalidate()
      }).catch(() => S.images.set(hash, { state: 'error' }))
      return null
    }

    function frame(now) {
      raf = 0
      if (S.dead) return
      S.dirty = false
      const { w, h: hh, dpr } = S.size
      const c = c2
      c.setTransform(dpr, 0, 0, dpr, 0, 0)
      c.clearRect(0, 0, w, hh)
      let animating = false
      if (S.fly) {
        const t = clamp((now - S.fly.t0) / S.fly.ms, 0, 1)
        const k = 1 - (1 - t) ** 3
        S.view = {
          x: S.fly.from.x + (S.fly.to.x - S.fly.from.x) * k,
          y: S.fly.from.y + (S.fly.to.y - S.fly.from.y) * k,
          zoom: S.fly.from.zoom * (S.fly.to.zoom / S.fly.from.zoom) ** k,
        }
        if (t >= 1) {
          S.view = S.fly.to
          S.fly = null
          viewChanged()
        } else animating = true
        syncZoomLabel()
      }
      if (S.settings.grid) paintGrid(c, S.view, w, hh, S.theme, GRID)
      c.save()
      c.scale(S.view.zoom, S.view.zoom)
      c.translate(-S.view.x, -S.view.y)
      const env = { theme: S.theme, image: imageFor, skip: S.editing && S.editing.hide ? S.editing.hide : null }
      paintShapes(c, shapes(), env, viewRect())
      if (paintOverlay(c, now)) animating = true
      c.restore()
      if (S.editing) placeEditor()
      empty.hidden = shapes().length > 0 || S.tool !== 'select' || !!S.editing
      if (animating || S.dirty) invalidate()
    }

    function paintOverlay(c, now) {
      const z = S.view.zoom
      const px = 1 / z
      const acc = S.theme.accent
      let animating = false
      c.lineJoin = 'round'
      c.lineCap = 'round'
      // agent / remote flashes
      if (S.flash) {
        const age = now - S.flash.t0
        if (age > 1700) S.flash = null
        else {
          animating = true
          const m = mapOf()
          const a = 1 - age / 1700
          c.save()
          c.strokeStyle = S.theme.live
          c.lineWidth = 2 * px
          c.globalAlpha = a * 0.9
          for (const id of S.flash.ids) {
            const s = m.get(id)
            if (!s) continue
            const b = aabb(s)
            c.beginPath()
            c.roundRect(b.x - 6 * px, b.y - 6 * px, b.w + 12 * px, b.h + 12 * px, 6 * px)
            c.stroke()
          }
          c.restore()
        }
      }
      // hover outline
      if (S.tool === 'select' && S.hover && !S.I && !S.sel.has(S.hover)) {
        const s = mapOf().get(S.hover)
        if (s) outline(c, s, acc, 1.2 * px, 0.55)
      }
      // arrow bind target highlight
      if (S.bind) {
        const s = mapOf().get(S.bind)
        if (s) outline(c, s, acc, 2 * px, 0.9, 4 * px)
      }
      // selection
      const sel = selShapes()
      const moving = S.I && (S.I.kind === 'move' || S.I.kind === 'resize' || S.I.kind === 'rotate') && S.I.moved
      if (sel.length) {
        if (sel.length > 1 || isPoly(sel[0])) for (const s of sel) outline(c, s, acc, 1 * px, 0.45)
        if (sel.length === 1 && (sel[0].type === 'line' || sel[0].type === 'arrow')) lineHandles(c, sel[0])
        else {
          const f = selectionFrame(sel)
          if (f) frameHandles(c, f, !moving)
        }
      }
      // guides
      if (S.guides.length) {
        c.save()
        c.strokeStyle = S.theme.live
        c.lineWidth = px
        c.setLineDash([4 * px, 3 * px])
        for (const g of S.guides) {
          c.beginPath()
          if (g.axis === 'x') (c.moveTo(g.pos, g.a - 12 * px), c.lineTo(g.pos, g.b + 12 * px))
          else (c.moveTo(g.a - 12 * px, g.pos), c.lineTo(g.b + 12 * px, g.pos))
          c.stroke()
        }
        c.restore()
      }
      // marquee
      if (S.marquee) {
        const m = S.marquee
        c.save()
        c.fillStyle = acc
        c.globalAlpha = 0.1
        c.fillRect(m.x, m.y, m.w, m.h)
        c.globalAlpha = 0.85
        c.strokeStyle = acc
        c.lineWidth = px
        if (m.touch) c.setLineDash([4 * px, 3 * px])
        c.strokeRect(m.x, m.y, m.w, m.h)
        c.restore()
      }
      // eraser ring
      if (S.tool === 'eraser' && S.eraser) {
        c.save()
        c.strokeStyle = S.theme.ink
        c.globalAlpha = 0.5
        c.lineWidth = px
        c.beginPath()
        c.arc(S.eraser[0], S.eraser[1], 9 * px, 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }
      return animating
    }

    function outline(c, s, color, lw, alpha = 1, pad = 0) {
      c.save()
      c.strokeStyle = color
      c.lineWidth = lw
      c.globalAlpha = alpha
      if (isPoly(s)) {
        const b = aabb(s)
        c.beginPath()
        c.roundRect(b.x - 4 * lw - pad, b.y - 4 * lw - pad, b.w + 8 * lw + pad * 2, b.h + 8 * lw + pad * 2, 3 * lw)
      } else {
        const [cx, cy] = centerOf(s)
        c.translate(cx, cy)
        c.rotate(s.angle || 0)
        c.beginPath()
        c.roundRect(-s.w / 2 - pad, -s.h / 2 - pad, s.w + pad * 2, s.h + pad * 2, s.type === 'ellipse' ? Math.min(s.w, s.h) / 2 : 2 * lw)
      }
      c.stroke()
      c.restore()
    }

    function handleStyle(c) {
      c.fillStyle = '#fff'
      c.strokeStyle = S.theme.accent
      c.lineWidth = 1.4 / S.view.zoom
    }

    function frameHandles(c, f, withHandles) {
      const z = S.view.zoom
      const px = 1 / z
      c.save()
      c.translate(f.x + f.w / 2, f.y + f.h / 2)
      c.rotate(f.angle || 0)
      c.strokeStyle = S.theme.accent
      c.lineWidth = 1.3 * px
      c.beginPath()
      c.rect(-f.w / 2, -f.h / 2, f.w, f.h)
      c.stroke()
      c.restore()
      if (!withHandles) return
      const small = f.w * z < 40 || f.h * z < 40
      const names = small ? ['nw', 'ne', 'se', 'sw'] : Object.keys(HANDLES)
      c.save()
      handleStyle(c)
      for (const n of names) {
        const [x, y] = handlePoint(f, n)
        const r = 4 * px
        c.beginPath()
        c.roundRect(x - r, y - r, r * 2, r * 2, 2 * px)
        c.fill()
        c.stroke()
      }
      const [rx, ry] = handlePoint(f, 'rot', z)
      const [tx, ty] = handlePoint(f, 'n')
      c.beginPath()
      c.moveTo(tx, ty)
      c.lineTo(rx, ry)
      c.strokeStyle = S.theme.accent
      c.globalAlpha = 0.6
      c.stroke()
      c.globalAlpha = 1
      c.beginPath()
      c.arc(rx, ry, 5 * px, 0, Math.PI * 2)
      c.fill()
      c.stroke()
      c.restore()
    }

    function lineHandles(c, s) {
      const px = 1 / S.view.zoom
      c.save()
      handleStyle(c)
      absPts(s).forEach((p, i, a) => {
        const end = i === 0 || i === a.length - 1
        c.beginPath()
        c.arc(p[0], p[1], (end ? 5 : 4) * px, 0, Math.PI * 2)
        c.fill()
        c.stroke()
      })
      if (s.pts.length === 2) {
        const [bx, by] = bendPoint(s)
        c.beginPath()
        c.roundRect(bx - 4 * px, by - 4 * px, 8 * px, 8 * px, 4 * px)
        c.globalAlpha = 0.9
        c.fill()
        c.stroke()
      }
      c.restore()
    }

    const bendPoint = (s) => {
      const [a, b] = absPts(s)
      const [cx, cy] = bendControl({ ...s, pts: s.pts })
      return [(a[0] + b[0]) / 4 + cx / 2, (a[1] + b[1]) / 4 + cy / 2]
    }

    function lineHandleAt(s, wx, wy) {
      const r = 9 / S.view.zoom
      const pts = absPts(s)
      for (let i = 0; i < pts.length; i++) if (Math.hypot(wx - pts[i][0], wy - pts[i][1]) <= r) return { kind: 'point', index: i }
      if (pts.length === 2) {
        const [bx, by] = bendPoint(s)
        if (Math.hypot(wx - bx, wy - by) <= r) return { kind: 'bend' }
      }
      return null
    }

    // ---- sizing ---------------------------------------------------------------------------------------------------
    function resize() {
      const r = stage.getBoundingClientRect()
      const w = Math.max(1, Math.round(r.width))
      const hh = Math.max(1, Math.round(r.height))
      const dpr = window.devicePixelRatio || 1
      if (w === S.size.w && hh === S.size.h && dpr === S.size.dpr && canvas.width) return
      S.size = { w, h: hh, dpr }
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(hh * dpr)
      canvas.style.width = w + 'px'
      canvas.style.height = hh + 'px'
      invalidate()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(stage)
    const dprMq = window.matchMedia ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null
    const onDpr = () => resize()
    if (dprMq && dprMq.addEventListener) dprMq.addEventListener('change', onDpr)

    // theme follows CSS variables on :root
    const themeMo = new MutationObserver(() => {
      S.theme = readTheme(root)
      invalidate()
    })
    themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })

    // ---- viewport -------------------------------------------------------------------------------------------------
    const syncZoomLabel = () => { zoomLabel.textContent = `${Math.round(S.view.zoom * 100)}%` }
    let viewTimer = 0
    function viewChanged() {
      clearTimeout(viewTimer)
      viewTimer = setTimeout(() => sync.touchView(), 50)
    }
    function setView(v, { silent = false } = {}) {
      S.view = { x: v.x, y: v.y, zoom: clampZoom(v.zoom) }
      syncZoomLabel()
      invalidate()
      if (!silent) viewChanged()
    }
    function zoomAt(factor, sx, sy) {
      const z = clampZoom(S.view.zoom * factor)
      const [wx, wy] = toWorld(sx, sy)
      setView({ x: wx - sx / z, y: wy - sy / z, zoom: z })
    }
    const zoomBy = (f) => zoomAt(f, S.size.w / 2, S.size.h / 2)
    const zoomTo = (z) => zoomAt(z / S.view.zoom, S.size.w / 2, S.size.h / 2)
    function flyTo(to, ms = 240) {
      to = { ...to, zoom: clampZoom(to.zoom) }
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return setView(to)
      S.fly = { from: { ...S.view }, to, t0: performance.now(), ms }
      invalidate()
    }
    function fitToContent() {
      const sel = selShapes()
      const box = unionOf(sel.length ? sel : shapes())
      flyTo(box ? fitView(box, S.size.w, S.size.h, 90, 1.5) : { ...DEFAULT_VIEW })
    }

    // ---- history and commits --------------------------------------------------------------------------------------
    function filterSel() {
      const m = mapOf()
      for (const id of [...S.sel]) if (!m.has(id)) S.sel.delete(id)
    }
    function commit(next, label, opts) {
      S.live = null
      if (!S.hist.commit(next, label, opts)) {
        invalidate()
        return false
      }
      filterSel()
      sync.touch(label)
      updateUi()
      invalidate()
      return true
    }
    function undo() {
      if (S.editing) return
      const s = S.hist.undo()
      if (!s) return
      S.live = null
      filterSel()
      sync.touch('Undo')
      updateUi()
      invalidate()
    }
    function redo() {
      if (S.editing) return
      const s = S.hist.redo()
      if (!s) return
      S.live = null
      filterSel()
      sync.touch('Redo')
      updateUi()
      invalidate()
    }
    function jumpTo(i) {
      if (!S.hist.jump(i)) return
      S.live = null
      filterSel()
      sync.touch('History')
      updateUi()
      invalidate()
    }

    // ---- persistence ----------------------------------------------------------------------------------------------
    const sync = new Sync({
      rpc: (method, a) => ctx.rpc(method, a),
      getShapes: () => S.hist.shapes,
      getDoc: () => ({ view: { x: round(S.view.x, 2), y: round(S.view.y, 2), zoom: round(S.view.zoom, 4) }, settings: S.settings, name: S.name }),
      onStatus: (s) => {
        S.status = s
        if (s === 'saved') S.savedAt = Date.now()
        statusEl.dataset.state = s
        statusEl.querySelector('.cv-status-t').textContent = s === 'saved' ? 'Saved' : s === 'saving' ? 'Saving' : 'Not saved'
        statusEl.title = s === 'error' ? 'Could not save; retrying' : S.ephemeral ? 'In memory only' : 'Saved to disk'
      },
      onRemote: (next, meta) => {
        S.live = null
        const label = meta.source === 'agent' ? `Agent: ${meta.label.replace(/^Agent:\s*/, '')}` : meta.label
        if (S.hist.commit(next, label)) {
          filterSel()
          if (meta.source === 'agent' && meta.ids) {
            S.flash = { ids: [...(meta.ids.created || []), ...(meta.ids.changed || [])], t0: performance.now() }
          }
          sync.touch(label)
          updateUi()
          invalidate()
        }
      },
    })

    function loadDoc(snap) {
      S.id = snap.id
      S.name = snap.name
      S.ephemeral = !!snap.ephemeral
      const d = snap.doc
      S.settings = { ...DEFAULT_SETTINGS, ...d.settings }
      S.hist = new History(d.shapes)
      S.live = null
      S.sel.clear()
      S.view = { ...d.view }
      S.images.clear()
      syncZoomLabel()
      nameBtn.querySelector('.cv-name-t').textContent = S.name
      try { ctx.setTitle && ctx.setTitle(S.name) } catch { /* title is cosmetic */ }
      try { ctx.setArgs && ctx.setArgs({ id: S.id }) } catch { /* optional host hook */ }
      try { localStorage.setItem(LAST_KEY, S.id) } catch { /* private mode */ }
      if (snap.recovered) toast('The canvas file was unreadable; it was set aside and a new one started.', 'error')
      else if (d.dropped) toast(`${d.dropped} damaged shape${d.dropped === 1 ? '' : 's'} could not be loaded.`, 'error')
      updateUi()
      invalidate()
    }

    async function open(a) {
      const snap = await sync.open(a)
      loadDoc(snap)
      refitTexts()
    }

    async function switchTo(a) {
      if (S.editing) await commitEdit()
      await sync.flush()
      sync.id = null
      sync.seq = 0
      try { await ctx.rpc('close', { id: S.id }) } catch { /* optional */ }
      await open(a)
    }

    /** Fonts load late: re-measure text shapes once they are in. */
    function refitTexts() {
      const load = (spec) => (document.fonts && document.fonts.load ? document.fonts.load(spec).catch(() => {}) : Promise.resolve())
      cssLoaded.then(() => Promise.all([load('20px Excalifont'), load('20px Geist'), load("20px 'Geist Mono'")])).then(() => {
        if (S.dead) return
        bumpFontEpoch()
        installTextMeasurer()
        const base = S.hist.shapes
        const next = base.map((s) => (s.type === 'text' ? fitText(s) : s))
        if (next.some((s, i) => s !== base[i])) {
          S.hist.entries[S.hist.index] = { ...S.hist.entries[S.hist.index], shapes: next }
          sync.touch('Fonts')
        }
        invalidate()
      })
    }

    // ---- tools ------------------------------------------------------------------------------------------------------
    function setTool(t, { keepLock = false } = {}) {
      if (t === 'image') {
        fileInput.click()
        return
      }
      if (S.editing) commitEdit()
      S.tool = t
      if (!keepLock) S.lock = false
      if (t !== 'select') {
        S.hover = null
        if (t !== 'hand' && S.sel.size) S.sel.clear()
      }
      for (const [id, b] of toolBtns) {
        b.classList.toggle('on', id === t)
        b.setAttribute('aria-pressed', id === t ? 'true' : 'false')
      }
      stage.dataset.tool = t
      updateCursor()
      updateUi()
      invalidate()
    }

    function updateCursor(handle) {
      let c = 'default'
      if (S.I && S.I.kind === 'pan') c = 'grabbing'
      else if (S.space || S.tool === 'hand') c = 'grab'
      else if (S.tool === 'text') c = 'text'
      else if (S.tool !== 'select') c = 'crosshair'
      else if (handle) c = handle
      else if (S.hover) c = 'move'
      if (stage.style.cursor !== c) stage.style.cursor = c
    }

    // ---- shape factories --------------------------------------------------------------------------------------------
    function styleProps(type) {
      const st = S.style
      const p = { stroke: st.stroke, sw: st.sw, dash: st.dash, opacity: st.opacity, rough: st.rough }
      if (type === 'rect' || type === 'ellipse' || type === 'diamond') {
        p.fill = st.fill
        if (type === 'rect') p.round = st.round
      }
      if (type === 'sticky') {
        p.fill = STICKY_COLORS.includes(st.fill) ? st.fill : DEFAULTS.sticky.fill
        p.sw = 0
        p.stroke = 'auto'
        p.rough = false
        p.dash = 'solid'
        p.size = st.size
        p.font = st.font === 'sans' ? 'hand' : st.font
      }
      if (type === 'text') {
        p.size = st.size
        p.font = st.font
        p.align = st.align
        delete p.sw
        delete p.dash
        delete p.rough
      }
      if (type === 'line' || type === 'arrow') {
        p.head = type === 'arrow' ? (st.head === 'none' ? 'arrow' : st.head) : 'none'
        p.headS = st.headS
        delete p.fill
      }
      if (type === 'ink') {
        p.sw = Math.max(2, st.sw * 1.5)
        delete p.dash
        delete p.rough
      }
      return p
    }

    function make(type, props) {
      return parseShape({ type, ...styleProps(type), ...props }, { strict: false })
    }

    const snapPt = (x, y) => (gridSize() ? [snapGrid(x, gridSize()), snapGrid(y, gridSize())] : [x, y])

    // ---- pointer ------------------------------------------------------------------------------------------------------
    const touches = new Map()
    stage.addEventListener('pointerdown', onDown)
    stage.addEventListener('pointermove', onMove)
    stage.addEventListener('pointerup', onUp)
    stage.addEventListener('pointercancel', onCancel)
    stage.addEventListener('lostpointercapture', (e) => {
      if (S.I && S.I.pointerId === e.pointerId && S.I.kind !== 'pinch') onCancel(e)
    })
    stage.addEventListener('dblclick', onDbl)
    stage.addEventListener('contextmenu', onContext)
    stage.addEventListener('wheel', onWheel, { passive: false })
    stage.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault()
    })
    stage.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return
      e.preventDefault()
      onFiles(e.dataTransfer.files, local(e))
    })

    function onDown(e) {
      if (S.dead) return
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, [e.clientX, e.clientY])
        if (touches.size === 2) return startPinch(e)
      }
      if (e.button === 2) return
      root.focus({ preventScroll: true })
      closePopovers()
      if (S.editing) commitEdit()
      try { stage.setPointerCapture(e.pointerId) } catch { /* synthetic events */ }
      const [sx, sy] = local(e)
      const [wx, wy] = toWorld(sx, sy)
      S.pointer = [sx, sy]
      if (e.button === 1 || S.tool === 'hand' || S.space) {
        S.I = { kind: 'pan', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, view: { ...S.view } }
        updateCursor()
        return
      }
      const tol = 5 / S.view.zoom
      switch (S.tool) {
        case 'select': return downSelect(e, wx, wy, tol)
        case 'rect':
        case 'ellipse':
        case 'diamond':
        case 'sticky':
        case 'text': {
          const [x, y] = snapPt(wx, wy)
          S.I = { kind: 'create', type: S.tool, pointerId: e.pointerId, start: [x, y], raw: [wx, wy], id: newId(), moved: false, base: shapes() }
          return
        }
        case 'line':
        case 'arrow': {
          const target = bindTargetAt(shapes(), wx, wy, null, 10 / S.view.zoom)
          const [x, y] = target ? [wx, wy] : snapPt(wx, wy)
          S.I = { kind: 'line', type: S.tool, pointerId: e.pointerId, start: [x, y], bindS: target ? target.id : null, id: newId(), moved: false, base: shapes() }
          return
        }
        case 'pen': {
          const pen = e.pointerType === 'pen'
          S.I = { kind: 'ink', pointerId: e.pointerId, pen, pts: [], p: 0.5, last: null, id: newId(), base: shapes(), t0: e.timeStamp }
          addInkSamples(e)
          return
        }
        case 'eraser': {
          S.I = { kind: 'erase', pointerId: e.pointerId, hit: new Set(), base: shapes() }
          S.eraser = [wx, wy]
          eraseAt(wx, wy)
          return
        }
      }
    }

    function downSelect(e, wx, wy, tol) {
      const sel = selShapes()
      if (sel.length) {
        if (sel.length === 1 && (sel[0].type === 'line' || sel[0].type === 'arrow')) {
          const hd = lineHandleAt(sel[0], wx, wy)
          if (hd && !sel[0].locked) {
            S.I = { kind: 'line-edit', pointerId: e.pointerId, handle: hd, id: sel[0].id, base: shapes(), moved: false }
            return
          }
        } else {
          const f = selectionFrame(sel)
          const hn = handleAt(f, wx, wy, S.view.zoom, { rotation: true, edges: true })
          if (hn && !sel.some((s) => s.locked)) {
            S.I = {
              kind: hn === 'rot' ? 'rotate' : 'resize', handle: hn, pointerId: e.pointerId, frame: f, ids: new Set(S.sel), base: shapes(),
              moved: false, ratio: sel.some((s) => s.type === 'image' || s.type === 'text' || s.type === 'ink'),
            }
            return
          }
        }
      }
      const deep = mod(e)
      const hit = hitTest(shapes(), wx, wy, tol)
      if (hit) {
        if (e.shiftKey) {
          const ids = deep ? [hit.id] : [...expandUnits(shapes(), [hit.id])]
          const on = S.sel.has(hit.id)
          for (const id of ids) on ? S.sel.delete(id) : S.sel.add(id)
          updateUi()
          invalidate()
          S.I = { kind: 'shift-click', pointerId: e.pointerId }
          return
        }
        if (!S.sel.has(hit.id) || deep) {
          S.sel = deep ? new Set([hit.id]) : expandUnits(shapes(), [hit.id])
          updateUi()
        }
        S.I = { kind: 'move', pointerId: e.pointerId, start: [wx, wy], ids: new Set(S.sel), base: shapes(), moved: false, dup: e.altKey, screen: [e.clientX, e.clientY] }
        invalidate()
        return
      }
      if (!e.shiftKey && S.sel.size) {
        S.sel.clear()
        updateUi()
      }
      S.I = { kind: 'marquee', pointerId: e.pointerId, start: [wx, wy], add: e.shiftKey, keep: e.shiftKey ? new Set(S.sel) : new Set(), moved: false }
      invalidate()
    }

    function onMove(e) {
      if (S.dead) return
      const [sx, sy] = local(e)
      S.pointer = [sx, sy]
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.set(e.pointerId, [e.clientX, e.clientY])
        if (S.I && S.I.kind === 'pinch') return movePinch()
      }
      const [wx, wy] = toWorld(sx, sy)
      const I = S.I
      if (!I || I.pointerId !== e.pointerId) {
        hover(e, wx, wy)
        return
      }
      switch (I.kind) {
        case 'pan':
          setView({ x: I.view.x - (e.clientX - I.sx) / I.view.zoom, y: I.view.y - (e.clientY - I.sy) / I.view.zoom, zoom: I.view.zoom })
          break
        case 'move': return moveSel(e, wx, wy)
        case 'resize': return resizeSel(e, wx, wy)
        case 'rotate': return rotateSel(e, wx, wy)
        case 'line-edit': return editLine(e, wx, wy)
        case 'marquee': return dragMarquee(e, wx, wy)
        case 'create': return dragCreate(e, wx, wy)
        case 'line': return dragLine(e, wx, wy)
        case 'ink': return addInkSamples(e)
        case 'erase':
          S.eraser = [wx, wy]
          eraseAt(wx, wy, I.last)
          I.last = [wx, wy]
          break
      }
    }

    function hover(e, wx, wy) {
      let id = null
      let cur
      if (S.tool === 'select') {
        const sel = selShapes()
        if (sel.length) {
          if (sel.length === 1 && (sel[0].type === 'line' || sel[0].type === 'arrow')) {
            if (lineHandleAt(sel[0], wx, wy)) cur = 'pointer'
          } else {
            const hn = handleAt(selectionFrame(sel), wx, wy, S.view.zoom)
            if (hn) cur = handleCursor(hn, selectionFrame(sel).angle)
          }
        }
        if (!cur) {
          const hit = hitTest(shapes(), wx, wy, 5 / S.view.zoom)
          id = hit ? hit.id : null
        }
      } else if (S.tool === 'eraser') {
        S.eraser = [wx, wy]
        invalidate()
      }
      if (id !== S.hover) {
        S.hover = id
        invalidate()
      }
      updateCursor(cur)
    }

    function moveSel(e, wx, wy) {
      const I = S.I
      let dx = wx - I.start[0]
      let dy = wy - I.start[1]
      if (!I.moved) {
        if (Math.hypot(e.clientX - I.screen[0], e.clientY - I.screen[1]) < 3) return
        I.moved = true
        if (I.dup) {
          const r = duplicateShapes(I.base, I.ids, 0)
          I.base = r.shapes
          I.ids = new Set(r.ids)
          S.sel = new Set(r.ids)
          I.dup = false
        }
        const locked = [...I.ids].some((id) => (I.base.find((s) => s.id === id) || {}).locked)
        if (locked) I.locked = true
      }
      if (I.locked) return
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }
      const moving = I.base.filter((s) => I.ids.has(s.id))
      const box = unionOf(moving)
      let sdx = 0
      let sdy = 0
      S.guides = []
      if (box && S.settings.snap && !mod(e)) {
        const view = viewRect()
        const others = []
        for (const s of I.base) {
          if (I.ids.has(s.id)) continue
          const b = aabb(s)
          if (b.x > view.x + view.w || b.y > view.y + view.h || b.x + b.w < view.x || b.y + b.h < view.y) continue
          others.push(b)
        }
        const r = snapMove({ x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }, others, { threshold: 6 / S.view.zoom, grid: GRID, objects: true })
        sdx = r.dx
        sdy = r.dy
        S.guides = r.guides
      }
      S.live = moveShapes(I.base, I.ids, dx + sdx, dy + sdy)
      S.mapOf = null
      invalidate()
    }

    function resizeSel(e, wx, wy) {
      const I = S.I
      I.moved = true
      const nf = resizeFrame(I.frame, I.handle, wx, wy, { keepRatio: e.shiftKey || (I.ratio && I.handle.length === 2), center: e.altKey })
      const base = I.base
      const sel = base.filter((s) => I.ids.has(s.id))
      let next
      if (sel.length === 1 && !isPoly(sel[0])) {
        const s = sel[0]
        let n
        if (s.type === 'text') {
          if (I.handle.length === 2) {
            const k = nf.h / Math.max(1, I.frame.h)
            n = fitText({ ...s, size: clamp(round(s.size * k, 1), 4, 600), fw: false })
            n = { ...n, x: nf.x + (nf.w - n.w) / 2, y: nf.y + (nf.h - n.h) / 2 }
          } else {
            n = fitText({ ...s, w: Math.max(12, nf.w), fw: true })
            n = { ...n, x: nf.x }
            n = { ...n, y: nf.y }
          }
        } else n = { ...s, x: nf.x, y: nf.y, w: nf.w, h: nf.h }
        next = reflowBindings(base.map((x) => (x.id === s.id ? n : x)))
      } else next = scaleShapes(base, I.ids, I.frame, nf)
      S.live = next
      S.mapOf = null
      invalidate()
    }

    function rotateSel(e, wx, wy) {
      const I = S.I
      I.moved = true
      const a = rotationFrom(I.frame, wx, wy, e.shiftKey ? Math.PI / 12 : 0)
      const da = a - (I.frame.angle || 0)
      S.live = rotateShapes(I.base, I.ids, [I.frame.x + I.frame.w / 2, I.frame.y + I.frame.h / 2], da)
      S.mapOf = null
      invalidate()
    }

    function editLine(e, wx, wy) {
      const I = S.I
      I.moved = true
      const s = I.base.find((x) => x.id === I.id)
      if (!s) return
      let n
      if (I.handle.kind === 'bend') {
        const [a, b] = absPts(s)
        const mx = (a[0] + b[0]) / 2
        const my = (a[1] + b[1]) / 2
        const cx = 2 * wx - mx
        const cy = 2 * wy - my
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const l2 = dx * dx + dy * dy || 1
        const bend = clamp(((cx - mx) * -dy + (cy - my) * dx) / l2, -2, 2)
        n = { ...s }
        if (Math.abs(bend) < 0.03) delete n.bend
        else n.bend = round(bend, 3)
      } else {
        const pts = absPts(s)
        const i = I.handle.index
        let p = [wx, wy]
        const end = i === 0 || i === pts.length - 1
        let target = null
        if (end) target = bindTargetAt(I.base, wx, wy, new Set([s.id]), 10 / S.view.zoom)
        if (!target) {
          const other = pts[i === 0 ? 1 : i - 1]
          if (e.shiftKey && other) p = snapAngle(other[0], other[1], wx, wy)
          else if (gridSize() && !mod(e)) p = snapPt(wx, wy)
        }
        S.bind = target ? target.id : null
        pts[i] = [p[0], p[1]]
        n = withAbsPts(s, pts)
        if (end) {
          const k = i === 0 ? 's' : 'e'
          const bind = { ...(s.bind || {}) }
          if (target) bind[k] = target.id
          else delete bind[k]
          if (bind.s || bind.e) n.bind = bind
          else delete n.bind
        }
      }
      S.live = reflowBindings(I.base.map((x) => (x.id === s.id ? n : x)))
      S.mapOf = null
      invalidate()
    }

    function dragMarquee(e, wx, wy) {
      const I = S.I
      I.moved = true
      const x = Math.min(I.start[0], wx)
      const y = Math.min(I.start[1], wy)
      const touch = wx < I.start[0]
      S.marquee = { x, y, w: Math.abs(wx - I.start[0]), h: Math.abs(wy - I.start[1]), touch }
      const hit = shapesInRect(shapes(), S.marquee, touch ? 'touch' : 'contain')
      const ids = expandUnits(shapes(), hit.map((s) => s.id))
      S.sel = new Set([...I.keep, ...ids])
      invalidate()
    }

    function dragCreate(e, wx, wy) {
      const I = S.I
      const dist = Math.hypot(wx - I.raw[0], wy - I.raw[1]) * S.view.zoom
      if (!I.moved && dist < 4) return
      I.moved = true
      let [x, y] = snapPt(wx, wy)
      let w = x - I.start[0]
      let hh = y - I.start[1]
      if (e.shiftKey && I.type !== 'text') {
        const m = Math.max(Math.abs(w), Math.abs(hh))
        w = Math.sign(w || 1) * m
        hh = Math.sign(hh || 1) * m
      }
      if (e.altKey) {
        I.box = { x: I.start[0] - Math.abs(w), y: I.start[1] - Math.abs(hh), w: Math.abs(w) * 2, h: Math.abs(hh) * 2 }
      } else I.box = { x: Math.min(I.start[0], I.start[0] + w), y: Math.min(I.start[1], I.start[1] + hh), w: Math.abs(w), h: Math.abs(hh) }
      if (I.type === 'text') {
        S.marquee = { ...I.box, touch: true }
        invalidate()
        return
      }
      const s = make(I.type, { id: I.id, ...I.box })
      S.live = [...I.base, s]
      S.mapOf = null
      invalidate()
    }

    function dragLine(e, wx, wy) {
      const I = S.I
      const dist = Math.hypot(wx - I.start[0], wy - I.start[1]) * S.view.zoom
      if (!I.moved && dist < 4) return
      I.moved = true
      const target = bindTargetAt(I.base, wx, wy, I.bindS ? new Set([I.bindS]) : null, 10 / S.view.zoom)
      let p = [wx, wy]
      if (!target) {
        if (e.shiftKey) p = snapAngle(I.start[0], I.start[1], wx, wy)
        else if (gridSize() && !mod(e)) p = snapPt(wx, wy)
      }
      S.bind = target ? target.id : null
      I.bindE = target ? target.id : null
      const bind = {}
      if (I.bindS) bind.s = I.bindS
      if (I.bindE) bind.e = I.bindE
      const s = make(I.type, { id: I.id, pts: [[I.start[0], I.start[1]], p], x: 0, y: 0, ...(bind.s || bind.e ? { bind } : {}) })
      S.live = reflowBindings([...I.base, s])
      S.mapOf = null
      invalidate()
    }

    function addInkSamples(e) {
      const I = S.I
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : []
      const list = evs.length ? evs : [e]
      for (const ev of list) {
        const [sx, sy] = local(ev)
        const [wx, wy] = toWorld(sx, sy)
        const last = I.pts[I.pts.length - 1]
        if (last && Math.hypot(wx - last[0], wy - last[1]) < 0.4 / S.view.zoom) continue
        let p
        if (I.pen && ev.pressure > 0) p = ev.pressure
        else {
          p = simulatePressure([last ? [last[0], last[1], I.lastT || ev.timeStamp - 8] : [wx, wy, ev.timeStamp - 8], [wx, wy, ev.timeStamp]])
          p = p[1][2]
          I.sim = I.sim === undefined ? 0.55 : I.sim
          p = I.sim + (p - I.sim) * 0.5
          I.sim = p
        }
        I.pts.push([wx, wy, round(p, 3)])
        I.lastT = ev.timeStamp
      }
      const s = make('ink', { id: I.id, pts: I.pts.map((q) => [q[0], q[1], q[2]]), x: 0, y: 0, pressure: true })
      S.live = [...I.base, s]
      S.mapOf = null
      invalidate()
    }

    function eraseAt(wx, wy, from) {
      const I = S.I
      const r = 9 / S.view.zoom
      const probe = []
      if (from) {
        const n = Math.max(1, Math.ceil(Math.hypot(wx - from[0], wy - from[1]) / (r * 0.6)))
        for (let i = 1; i <= n; i++) probe.push([from[0] + ((wx - from[0]) * i) / n, from[1] + ((wy - from[1]) * i) / n])
      } else probe.push([wx, wy])
      let added = false
      for (const [x, y] of probe) for (const s of hitAll(I.base, x, y, r)) if (!I.hit.has(s.id)) (I.hit.add(s.id), (added = true))
      if (added) {
        S.live = I.base.map((s) => (I.hit.has(s.id) ? { ...s, opacity: s.opacity * 0.2 } : s))
        S.mapOf = null
      }
      invalidate()
    }

    function onUp(e) {
      touches.delete(e.pointerId)
      const I = S.I
      if (I && I.kind === 'pinch') {
        if (touches.size < 2) S.I = null
        return
      }
      if (!I || I.pointerId !== e.pointerId) return
      try { stage.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
      S.I = null
      S.guides = []
      S.marquee = null
      S.bind = null
      const [wx, wy] = worldOf(e)
      switch (I.kind) {
        case 'pan': updateCursor(); break
        case 'move':
          if (I.moved && S.live) commit(S.live, I.ids.size > 1 ? 'Move shapes' : 'Move shape')
          else S.live = null
          break
        case 'resize': if (I.moved && S.live) commit(S.live, 'Resize'); else S.live = null; break
        case 'rotate': if (I.moved && S.live) commit(S.live, 'Rotate'); else S.live = null; break
        case 'line-edit': if (I.moved && S.live) commit(S.live, I.handle.kind === 'bend' ? 'Bend arrow' : 'Edit line'); else S.live = null; break
        case 'marquee': updateUi(); break
        case 'create': finishCreate(I, wx, wy); break
        case 'line': finishLine(I, wx, wy); break
        case 'ink': finishInk(I); break
        case 'erase': finishErase(I); break
      }
      invalidate()
      updateCursor()
    }

    function onCancel() {
      touches.clear()
      const I = S.I
      S.I = null
      S.live = null
      S.guides = []
      S.marquee = null
      S.bind = null
      S.mapOf = null
      if (I && I.kind === 'pan') updateCursor()
      invalidate()
    }

    function afterCreate(id) {
      S.sel = new Set([id])
      if (!S.lock) setTool('select')
      else updateUi()
    }

    function finishCreate(I) {
      S.marquee = null
      if (I.type === 'text') {
        const fixed = I.moved && I.box && I.box.w > 24
        const s = make('text', { id: I.id, x: fixed ? I.box.x : I.raw[0], y: fixed ? I.box.y : I.raw[1] - S.style.size * 0.6, text: '', fw: !!fixed, w: fixed ? I.box.w : 0, h: 0 })
        S.live = [...I.base, s]
        S.mapOf = null
        afterCreateText(s, true)
        return
      }
      let box = I.box
      if (!I.moved || !box || box.w < 6 || box.h < 6) {
        const d = DEFAULTS[I.type]
        box = { x: I.start[0] - d.w / 2, y: I.start[1] - d.h / 2, w: d.w, h: d.h }
        if (gridSize()) box = { ...box, x: snapGrid(box.x, GRID), y: snapGrid(box.y, GRID) }
      }
      const s = make(I.type, { id: I.id, ...box })
      commit([...I.base, s], `Add ${LABEL[I.type]}`)
      afterCreate(s.id)
      if (I.type === 'sticky') startEdit(s.id)
    }

    function afterCreateText(s, isNew) {
      S.sel = new Set([s.id])
      S.tool = 'select'
      for (const [id, b] of toolBtns) b.classList.toggle('on', id === 'select')
      stage.dataset.tool = 'select'
      updateUi()
      startEdit(s.id, { isNew, shape: s })
    }

    function finishLine(I) {
      if (!I.moved || !S.live) {
        S.live = null
        return
      }
      const s = S.live.find((x) => x.id === I.id)
      S.live = null
      if (!s || Math.hypot(s.w, s.h) < 6) return
      commit(reflowBindings([...I.base, s]), `Add ${LABEL[I.type]}`)
      afterCreate(s.id)
    }

    function finishInk(I) {
      S.live = null
      if (!I.pts.length) return
      let pts = I.pts
      pts = simplifyInk(pts, 0.35 / S.view.zoom)
      const s = make('ink', { id: I.id, pts: pts.map((q) => [round(q[0], 2), round(q[1], 2), q[2]]), x: 0, y: 0, pressure: true })
      commit([...I.base, s], 'Draw')
      S.sel.clear()
    }

    function finishErase(I) {
      S.eraser = null
      if (!I.hit.size) {
        S.live = null
        return
      }
      const next = cleanBindings(I.base.filter((s) => !I.hit.has(s.id)))
      commit(next, I.hit.size > 1 ? 'Erase shapes' : 'Erase')
    }

    // ---- pinch (touch) ------------------------------------------------------------------------------------------------
    function startPinch() {
      onCancel()
      const pts = [...touches.values()]
      S.I = { kind: 'pinch', pointerId: -1, d: Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]), c: [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], view: { ...S.view } }
    }
    function movePinch() {
      const I = S.I
      const pts = [...touches.values()]
      if (pts.length < 2) return
      const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1])
      const c = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2]
      const z = clampZoom(I.view.zoom * (d / Math.max(1, I.d)))
      const r = stage.getBoundingClientRect()
      const [wx, wy] = [I.view.x + (I.c[0] - r.left) / I.view.zoom, I.view.y + (I.c[1] - r.top) / I.view.zoom]
      setView({ x: wx - (c[0] - r.left) / z, y: wy - (c[1] - r.top) / z, zoom: z })
    }

    // ---- wheel ----------------------------------------------------------------------------------------------------------
    function onWheel(e) {
      e.preventDefault()
      const [sx, sy] = local(e)
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? S.size.h : 1
      const dy = e.deltaY * unit
      const dx = e.deltaX * unit
      if (e.ctrlKey || e.metaKey) {
        zoomAt(clamp(Math.exp(-dy * 0.0105), 0.6, 1.7), sx, sy)
        return
      }
      // a notched mouse wheel zooms; a trackpad (fine, two-axis deltas) pans
      const notched = e.deltaMode === 1 || (dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy))
      if (notched && !e.shiftKey) zoomAt(Math.exp(-dy * 0.0016), sx, sy)
      else setView({ x: S.view.x + (e.shiftKey && !dx ? dy : dx) / S.view.zoom, y: S.view.y + (e.shiftKey && !dx ? 0 : dy) / S.view.zoom, zoom: S.view.zoom })
    }

    // ---- double click / text editing ---------------------------------------------------------------------------------
    function onDbl(e) {
      if (S.tool !== 'select' && S.tool !== 'text') return
      const [wx, wy] = worldOf(e)
      const hit = hitTest(shapes(), wx, wy, 5 / S.view.zoom, null)
      if (hit && TEXT_TYPES.has(hit.type) && !hit.locked) {
        S.sel = new Set([hit.id])
        updateUi()
        startEdit(hit.id)
        return
      }
      if (hit) return
      const s = make('text', { x: wx, y: wy - S.style.size * 0.6, text: '', w: 0, h: 0 })
      S.live = [...shapes(), s]
      S.mapOf = null
      afterCreateText(s, true)
    }

    const ta = h('textarea', { class: 'cv-editor', spellcheck: false, rows: 1, wrap: 'off' })
    ta.addEventListener('input', () => placeEditor(true))
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        commitEdit()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        commitEdit()
      } else if (e.key === 'Tab') e.preventDefault()
    })
    ta.addEventListener('blur', () => {
      if (S.editing && !S.editing.closing) setTimeout(() => S.editing && !S.editing.closing && commitEdit(), 0)
    })
    ta.addEventListener('paste', (e) => e.stopPropagation())
    ta.addEventListener('copy', (e) => e.stopPropagation())
    ta.addEventListener('cut', (e) => e.stopPropagation())

    function labelGeom(s, text) {
      const pad = s.type === 'sticky' ? 12 : s.type === 'rect' ? 10 : s.type === 'ellipse' ? s.w * 0.14 : s.w * 0.24
      const avail = Math.max(8, s.w - pad * 2)
      const lines = wrapText(text || ' ', avail, s.size, s.font)
      const lh = s.size * LINE_HEIGHT
      const height = Math.max(1, lines.length) * lh
      return { pad, avail, lh, height, top: s.type === 'sticky' ? 10 : Math.max(0, (s.h - height) / 2), center: s.type !== 'sticky' }
    }

    function startEdit(id, opts = {}) {
      const s = opts.shape || mapOf().get(id)
      if (!s || !TEXT_TYPES.has(s.type)) return
      if (S.editing) commitEdit()
      S.editing = { id, isNew: !!opts.isNew, orig: s, hide: new Set(s.type === 'text' ? [id] : []), closing: false }
      if (s.type !== 'text') {
        S.live = shapes().map((x) => (x.id === id ? { ...x, text: '' } : x))
        S.mapOf = null
      }
      ta.value = s.text || ''
      editorLayer.replaceChildren(ta)
      placeEditor(true)
      ta.focus({ preventScroll: true })
      ta.select()
      invalidate()
    }

    function placeEditor(measure) {
      const E = S.editing
      if (!E) return
      const s = E.orig
      const z = S.view.zoom
      const [sx, sy] = toScreen(s.x, s.y)
      const st = ta.style
      st.font = fontString(s.size * z, s.font)
      st.lineHeight = String(LINE_HEIGHT)
      st.color = s.type === 'sticky' ? S.theme.note : resolveColor(s.stroke === 'transparent' ? 'auto' : s.stroke, S.theme)
      st.transformOrigin = 'center center'
      st.textAlign = s.type === 'text' ? s.align : s.type === 'sticky' ? 'left' : 'center'
      if (s.type === 'text') {
        const v = ta.value
        const lines = wrapText(v || ' ', s.fw ? s.w : 0, s.size, s.font)
        let wmax = 0
        for (const l of lines) wmax = Math.max(wmax, fitText({ ...s, text: l, fw: false, w: 0, h: 0 }).w)
        const w = s.fw ? s.w : Math.max(wmax + s.size * 0.6, s.size * 2)
        const hh = Math.max(1, lines.length) * s.size * LINE_HEIGHT
        st.left = sx + 'px'
        st.top = sy + 'px'
        st.width = w * z + 'px'
        st.height = hh * z + 'px'
        st.transform = s.angle ? `rotate(${s.angle}rad)` : 'none'
        st.whiteSpace = s.fw ? 'pre-wrap' : 'pre'
        if (measure) E.size = { w, h: hh }
        return
      }
      const g = labelGeom(s, ta.value)
      st.left = sx + g.pad * z + 'px'
      st.top = sy + g.top * z + 'px'
      st.width = g.avail * z + 'px'
      st.height = g.height * z + 'px'
      st.whiteSpace = 'pre-wrap'
      const [cx, cy] = [(s.x + s.w / 2 - S.view.x) * z, (s.y + s.h / 2 - S.view.y) * z]
      st.transformOrigin = `${cx - (sx + g.pad * z)}px ${cy - (sy + g.top * z)}px`
      st.transform = s.angle ? `rotate(${s.angle}rad)` : 'none'
    }

    async function commitEdit({ cancel = false } = {}) {
      const E = S.editing
      if (!E || E.closing) return
      E.closing = true
      const value = ta.value
      const s = E.orig
      S.editing = null
      editorLayer.replaceChildren()
      S.live = null
      S.mapOf = null
      const base = S.hist.shapes
      const exists = base.some((x) => x.id === E.id)
      if (!cancel) {
        if (s.type === 'text') {
          if (value.trim() === '') {
            if (exists) commit(cleanBindings(base.filter((x) => x.id !== E.id)), 'Delete text')
            S.sel.delete(E.id)
          } else {
            const n = fitText({ ...s, text: value.slice(0, 20000) })
            commit(exists ? base.map((x) => (x.id === E.id ? n : x)) : [...base, n], E.isNew ? 'Add text' : 'Edit text')
          }
        } else if (value !== (s.text || '')) {
          const n = { ...s, text: value.slice(0, 20000) }
          if (!n.text) delete n.text
          commit(base.map((x) => (x.id === E.id ? n : x)), 'Edit text')
        }
      } else if (s.type === 'text' && E.isNew) S.sel.delete(E.id)
      updateUi()
      invalidate()
      root.focus({ preventScroll: true })
    }

    // ---- selection actions ---------------------------------------------------------------------------------------------
    function selIds() {
      return expandUnits(shapes(), [...S.sel])
    }
    function removeSelection() {
      if (!S.sel.size) return
      const ids = selIds()
      const base = S.hist.shapes
      const locked = base.some((s) => ids.has(s.id) && s.locked)
      const next = cleanBindings(base.filter((s) => !ids.has(s.id) || s.locked))
      S.sel.clear()
      if (locked) S.sel = new Set(base.filter((s) => ids.has(s.id) && s.locked).map((s) => s.id))
      commit(next, ids.size > 1 ? 'Delete shapes' : 'Delete shape')
    }
    function duplicateSelection() {
      if (!S.sel.size) return
      const r = duplicateShapes(S.hist.shapes, S.sel, 24)
      if (commit(r.shapes, 'Duplicate')) S.sel = new Set(r.ids)
      updateUi()
    }
    function groupSelection() {
      if (S.sel.size < 2) return
      const r = groupShapes(S.hist.shapes, new Set(S.sel))
      if (r.gid) commit(r.shapes, 'Group')
    }
    function ungroupSelection() {
      const next = ungroupShapes(S.hist.shapes, new Set(S.sel))
      if (next !== S.hist.shapes) commit(next, 'Ungroup')
    }
    function arrange(how) {
      if (!S.sel.size) return
      commit(reorder(S.hist.shapes, selIds(), how), { front: 'Bring to front', back: 'Send to back', forward: 'Bring forward', backward: 'Send backward' }[how])
    }
    function alignSel(edge) {
      commit(alignShapes(S.hist.shapes, selIds(), edge), `Align ${edge}`)
    }
    function distributeSel(axis) {
      commit(distributeShapes(S.hist.shapes, selIds(), axis), `Distribute ${axis === 'x' ? 'horizontally' : 'vertically'}`)
    }
    function layoutSel(kind) {
      const ids = S.sel.size > 1 ? selIds() : new Set(S.hist.shapes.map((s) => s.id))
      const next = layoutShapes(S.hist.shapes, ids, { kind, gap: 40 })
      if (commit(next, `Auto-layout (${kind})`)) fitToContent()
    }
    function selectAll() {
      S.sel = new Set(shapes().filter((s) => !s.locked).map((s) => s.id))
      updateUi()
      invalidate()
    }
    function nudge(dx, dy) {
      if (!S.sel.size) return
      commit(moveShapes(S.hist.shapes, selIds(), dx, dy), 'Nudge', { key: 'nudge', window: 900 })
    }
    function toggleLock() {
      const ids = selIds()
      const all = S.hist.shapes.filter((s) => ids.has(s.id))
      const lock = !all.every((s) => s.locked)
      commit(S.hist.shapes.map((s) => (ids.has(s.id) ? (lock ? { ...s, locked: true } : (({ locked, ...r }) => r)(s)) : s)), lock ? 'Lock' : 'Unlock')
    }

    // ---- clipboard ------------------------------------------------------------------------------------------------------
    function copySel() {
      if (!S.sel.size) return null
      const ids = selIds()
      const list = S.hist.shapes.filter((s) => ids.has(s.id))
      S.clip = list
      S.pasteN = 0
      return CLIP_PREFIX + JSON.stringify({ shapes: list })
    }
    function pasteShapesFrom(list, at) {
      if (!list || !list.length) return
      const box = unionOf(list)
      let dx = 24 * (S.pasteN + 1)
      let dy = dx
      if (at) {
        const [wx, wy] = toWorld(at[0], at[1])
        dx = wx - (box.x + box.w / 2)
        dy = wy - (box.y + box.h / 2)
        if (S.pasteN) {
          dx += 24 * S.pasteN
          dy += 24 * S.pasteN
        }
      }
      const copies = cloneShapes(list, { dx, dy })
      S.pasteN++
      commit([...S.hist.shapes, ...copies], 'Paste')
      S.sel = new Set(copies.map((c) => c.id))
      if (S.tool !== 'select') setTool('select')
      updateUi()
    }
    root.addEventListener('copy', (e) => {
      if (S.editing || isTyping(e.target)) return
      const text = copySel()
      if (text) {
        e.preventDefault()
        e.clipboardData.setData('text/plain', text)
      }
    })
    root.addEventListener('cut', (e) => {
      if (S.editing || isTyping(e.target)) return
      const text = copySel()
      if (text) {
        e.preventDefault()
        e.clipboardData.setData('text/plain', text)
        removeSelection()
      }
    })
    root.addEventListener('paste', (e) => {
      if (S.editing || isTyping(e.target)) return
      e.preventDefault()
      const cd = e.clipboardData
      if (!cd) return
      const files = [...(cd.files || [])].filter((f) => f.type.startsWith('image/'))
      if (files.length) return void onFiles(files, S.pointer)
      const text = cd.getData('text/plain')
      if (text.startsWith(CLIP_PREFIX)) {
        try {
          const raw = JSON.parse(text.slice(CLIP_PREFIX.length))
          const list = normalizeDoc({ shapes: raw.shapes }).shapes
          if (list.length) return void pasteShapesFrom(list, S.pointer)
        } catch { /* not ours: fall through to plain text */ }
      }
      if (S.clip && !text) return void pasteShapesFrom(S.clip, S.pointer)
      if (text.trim()) {
        const [wx, wy] = S.pointer ? toWorld(S.pointer[0], S.pointer[1]) : toWorld(S.size.w / 2, S.size.h / 2)
        const t = make('text', { x: wx, y: wy, text: text.slice(0, 20000), w: 0, h: 0 })
        const n = fitText(t)
        commit([...S.hist.shapes, n], 'Paste text')
        S.sel = new Set([n.id])
        updateUi()
      } else if (S.clip) pasteShapesFrom(S.clip, S.pointer)
    })

    const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)

    // ---- images ------------------------------------------------------------------------------------------------------------
    async function onFiles(files, at) {
      const list = [...files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type))
      if (!list.length) {
        if (files.length) toast('Only PNG, JPEG, GIF and WebP images can be added.', 'error')
        return
      }
      let [wx, wy] = at ? toWorld(at[0], at[1]) : toWorld(S.size.w / 2, S.size.h / 2)
      const added = []
      for (const f of list) {
        try {
          if (f.size > 25 * 1024 * 1024) throw new Error('images are limited to 25 MiB')
          const buf = await f.arrayBuffer()
          const bmp = await createImageBitmap(new Blob([buf], { type: f.type }))
          const data = b64(buf)
          const r = await ctx.rpc('putBlob', { id: S.id, mime: f.type, data })
          S.images.set(r.hash, { state: 'ready', bmp })
          S.imageData.set(r.hash, `data:${f.type};base64,${data}`)
          const k = Math.min(1, 480 / Math.max(bmp.width, bmp.height))
          const w = Math.round(bmp.width * k)
          const hh = Math.round(bmp.height * k)
          const s = parseShape({ type: 'image', hash: r.hash, mime: f.type, nw: bmp.width, nh: bmp.height, x: Math.round(wx - w / 2), y: Math.round(wy - hh / 2), w, h: hh })
          added.push(s)
          wx += 28
          wy += 28
        } catch (err) {
          toast(`Could not add ${f.name || 'the image'}: ${(err && err.message) || err}`, 'error')
        }
      }
      if (!added.length) return
      commit([...S.hist.shapes, ...added], added.length > 1 ? 'Add images' : 'Add image')
      S.sel = new Set(added.map((s) => s.id))
      setTool('select')
    }

    // ---- keyboard ------------------------------------------------------------------------------------------------------------
    root.addEventListener('keydown', onKey)
    root.addEventListener('blur', () => {
      if (S.space) {
        S.space = false
        updateCursor()
      }
    })
    // clicking the floating chrome must not take keyboard focus from the canvas
    root.addEventListener('mousedown', (e) => {
      const t = e.target
      if (t.closest && t.closest('.cv-glass') && !isTyping(t) && t.type !== 'range' && t.type !== 'color') {
        e.preventDefault()
        root.focus({ preventScroll: true })
      }
    })
    root.addEventListener('keyup', (e) => {
      if (e.key === ' ' && S.space) {
        S.space = false
        updateCursor()
      }
    })
    function onKey(e) {
      if (S.dead || isTyping(e.target) || S.editing) return
      const k = e.key
      const m = mod(e)
      if (k === ' ' && !m) {
        e.preventDefault()
        if (!S.space) {
          S.space = true
          updateCursor()
        }
        return
      }
      if (m && !e.altKey) {
        const lower = k.toLowerCase()
        if (lower === 'z') {
          e.preventDefault()
          return e.shiftKey ? redo() : undo()
        }
        if (lower === 'y') return e.preventDefault(), redo()
        if (lower === 'a') return e.preventDefault(), selectAll()
        if (lower === 'd') return e.preventDefault(), duplicateSelection()
        if (lower === 'g') return e.preventDefault(), e.shiftKey ? ungroupSelection() : groupSelection()
        if (lower === 'l') return e.preventDefault(), toggleLock()
        if (k === ']') return e.preventDefault(), arrange(e.shiftKey ? 'front' : 'forward')
        if (k === '[') return e.preventDefault(), arrange(e.shiftKey ? 'back' : 'backward')
        if (k === '0') return e.preventDefault(), zoomTo(1)
        if (k === '=' || k === '+') return e.preventDefault(), zoomBy(1.25)
        if (k === '-') return e.preventDefault(), zoomBy(0.8)
        if (k === "'") return e.preventDefault(), toggleSetting('grid')
        if (lower === 'c' || lower === 'x' || lower === 'v') return // the copy/cut/paste events do the work
        return
      }
      if (k === 'Delete' || k === 'Backspace') {
        e.preventDefault()
        return removeSelection()
      }
      if (k === 'Escape') {
        if (S.I) return onCancel()
        if (S.sel.size) {
          S.sel.clear()
          updateUi()
          invalidate()
        } else if (S.tool !== 'select') setTool('select')
        closePopovers()
        return
      }
      if (k === 'Enter') {
        const sel = selShapes()
        if (sel.length === 1 && TEXT_TYPES.has(sel[0].type)) {
          e.preventDefault()
          startEdit(sel[0].id)
        }
        return
      }
      if (k.startsWith('Arrow') && S.sel.size) {
        e.preventDefault()
        const d = e.shiftKey ? 10 : 1
        return nudge(k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0)
      }
      if (k === '!' || (k === '1' && e.shiftKey)) return e.preventDefault(), fitToContent()
      if (k === 'q' || k === 'Q') {
        S.lock = !S.lock
        toast(S.lock ? 'Tool lock on' : 'Tool lock off')
        return
      }
      if (!e.altKey) {
        const t = TOOL_BY_KEY[k.toLowerCase()]
        if (t) {
          e.preventDefault()
          setTool(t, { keepLock: true })
        }
      }
    }

    // ---- popovers ---------------------------------------------------------------------------------------------------------------
    let pop = null
    function closePopovers() {
      if (pop) {
        pop.remove()
        pop = null
      }
      histPanel.hidden = true
      histBtn.classList.remove('on')
    }
    document.addEventListener('pointerdown', onDocDown, true)
    function onDocDown(e) {
      if (pop && !pop.contains(e.target) && !(e.target.closest && e.target.closest('.cv-name'))) closePopovers()
      else if (!histPanel.hidden && !histPanel.contains(e.target) && !histBtn.contains(e.target)) {
        histPanel.hidden = true
        histBtn.classList.remove('on')
      }
    }

    function menu(items, { x, y, anchor, align = 'left' }) {
      closePopovers()
      const m = h('div', { class: 'cv-menu cv-glass', role: 'menu' })
      for (const it of items) {
        if (it.sep) m.append(h('div', { class: 'cv-menu-sep' }))
        else if (it.header) m.append(h('div', { class: 'cv-menu-h' }, it.header))
        else {
          m.append(h('button', {
            type: 'button', class: 'cv-mi' + (it.danger ? ' danger' : ''), role: 'menuitem', disabled: !!it.disabled,
            onClick: () => { closePopovers(); it.run && it.run() },
          }, h('span', { class: 'cv-mi-ic' }, it.icon ? ic(it.icon) : null), h('span', { class: 'cv-mi-t' }, it.label), it.check ? h('span', { class: 'cv-mi-ck' }, ic('check')) : null, it.kbd ? h('span', { class: 'cv-kbd' }, kbd(it.kbd)) : null))
        }
      }
      root.append(m)
      const rr = root.getBoundingClientRect()
      let left
      let topPos
      if (anchor) {
        const ar = anchor.getBoundingClientRect()
        left = align === 'right' ? ar.right - rr.left - m.offsetWidth : ar.left - rr.left
        topPos = ar.bottom - rr.top + 6
      } else {
        left = x - rr.left
        topPos = y - rr.top
      }
      m.style.left = clamp(left, 8, rr.width - m.offsetWidth - 8) + 'px'
      m.style.top = clamp(topPos, 8, rr.height - m.offsetHeight - 8) + 'px'
      pop = m
      return m
    }

    function toggleSetting(key) {
      S.settings = { ...S.settings, [key]: !S.settings[key] }
      sync.touchView()
      invalidate()
    }

    async function openDocMenu() {
      let list = []
      try {
        list = (await ctx.rpc('list', {})).canvases || []
      } catch { /* the list is optional */ }
      const items = [{ header: 'Canvases' }]
      for (const c of list.slice(0, 8)) items.push({ label: c.name, icon: 'canvas', check: c.id === S.id, run: () => c.id !== S.id && switchTo({ id: c.id }) })
      items.push(
        { label: 'New canvas', icon: 'plusDoc', run: newCanvas },
        { label: 'Rename…', icon: 'pencil', run: renameCanvas },
        { sep: true },
        { header: 'Export' },
        { label: 'Export PNG', icon: 'download', run: () => exportPng(false) },
        { label: 'Copy as PNG', icon: 'copy', run: () => exportPng(true) },
        { label: 'Export SVG', icon: 'download', run: exportSvg },
        { sep: true },
        { label: 'Show grid', icon: 'grid', check: S.settings.grid, kbd: "Ctrl+'", run: () => toggleSetting('grid') },
        { label: 'Snap to shapes and grid', icon: 'magnet', check: S.settings.snap, run: () => toggleSetting('snap') },
        { label: 'Zoom to fit', icon: 'fit', kbd: 'Shift+1', run: fitToContent },
        { sep: true },
        { label: 'Clear canvas', icon: 'trash', danger: true, disabled: !shapes().length, run: clearCanvas },
      )
      menu(items, { anchor: nameBtn })
    }

    async function newCanvas() {
      try {
        const r = await ctx.rpc('create', { name: 'Untitled canvas', ephemeral: S.ephemeral || undefined })
        await switchTo({ id: r.id, ephemeral: r.ephemeral || undefined })
      } catch (err) {
        toast(String((err && err.message) || err), 'error')
      }
    }

    function renameCanvas() {
      const input = h('input', { class: 'cv-rename', type: 'text', value: S.name, maxLength: 120, spellcheck: false })
      const done = (ok) => {
        const v = input.value.trim()
        input.remove()
        nameBtn.hidden = false
        if (ok && v && v !== S.name) {
          S.name = v
          nameBtn.querySelector('.cv-name-t').textContent = v
          try { ctx.setTitle && ctx.setTitle(v) } catch { /* cosmetic */ }
          ctx.rpc('rename', { id: S.id, name: v }).catch((err) => toast(String((err && err.message) || err), 'error'))
        }
        root.focus({ preventScroll: true })
      }
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') done(true)
        else if (e.key === 'Escape') done(false)
      })
      input.addEventListener('blur', () => done(true))
      nameBtn.hidden = true
      top.prepend(input)
      input.focus()
      input.select()
    }

    function clearCanvas() {
      if (!shapes().length) return
      S.sel.clear()
      commit([], 'Clear canvas')
    }

    // ---- export -----------------------------------------------------------------------------------------------------------------
    async function loadImagesFor(list) {
      const want = list.filter((s) => s.type === 'image')
      const t0 = performance.now()
      for (const s of want) imageFor(s.hash, s.mime)
      while (want.some((s) => (S.images.get(s.hash) || {}).state === 'loading') && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 40))
    }
    const exportShapes = () => {
      const sel = selShapes()
      if (!sel.length) return S.hist.shapes
      const ids = selIds()
      return S.hist.shapes.filter((s) => ids.has(s.id))
    }
    const imageGetter = (hash, mime) => {
      const r = S.images.get(hash)
      return r && r.state === 'ready' ? r.bmp : null
    }

    async function exportPng(copy) {
      const list = exportShapes()
      if (!list.length) return toast('Nothing to export yet.')
      await loadImagesFor(list)
      const c = renderToCanvas(list, { scale: 2, pad: 32, background: S.theme.base, theme: S.theme, image: imageGetter })
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
      if (!blob) return toast('Could not render the image.', 'error')
      if (copy) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          toast('Copied as PNG')
        } catch (err) {
          toast(`Could not copy: ${(err && err.message) || err}`, 'error')
        }
      } else {
        download(blob, `${slug(S.name)}.png`)
        toast('Exported PNG')
      }
    }

    async function exportSvg() {
      const list = exportShapes()
      if (!list.length) return toast('Nothing to export yet.')
      await loadImagesFor(list)
      const svg = shapesToSvg(list, { pad: 32, background: S.theme.base, theme: S.theme, images: S.imageData })
      download(new Blob([svg], { type: 'image/svg+xml' }), `${slug(S.name)}.svg`)
      toast('Exported SVG')
    }

    /** `shot` request from the handler: render the canvas as the user sees it (or all content) and send it back. */
    async function answerShot(ev) {
      if (ev.id !== S.id) return
      try {
        let bounds
        let scale = ev.scale || 1
        const list = S.hist.shapes
        if (ev.fit === 'content') {
          bounds = exportBounds(list, 32) || viewRect()
        } else bounds = viewRect()
        // output size: explicit width/height win; otherwise the on-screen size times `scale`
        let k = scale * (ev.fit === 'content' ? Math.min(1, 1600 / Math.max(bounds.w, bounds.h)) : S.view.zoom)
        if (ev.width && ev.height) k = Math.min(ev.width / bounds.w, ev.height / bounds.h)
        else if (ev.width) k = ev.width / bounds.w
        else if (ev.height) k = ev.height / bounds.h
        await loadImagesFor(list)
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.min(4096, Math.round(bounds.w * k)))
        c.height = Math.max(1, Math.min(4096, Math.round(bounds.h * k)))
        const g = c.getContext('2d')
        const kx = c.width / bounds.w
        const ky = c.height / bounds.h
        g.fillStyle = S.theme.base
        g.fillRect(0, 0, c.width, c.height)
        if (S.settings.grid) {
          paintGrid(g, { x: bounds.x, y: bounds.y, zoom: kx }, c.width, c.height, S.theme, GRID)
        }
        g.setTransform(kx, 0, 0, ky, -bounds.x * kx, -bounds.y * ky)
        paintShapes(g, list, { theme: S.theme, image: imageGetter }, bounds)
        await ctx.rpc('shotReply', { req: ev.req, dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height })
      } catch (err) {
        await ctx.rpc('shotReply', { req: ev.req, error: String((err && err.message) || err) }).catch(() => {})
      }
    }

    // ---- context menu -------------------------------------------------------------------------------------------------------
    function onContext(e) {
      e.preventDefault()
      const [wx, wy] = worldOf(e)
      const hit = hitTest(shapes(), wx, wy, 5 / S.view.zoom)
      if (hit && !S.sel.has(hit.id)) {
        S.sel = expandUnits(shapes(), [hit.id])
        updateUi()
        invalidate()
      }
      const has = S.sel.size > 0
      const sel = selShapes()
      const grouped = sel.some((s) => s.g && s.g.length)
      menu([
        { label: 'Cut', icon: 'copy', kbd: 'Ctrl+X', disabled: !has, run: () => { const t = copySel(); if (t) { navigator.clipboard.writeText(t).catch(() => {}); removeSelection() } } },
        { label: 'Copy', icon: 'copy', kbd: 'Ctrl+C', disabled: !has, run: () => { const t = copySel(); if (t) navigator.clipboard.writeText(t).catch(() => {}) } },
        { label: 'Paste', icon: 'dup', kbd: 'Ctrl+V', run: () => pasteFromClipboard(e) },
        { label: 'Duplicate', icon: 'dup', kbd: 'Ctrl+D', disabled: !has, run: duplicateSelection },
        { sep: true },
        { label: 'Group', icon: 'group', kbd: 'Ctrl+G', disabled: S.sel.size < 2, run: groupSelection },
        { label: 'Ungroup', icon: 'ungroup', kbd: 'Ctrl+Shift+G', disabled: !grouped, run: ungroupSelection },
        { label: 'Bring to front', icon: 'front', kbd: 'Ctrl+Shift+]', disabled: !has, run: () => arrange('front') },
        { label: 'Send to back', icon: 'back', kbd: 'Ctrl+Shift+[', disabled: !has, run: () => arrange('back') },
        { sep: true },
        { label: 'Select all', kbd: 'Ctrl+A', run: selectAll },
        { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, disabled: !has, run: removeSelection },
      ], { x: e.clientX, y: e.clientY })
    }

    async function pasteFromClipboard(e) {
      try {
        const items = await navigator.clipboard.read()
        for (const it of items) {
          const type = it.types.find((t) => t.startsWith('image/'))
          if (type) return void onFiles([new File([await it.getType(type)], 'pasted', { type })], local(e))
        }
        const text = await navigator.clipboard.readText()
        if (text.startsWith(CLIP_PREFIX)) {
          const list = normalizeDoc({ shapes: JSON.parse(text.slice(CLIP_PREFIX.length)).shapes }).shapes
          return void pasteShapesFrom(list, local(e))
        }
      } catch { /* clipboard access denied: fall back to the internal clipboard */ }
      if (S.clip) pasteShapesFrom(S.clip, local(e))
    }

    // ---- floating chrome: inspector, history, buttons ---------------------------------------------------------------------------
    let inspBusy = false

    function toggleHistory() {
      if (!histPanel.hidden) {
        histPanel.hidden = true
        histBtn.classList.remove('on')
        return
      }
      closePopovers()
      renderHistory()
      histPanel.hidden = false
      histBtn.classList.add('on')
    }

    function renderHistory() {
      const { entries, index } = S.hist
      const rows = []
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]
        const agent = /^Agent:/.test(e.label)
        rows.push(h('button', { type: 'button', class: 'cv-hrow' + (i === index ? ' on' : '') + (i > index ? ' future' : ''), onClick: () => jumpTo(i) },
          h('span', { class: 'cv-hrow-ic' }, ic(agent ? 'spark' : 'pencil')),
          h('span', { class: 'cv-hrow-t' }, e.label),
          h('span', { class: 'cv-hrow-a' }, i === 0 ? '' : ago(e.ts))))
      }
      histPanel.replaceChildren(h('div', { class: 'cv-hist-h' }, 'History', h('span', null, `${entries.length - 1} change${entries.length === 2 ? '' : 's'}`)), h('div', { class: 'cv-hist-l' }, rows))
    }

    function updateUi() {
      undoBtn.disabled = !S.hist.canUndo
      redoBtn.disabled = !S.hist.canRedo
      if (!histPanel.hidden) renderHistory()
      if (!inspBusy) renderInspector()
      root.classList.toggle('is-empty', shapes().length === 0)
    }

    // inspector ------------------------------------------------------------------------------------------------------------------
    function common(list, key, fallback) {
      if (!list.length) return fallback
      const first = list[0][key]
      return list.every((s) => JSON.stringify(s[key]) === JSON.stringify(first)) ? (first === undefined ? fallback : first) : null
    }

    function applyStyle(patch, label, { key } = {}) {
      Object.assign(S.style, patch)
      const ids = selIds()
      if (ids.size) {
        const next = S.hist.shapes.map((s) => {
          if (!ids.has(s.id) || s.locked) return s
          let n = { ...s }
          for (const k of Object.keys(patch)) {
            if (!appliesTo(k, s)) continue
            if (k === 'sw' && s.type === 'ink') n.sw = Math.max(2, patch.sw * 1.5)
            else n[k] = patch[k]
          }
          if (s.type === 'text' && ('size' in patch || 'font' in patch)) n = fitText({ ...n, fw: s.fw })
          return n
        })
        commit(reflowBindings(next), label, key ? { key } : undefined)
      } else updateUi()
    }

    function appliesTo(k, s) {
      switch (k) {
        case 'fill': return s.type === 'rect' || s.type === 'ellipse' || s.type === 'diamond' || s.type === 'sticky'
        case 'sw': case 'dash': return s.type !== 'text' && s.type !== 'sticky'
        case 'rough': return ['rect', 'ellipse', 'diamond', 'line', 'arrow'].includes(s.type)
        case 'round': return s.type === 'rect'
        case 'size': case 'font': return TEXT_TYPES.has(s.type)
        case 'align': return s.type === 'text'
        case 'head': case 'headS': return s.type === 'arrow' || s.type === 'line'
        default: return true
      }
    }

    const seg = (opts, current, onPick, cls = '') =>
      h('div', { class: `cv-seg ${cls}` }, opts.map((o) =>
        h('button', { type: 'button', class: 'cv-seg-b' + (o.value === current ? ' on' : ''), title: o.title || '', onClick: () => onPick(o.value) }, o.icon ? ic(o.icon) : null, o.text ? h('span', null, o.text) : null)))

    const swatches = (colors, current, onPick, { custom = true } = {}) => {
      const row = h('div', { class: 'cv-sw' })
      for (const c of colors) {
        const isT = c === 'transparent'
        const isAuto = c === 'auto'
        row.append(h('button', {
          type: 'button', class: 'cv-swatch' + (c === current ? ' on' : '') + (isT ? ' none' : '') + (isAuto ? ' auto' : ''), title: isT ? 'None' : isAuto ? 'Automatic (follows the theme)' : c,
          style: isT ? '' : isAuto ? '' : { '--c': c }, onClick: () => onPick(c),
        }))
      }
      if (custom) {
        const inCustom = current && !colors.includes(current)
        const input = h('input', { type: 'color', class: 'cv-color-in', value: /^#[0-9a-f]{6}$/i.test(current || '') ? current : '#3d6fff', title: 'Custom colour' })
        input.addEventListener('input', () => { inspBusy = true; onPick(input.value, true) })
        input.addEventListener('change', () => { inspBusy = false; renderInspector() })
        row.append(h('span', { class: 'cv-swatch custom' + (inCustom ? ' on' : ''), style: inCustom ? { '--c': current } : '' }, input))
      }
      return row
    }

    const lab = (t) => h('div', { class: 'cv-lab' }, t)

    function renderInspector() {
      const sel = selShapes()
      const toolType = DRAW_TOOLS.has(S.tool) ? (S.tool === 'pen' ? 'ink' : S.tool) : null
      if (!sel.length && !toolType) {
        insp.hidden = true
        return
      }
      const types = new Set(sel.length ? sel.map((s) => s.type) : [toolType])
      const has = (...t) => t.some((x) => types.has(x))
      const val = (k, f) => (sel.length ? common(sel.filter((s) => appliesTo(k, s)), k, f) : S.style[k])
      const only = (...t) => [...types].every((x) => t.includes(x))
      const parts = []
      const textual = only('text')
      parts.push(lab(textual ? 'Text colour' : 'Stroke'), swatches(STROKES, val('stroke', S.style.stroke), (c, live) => applyStyle({ stroke: c }, 'Stroke colour', live ? { key: 'stroke' } : undefined)))
      if (has('rect', 'ellipse', 'diamond')) parts.push(lab('Fill'), swatches(FILLS, val('fill', S.style.fill), (c, live) => applyStyle({ fill: c }, 'Fill colour', live ? { key: 'fill' } : undefined)))
      if (has('sticky')) parts.push(lab('Note colour'), swatches(STICKY_COLORS, val('fill', S.style.fill), (c, live) => applyStyle({ fill: c }, 'Note colour', live ? { key: 'fill' } : undefined)))
      const swHas = has('rect', 'ellipse', 'diamond', 'line', 'arrow', 'ink', 'image')
      if (swHas) {
        const cur = sel.length ? common(sel.filter((s) => appliesTo('sw', s)).map((s) => (s.type === 'ink' ? { ...s, sw: s.sw / 1.5 } : s)), 'sw', S.style.sw) : S.style.sw
        const wseg = h('div', { class: 'cv-seg widths' }, WIDTHS.map((w) => h('button', {
          type: 'button', class: 'cv-seg-b' + (w === cur ? ' on' : ''), title: `${w}px`, onClick: () => applyStyle({ sw: w }, 'Stroke width'),
        }, h('i', { class: 'cv-wbar', style: { height: Math.max(1.5, w * 0.9) + 'px' } }))))
        parts.push(lab('Stroke width'), wseg)
      }
      if (has('rect', 'ellipse', 'diamond', 'line', 'arrow')) {
        parts.push(lab('Stroke style'), seg([{ value: 'solid', icon: 'solid', title: 'Solid' }, { value: 'dashed', icon: 'dashed', title: 'Dashed' }, { value: 'dotted', icon: 'dotted', title: 'Dotted' }], val('dash', S.style.dash), (v) => applyStyle({ dash: v }, 'Stroke style')))
        parts.push(lab('Look'), seg([{ value: false, icon: 'clean', title: 'Clean', text: 'Clean' }, { value: true, icon: 'rough', title: 'Hand-drawn (wobble stroke)', text: 'Sketchy' }], val('rough', S.style.rough), (v) => applyStyle({ rough: v }, v ? 'Hand-drawn' : 'Clean look'), 'wide'))
      }
      if (has('rect')) parts.push(lab('Corners'), seg([{ value: false, icon: 'sharp', title: 'Sharp' }, { value: true, icon: 'roundc', title: 'Rounded' }], val('round', S.style.round), (v) => applyStyle({ round: v }, 'Corners')))
      if (has('text', 'sticky') || sel.some((s) => TEXT_TYPES.has(s.type) && s.text)) {
        parts.push(lab('Font'), seg([{ value: 'sans', text: 'Sans', title: 'Geist' }, { value: 'hand', text: 'Hand', title: 'Excalifont (hand-drawn)' }, { value: 'mono', text: 'Mono', title: 'Geist Mono' }], val('font', S.style.font), (v) => applyStyle({ font: v }, 'Font'), 'wide font'))
        parts.push(lab('Size'), seg(SIZES.map(([t, v]) => ({ value: v, text: t, title: `${v}px` })), val('size', S.style.size), (v) => applyStyle({ size: v }, 'Text size')))
      }
      if (has('text')) parts.push(lab('Align'), seg([{ value: 'left', icon: 'aLeft', title: 'Left' }, { value: 'center', icon: 'aCenter', title: 'Centre' }, { value: 'right', icon: 'aRight', title: 'Right' }], val('align', S.style.align), (v) => applyStyle({ align: v }, 'Text align')))
      if (has('arrow', 'line')) {
        const heads = [{ value: 'none', icon: 'hNone', title: 'None' }, { value: 'arrow', icon: 'hArrow', title: 'Arrow' }, { value: 'triangle', icon: 'hTriangle', title: 'Triangle' }, { value: 'dot', icon: 'hDot', title: 'Dot' }, { value: 'bar', icon: 'hBar', title: 'Bar' }]
        parts.push(lab('Start'), seg(heads, val('headS', S.style.headS), (v) => applyStyle({ headS: v }, 'Arrow start')), lab('End'), seg(heads, val('head', S.style.head), (v) => applyStyle({ head: v }, 'Arrow end')))
      }
      const op = h('input', { type: 'range', min: 0, max: 100, step: 1, class: 'cv-range', value: Math.round((val('opacity', S.style.opacity) ?? 1) * 100), title: 'Opacity' })
      op.addEventListener('input', () => {
        inspBusy = true
        opv.textContent = op.value
        applyStyle({ opacity: Number(op.value) / 100 }, 'Opacity', { key: 'opacity' })
      })
      op.addEventListener('change', () => { inspBusy = false; renderInspector() })
      const opv = h('span', { class: 'cv-range-v' }, String(op.value))
      parts.push(lab('Opacity'), h('div', { class: 'cv-range-row' }, op, opv))
      if (sel.length) {
        const ids = selIds()
        const many = ids.size > 1
        const grouped = sel.some((s) => s.g && s.g.length)
        const btn = (icon, title, run, extra = '') => h('button', { type: 'button', class: 'cv-btn sm ' + extra, title, onClick: run }, ic(icon))
        parts.push(lab('Layers'), h('div', { class: 'cv-btnrow' }, btn('back', `Send to back  ${kbd('Ctrl+Shift+[')}`, () => arrange('back')), btn('backward', `Send backward  ${kbd('Ctrl+[')}`, () => arrange('backward')), btn('forward', `Bring forward  ${kbd('Ctrl+]')}`, () => arrange('forward')), btn('front', `Bring to front  ${kbd('Ctrl+Shift+]')}`, () => arrange('front'))))
        if (many) {
          parts.push(lab('Align'), h('div', { class: 'cv-btnrow' }, ...[['aLeft', 'left'], ['aCenter', 'center'], ['aRight', 'right'], ['aTop', 'top'], ['aMiddle', 'middle'], ['aBottom', 'bottom']].map(([i, e]) => btn(i, `Align ${e}`, () => alignSel(e)))))
          parts.push(lab('Distribute and layout'), h('div', { class: 'cv-btnrow' }, btn('distX', 'Distribute horizontally', () => distributeSel('x')), btn('distY', 'Distribute vertically', () => distributeSel('y')), h('span', { class: 'cv-sep' }), btn('layGrid', 'Auto-layout: grid', () => layoutSel('grid')), btn('layTree', 'Auto-layout: tree (follows arrows)', () => layoutSel('tree'))))
        }
        parts.push(lab('Actions'), h('div', { class: 'cv-btnrow' },
          btn('dup', `Duplicate  ${kbd('Ctrl+D')}`, duplicateSelection),
          btn('group', `Group  ${kbd('Ctrl+G')}`, groupSelection, many ? '' : 'off'),
          btn('ungroup', `Ungroup  ${kbd('Ctrl+Shift+G')}`, ungroupSelection, grouped ? '' : 'off'),
          btn('trash', 'Delete  Del', removeSelection, 'danger')))
      }
      insp.replaceChildren(...parts)
      insp.hidden = false
    }

    // ---- remote events --------------------------------------------------------------------------------------------------------------
    const offEvent = ctx.onEvent((event, payload) => {
      // hosts pass either (event, payload) or one { event, payload } object
      let ev = event
      let p = payload
      if (event && typeof event === 'object') {
        ev = event.event
        p = event.payload
      }
      if (!p || S.dead) return
      if (ev === 'changed') sync.remote(p)
      else if (ev === 'shot') answerShot(p)
      else if (ev === 'error' && p.id === S.id) toast(p.message || 'Could not save the canvas.', 'error')
    })

    // ---- go ---------------------------------------------------------------------------------------------------------------------------
    setTool('select')
    syncZoomLabel()
    S.theme = readTheme(root)
    cssLoaded.then(() => {
      if (S.dead) return
      S.theme = readTheme(root)
      invalidate()
    })
    resize()
    let startArgs = { path: args.path, id: args.id, ephemeral: args.ephemeral, name: args.name }
    if (!startArgs.path && !startArgs.id) {
      try {
        startArgs.id = localStorage.getItem(LAST_KEY) || undefined
      } catch { /* no storage */ }
    }
    open(startArgs).catch((err) => {
      // a stale remembered id (file deleted) opens a fresh one; anything else is shown
      if (!args.id && !args.path && startArgs.id) return open({}).catch((e2) => toast(String((e2 && e2.message) || e2), 'error'))
      toast(String((err && err.message) || err), 'error')
    })

    return {
      focus: () => root.focus({ preventScroll: true }),
      resize,
      dispose() {
        if (S.dead) return
        S.dead = true
        cancelAnimationFrame(raf)
        clearTimeout(viewTimer)
        ro.disconnect()
        themeMo.disconnect()
        document.removeEventListener('pointerdown', onDocDown, true)
        if (dprMq && dprMq.removeEventListener) dprMq.removeEventListener('change', onDpr)
        try { typeof offEvent === 'function' && offEvent() } catch { /* already gone */ }
        const finish = S.editing ? commitEdit() : Promise.resolve()
        finish.then(() => sync.flush()).finally(() => {
          sync.dispose()
          ctx.rpc('close', { id: S.id }).catch(() => {})
        })
        root.remove()
      },
      /** Test and automation access (the harness drives the block through this). */
      debug: {
        S, sync, commit, setTool, undo, redo, selectAll, groupSelection, ungroupSelection, duplicateSelection, removeSelection, fitToContent,
        setView, toWorld, toScreen, layoutSel, alignSel, distributeSel, arrange, startEdit, commitEdit, exportPng, exportSvg, answerShot,
        openDocMenu, toggleHistory, shapes: () => shapes(), invalidate, applyStyle, make, linePath, distToSegment, ZOOM_MAX, ZOOM_MIN,
        flush: () => sync.flush(),
      },
    }
  },
}
