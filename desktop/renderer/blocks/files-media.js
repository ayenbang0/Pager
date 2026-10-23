// Viewers of the Files block that are not text editors: image (zoom / pan), audio, video, PDF (pdf.js, lazy) and hex.
import { h } from '../ui/dom.js'
import { hexRow, humanSize } from './files-util.js'

const svg = (d) => `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
const btn = (title, d, on) => h('button', { class: 'fb-ib', title, 'aria-label': title, html: svg(d), onClick: on })

// ---------------------------------------------------------------------------------------------------- image

export function createImageView(host, { url, name, size, onInfo }) {
  const stage = h('div', { class: 'fb-img' })
  const img = h('img', { alt: name, draggable: false })
  const info = h('span', { class: 'fb-img-info' }, humanSize(size || 0))
  let scale = 1
  let fit = true
  let tx = 0
  let ty = 0
  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
    zoomLbl.textContent = fit ? 'Fit' : Math.round(scale * 100) + '%'
  }
  const fitNow = () => {
    if (!img.naturalWidth) return
    const r = stage.getBoundingClientRect()
    const pad = 32
    scale = Math.min(1, (r.width - pad) / img.naturalWidth, (r.height - pad) / img.naturalHeight)
    if (!isFinite(scale) || scale <= 0) scale = 1
    fit = true
    tx = ty = 0
    apply()
  }
  const zoomLbl = h('span', { class: 'fb-zoom' }, 'Fit')
  const zoomTo = (s, cx = 0, cy = 0) => {
    const k = Math.max(0.05, Math.min(32, s)) / scale
    tx = cx - (cx - tx) * k
    ty = cy - (cy - ty) * k
    scale *= k
    fit = false
    apply()
  }
  const bar = h('div', { class: 'fb-img-bar' },
    info,
    btn('Zoom out', '<path d="M3.5 8h9"/>', () => zoomTo(scale / 1.25)),
    zoomLbl,
    btn('Zoom in', '<path d="M8 3.5v9M3.5 8h9"/>', () => zoomTo(scale * 1.25)),
    btn('Actual size', '<rect x="3" y="4" width="10" height="8" rx="1.5"/><path d="M6.5 6.5v3"/>', () => { scale = 1; tx = ty = 0; fit = false; apply() }),
    btn('Fit', '<path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/>', fitNow))
  stage.append(img, bar)
  host.append(stage)
  img.addEventListener('load', () => {
    info.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${humanSize(size || 0)}`
    onInfo && onInfo(img.naturalWidth, img.naturalHeight)
    fitNow()
  })
  img.addEventListener('error', () => stage.classList.add('broken'))
  img.src = url
  stage.addEventListener('wheel', (e) => {
    e.preventDefault()
    const r = stage.getBoundingClientRect()
    zoomTo(scale * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2)
  }, { passive: false })
  let drag = null
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.fb-img-bar')) return
    drag = { x: e.clientX, y: e.clientY, tx, ty }
    stage.setPointerCapture(e.pointerId)
    stage.classList.add('grab')
  })
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return
    tx = drag.tx + e.clientX - drag.x
    ty = drag.ty + e.clientY - drag.y
    apply()
  })
  const end = () => { drag = null; stage.classList.remove('grab') }
  stage.addEventListener('pointerup', end)
  stage.addEventListener('pointercancel', end)
  stage.addEventListener('dblclick', () => (fit ? (scale = 1, tx = ty = 0, fit = false, apply()) : fitNow()))
  const ro = new ResizeObserver(() => { if (fit) fitNow() })
  ro.observe(stage)
  return { el: stage, destroy() { ro.disconnect(); stage.remove() } }
}

// ---------------------------------------------------------------------------------------------------- audio / video

export function createAvView(host, { kind, url, name, size }) {
  const media = h(kind === 'video' ? 'video' : 'audio', { controls: true, preload: 'metadata', src: url })
  const el = h('div', { class: 'fb-av ' + kind },
    kind === 'video' ? media : h('div', { class: 'fb-av-card' }, h('div', { class: 'fb-av-name' }, name), h('div', { class: 'fb-av-meta' }, humanSize(size || 0)), media))
  host.append(el)
  return { el, destroy() { try { media.pause() } catch { /* gone */ } media.removeAttribute('src'); media.load(); el.remove() } }
}

// ---------------------------------------------------------------------------------------------------- PDF

let pdfP = null
const loadPdf = () => (pdfP ||= import('../vendor/files/pdf.js').then((m) => {
  m.GlobalWorkerOptions.workerSrc = new URL('../vendor/files/pdf.worker.js', import.meta.url).href
  return m
}))

export function createPdfView(host, { rpc, path, root }) {
  const el = h('div', { class: 'fb-pdf' })
  const pages = h('div', { class: 'fb-pdf-pages' })
  const label = h('span', { class: 'fb-zoom' }, '')
  let zoom = 0 // 0 = fit width
  let pdf = null
  let destroyed = false
  const slots = []
  const bar = h('div', { class: 'fb-img-bar' },
    label,
    btn('Zoom out', '<path d="M3.5 8h9"/>', () => setZoom((zoom || curScale()) / 1.2)),
    btn('Zoom in', '<path d="M8 3.5v9M3.5 8h9"/>', () => setZoom((zoom || curScale()) * 1.2)),
    btn('Fit width', '<path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/>', () => setZoom(0)))
  el.append(pages, bar)
  host.append(el)

  const msg = (t) => { pages.textContent = ''; pages.append(h('div', { class: 'fb-empty' }, t)) }
  let base = { w: 612, h: 792 }
  const curScale = () => (zoom || Math.max(0.3, (el.clientWidth - 48) / base.w))
  const io = new IntersectionObserver((ents) => {
    for (const e of ents) {
      const s = e.target.__slot
      e.target.__visible = e.isIntersecting
      if (e.isIntersecting) draw(s)
      else if (s.canvas) release(s)
    }
  }, { root: el, rootMargin: '600px 0px' })

  function layout() {
    const sc = curScale()
    for (const s of slots) {
      s.el.style.width = Math.round((s.w || base.w) * sc) + 'px'
      s.el.style.height = Math.round((s.h || base.h) * sc) + 'px'
      if (s.canvas) release(s)
    }
    label.textContent = Math.round(sc * 100) + '%'
    for (const s of slots) if (s.el.__visible) draw(s)
  }
  function setZoom(z) { zoom = z ? Math.max(0.2, Math.min(6, z)) : 0; layout() }

  function release(s) {
    if (s.task) { try { s.task.cancel() } catch { /* done */ } s.task = null }
    if (s.canvas) { s.canvas.remove(); s.canvas = null }
    s.drawn = 0
  }
  async function draw(s) {
    const sc = curScale()
    if (s.drawn === sc || !pdf) return
    s.drawn = sc
    try {
      const page = await pdf.getPage(s.n)
      if (destroyed) return
      const vp1 = page.getViewport({ scale: 1 })
      s.w = vp1.width
      s.h = vp1.height
      const vp = page.getViewport({ scale: sc * (window.devicePixelRatio || 1) })
      const canvas = h('canvas', { width: Math.floor(vp.width), height: Math.floor(vp.height) })
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      s.el.style.width = Math.round(vp1.width * sc) + 'px'
      s.el.style.height = Math.round(vp1.height * sc) + 'px'
      if (s.task) { try { s.task.cancel() } catch { /* done */ } }
      s.task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp })
      await s.task.promise
      if (destroyed || s.drawn !== sc) return
      if (s.canvas) s.canvas.remove()
      s.canvas = canvas
      s.el.append(canvas)
    } catch (e) {
      if (!e || e.name !== 'RenderingCancelledException') s.drawn = 0
    }
  }

  ;(async () => {
    msg('Loading PDF…')
    try {
      const [lib, bin] = await Promise.all([loadPdf(), rpc('readBinary', { path, root })])
      if (destroyed) return
      const raw = atob(bin.b64)
      const data = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i)
      pdf = await lib.getDocument({
        data,
        cMapUrl: new URL('../vendor/files/pdf-cmaps/', import.meta.url).href, cMapPacked: true,
        standardFontDataUrl: new URL('../vendor/files/pdf-standard_fonts/', import.meta.url).href,
      }).promise
      if (destroyed) return
      const first = await pdf.getPage(1)
      const vp = first.getViewport({ scale: 1 })
      base = { w: vp.width, h: vp.height }
      pages.textContent = ''
      for (let n = 1; n <= pdf.numPages; n++) {
        const slot = { n, el: h('div', { class: 'fb-pdf-page' }), canvas: null, task: null, drawn: 0, w: n === 1 ? vp.width : 0, h: n === 1 ? vp.height : 0 }
        slot.el.__slot = slot
        slots.push(slot)
        pages.append(slot.el)
        io.observe(slot.el)
      }
      layout()
    } catch (e) {
      msg('This PDF could not be shown: ' + ((e && e.message) || e))
    }
  })()
  const ro = new ResizeObserver(() => { if (!zoom && slots.length) layout() })
  ro.observe(el)
  el.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    setZoom((zoom || curScale()) * Math.exp(-e.deltaY * 0.002))
  }, { passive: false })
  return {
    el,
    destroy() {
      destroyed = true
      io.disconnect(); ro.disconnect()
      for (const s of slots) release(s)
      if (pdf) { try { pdf.destroy() } catch { /* gone */ } }
      el.remove()
    },
  }
}

// ---------------------------------------------------------------------------------------------------- hex

const HEX_ROW = 20
const PAGE = 16 * 1024

/** Virtual hex dump: only the rows in view exist in the DOM, bytes are fetched 16 KiB at a time. */
export function createHexView(host, { rpc, path, root, size, onCursor }) {
  const el = h('div', { class: 'fb-hex', tabIndex: 0 })
  const pad = h('div', { class: 'fb-hex-pad' })
  const view = h('div', { class: 'fb-hex-rows' })
  el.append(pad, view)
  host.append(el)
  const rows = Math.ceil(size / 16)
  pad.style.height = Math.max(rows, 1) * HEX_ROW + 'px'
  const cache = new Map() // page index -> Uint8Array
  const pending = new Set()
  let destroyed = false

  async function ensure(page) {
    if (cache.has(page) || pending.has(page)) return
    pending.add(page)
    try {
      const r = await rpc('hex', { path, root, offset: page * PAGE, length: PAGE })
      const raw = atob(r.b64)
      const b = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i)
      cache.set(page, b)
      if (cache.size > 64) cache.delete(cache.keys().next().value)
    } catch { cache.set(page, new Uint8Array(0)) } finally { pending.delete(page) }
    if (!destroyed) paint()
  }

  function paint() {
    const first = Math.max(0, Math.floor(el.scrollTop / HEX_ROW) - 4)
    const count = Math.ceil(el.clientHeight / HEX_ROW) + 8
    const last = Math.min(rows, first + count)
    const frag = document.createDocumentFragment()
    for (let r = first; r < last; r++) {
      const off = r * 16
      const page = Math.floor(off / PAGE)
      const data = cache.get(page)
      const line = h('div', { class: 'fb-hex-row' })
      if (!data) {
        ensure(page)
        line.append(h('span', { class: 'o' }, off.toString(16).padStart(8, '0')))
      } else {
        const x = hexRow(data, off - page * PAGE, off)
        line.append(h('span', { class: 'o' }, x.off), h('span', { class: 'x' }, x.hex), h('span', { class: 'a' }, x.asc))
      }
      frag.append(line)
    }
    view.style.transform = `translateY(${first * HEX_ROW}px)`
    view.textContent = ''
    view.append(frag)
    onCursor && onCursor(Math.min(rows, Math.floor(el.scrollTop / HEX_ROW) + 1) * 16 - 16)
  }
  el.addEventListener('scroll', paint, { passive: true })
  const ro = new ResizeObserver(paint)
  ro.observe(el)
  paint()
  return { el, destroy() { destroyed = true; ro.disconnect(); el.remove() }, focus: () => el.focus() }
}
