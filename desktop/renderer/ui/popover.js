// Popover menus (+ submenus), attribute-driven tooltips, and the shared overlay mount points.
//   showMenu({ anchor, items, align, onClose }) -> { close() }      closeMenus()      initTooltips()
import { h, clamp } from './dom.js'
import { icon } from './icons.js'

/** #overlay / #toasts are created on demand so a bare page works. */
export function overlayEl() {
  let el = document.getElementById('overlay')
  if (!el) {
    el = h('div', { id: 'overlay' })
    document.body.append(el)
  }
  return el
}
export function toastsEl() {
  let el = document.getElementById('toasts')
  if (!el) {
    el = h('div', { id: 'toasts' })
    document.body.append(el)
  }
  return el
}

/** 'Ctrl+Shift+A' -> ['Ctrl','Shift','A']; 'Ctrl++' -> ['Ctrl','+']. */
export function splitKeys(chord) {
  const out = []
  let cur = ''
  for (const ch of String(chord || '')) {
    if (ch === '+' && cur) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** <span class="kbds"> with one .kbd per key; space separates chord sequences ('Ctrl+K Ctrl+C'), shown with a '›'. */
export function kbds(chord, cls = '') {
  const el = h('span', { class: ('kbds ' + cls).trim() })
  String(chord || '').trim().split(/\s+/).filter(Boolean).forEach((seq, i) => {
    if (i) el.append(h('span', { class: 'sep' }, '›'))
    for (const k of splitKeys(seq)) el.append(h('span', { class: 'kbd' }, k))
  })
  return el
}

// ------------------------------------------------------------------ menus

let M = null // the open menu session

const rectOf = (a) => {
  if (!a) return { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 3, bottom: innerHeight / 3, point: true }
  if (typeof Element !== 'undefined' && a instanceof Element) return a.getBoundingClientRect()
  if ('width' in a && 'height' in a && ('left' in a || 'x' in a)) {
    const left = a.left ?? a.x
    const top = a.top ?? a.y
    return { left, top, right: left + a.width, bottom: top + a.height }
  }
  return { left: a.x, right: a.x, top: a.y, bottom: a.y, point: true }
}

function place(el, rect, align) {
  const m = 8
  const gap = rect.point ? 2 : 6
  el.style.left = '0px'
  el.style.top = '0px'
  const w = el.offsetWidth
  const hh = el.offsetHeight
  let left = align === 'end' ? rect.right - w : rect.left
  left = clamp(left, m, Math.max(m, innerWidth - w - m))
  let top = rect.bottom + gap
  if (top + hh > innerHeight - m) {
    const above = rect.top - gap - hh
    if (above >= m) {
      top = above
      el.classList.add('up')
    } else {
      const roomBelow = innerHeight - m - top
      const roomAbove = rect.top - gap - m
      if (roomAbove > roomBelow) {
        el.style.maxHeight = roomAbove + 'px'
        top = m
        el.classList.add('up')
      } else el.style.maxHeight = roomBelow + 'px'
    }
  }
  el.style.left = left + 'px'
  el.style.top = top + 'px'
}

function placeSub(el, parentEl, rowEl) {
  const m = 8
  const p = parentEl.getBoundingClientRect()
  const r = rowEl.getBoundingClientRect()
  el.style.left = '0px'
  el.style.top = '0px'
  const w = el.offsetWidth
  const hh = el.offsetHeight
  let left = p.right + 2
  if (left + w > innerWidth - m) left = Math.max(m, p.left - w - 2)
  let top = r.top - 6
  if (top + hh > innerHeight - m) top = Math.max(m, innerHeight - m - hh)
  if (hh > innerHeight - 2 * m) el.style.maxHeight = innerHeight - 2 * m + 'px'
  el.style.left = left + 'px'
  el.style.top = top + 'px'
}

function buildLevel(items, parent) {
  const el = h('div', { class: 'pop' + (parent ? ' sub' : ''), role: 'menu' })
  const lv = { el, rows: [], sel: -1, parent, subTimer: 0 }
  const hasIcon = items.some((i) => i.icon)
  const hasCheck = items.some((i) => i.check !== undefined)
  el.addEventListener('mousedown', (e) => e.preventDefault())
  for (const item of items) {
    if (item.sep) {
      el.append(h('div', { class: 'mi-sep', role: 'separator' }))
      continue
    }
    if (item.section) el.append(h('div', { class: 'mi-sec', role: 'presentation' }, item.section))
    if (item.label === undefined || item.label === null) continue
    const kids = item.children && item.children.length ? item.children : null
    const row = h(
      'button',
      { class: 'mi' + (item.danger ? ' danger' : '') + (item.disabled ? ' dis' : ''), type: 'button', role: 'menuitem', tabindex: -1 },
      hasIcon && h('span', { class: 'mi-ic' }, item.icon ? icon(item.icon, 15) : null),
      h('span', { class: 'mi-l' }, item.label),
      item.hint && h('span', { class: 'mi-hint' }, item.hint),
      item.keys && kbds(item.keys),
      hasCheck && h('span', { class: 'mi-ck' }, item.check ? icon('check', 14) : null),
      kids && h('span', { class: 'mi-arrow' }, icon('chev-r', 12)),
    )
    if (item.disabled) row.setAttribute('aria-disabled', 'true')
    if (item.check !== undefined) row.setAttribute('aria-checked', item.check ? 'true' : 'false')
    const rec = { item, el: row, kids, lv }
    lv.rows.push(rec)
    row.addEventListener('pointermove', () => hoverRow(rec))
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      activate(rec)
    })
    el.append(row)
  }
  return lv
}

function setSel(lv, i) {
  if (lv.sel === i) return
  if (lv.rows[lv.sel]) lv.rows[lv.sel].el.classList.remove('sel')
  lv.sel = i
  const r = lv.rows[i]
  if (r) {
    r.el.classList.add('sel')
    r.el.scrollIntoView({ block: 'nearest' })
  }
}

function hoverRow(rec) {
  const lv = rec.lv
  if (rec.item.disabled) return
  const i = lv.rows.indexOf(rec)
  if (lv.sel !== i) setSel(lv, i)
  clearTimeout(lv.subTimer)
  const idx = M.levels.indexOf(lv)
  const open = M.levels[idx + 1]
  if (rec.kids) {
    if (open && open.parent === lv && open.from === rec) return
    lv.subTimer = setTimeout(() => M && openSub(rec, false), 110)
  } else if (open) {
    lv.subTimer = setTimeout(() => M && closeAfter(lv), 160)
  }
}

function closeAfter(lv) {
  while (M.levels.length && M.levels[M.levels.length - 1] !== lv) {
    const top = M.levels.pop()
    top.el.remove()
  }
  for (const r of lv.rows) r.el.classList.remove('open')
}

function openSub(rec, byKey) {
  const lv = rec.lv
  closeAfter(lv)
  const sub = buildLevel(rec.kids, lv)
  sub.from = rec
  M.levels.push(sub)
  overlayEl().append(sub.el)
  placeSub(sub.el, lv.el, rec.el)
  rec.el.classList.add('open')
  if (byKey) setSel(sub, nextEnabled(sub, -1, 1))
}

function nextEnabled(lv, from, dir) {
  const n = lv.rows.length
  if (!n) return -1
  let i = from
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n
    if (!lv.rows[i].item.disabled) return i
  }
  return -1
}

function activate(rec) {
  if (rec.item.disabled) return
  if (rec.kids) {
    openSub(rec, false)
    return
  }
  const fn = rec.item.onClick
  closeMenus()
  if (fn) fn()
}

function onKey(e) {
  if (!M) return
  const lv = M.levels[M.levels.length - 1]
  const k = e.key
  let handled = true
  if (k === 'ArrowDown') setSel(lv, nextEnabled(lv, lv.sel, 1))
  else if (k === 'ArrowUp') setSel(lv, nextEnabled(lv, lv.sel < 0 ? 0 : lv.sel, -1))
  else if (k === 'Home') setSel(lv, nextEnabled(lv, -1, 1))
  else if (k === 'End') setSel(lv, nextEnabled(lv, 0, -1))
  else if (k === 'ArrowRight') {
    const r = lv.rows[lv.sel]
    if (r && r.kids) openSub(r, true)
  } else if (k === 'ArrowLeft') {
    if (M.levels.length > 1) closeAfter(lv.parent)
  } else if (k === 'Enter' || k === ' ') {
    const r = lv.rows[lv.sel]
    if (r) {
      if (r.kids) openSub(r, true)
      else activate(r)
    }
  } else if (k === 'Escape') {
    if (M.levels.length > 1) closeAfter(lv.parent)
    else closeMenus()
  } else if (k === 'Tab') {
    closeMenus()
    handled = false
  } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // type-ahead
    const c = k.toLowerCase()
    const n = lv.rows.length
    for (let j = 1; j <= n; j++) {
      const i = (Math.max(lv.sel, -1) + j) % n
      const r = lv.rows[i]
      if (!r.item.disabled && String(r.item.label).toLowerCase().startsWith(c)) {
        setSel(lv, i)
        break
      }
    }
  } else handled = false
  if (handled) {
    e.preventDefault()
    e.stopPropagation()
  }
}

function onPointerDown(e) {
  if (!M) return
  const t = e.target
  if (M.levels.some((l) => l.el.contains(t))) return
  const anchor = M.anchorEl
  const onAnchor = anchor && anchor.contains(t)
  closeMenus()
  if (onAnchor) {
    // Let the anchor act as a toggle: swallow the click that follows this press.
    const eat = (ev) => {
      ev.stopPropagation()
      ev.preventDefault()
    }
    window.addEventListener('click', eat, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', eat, true), 400)
  }
}

const onScroll = (e) => {
  if (M && !M.levels.some((l) => l.el.contains(e.target))) closeMenus()
}

export function closeMenus() {
  const s = M
  if (!s) return
  M = null
  for (const l of s.levels) {
    clearTimeout(l.subTimer)
    l.el.remove()
  }
  document.removeEventListener('keydown', onKey, true)
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('contextmenu', onPointerDown, true)
  document.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('blur', closeMenus)
  window.removeEventListener('resize', closeMenus)
  if (s.onClose) s.onClose()
}

export function showMenu({ anchor, items, align = 'start', onClose } = {}) {
  closeMenus()
  hideTip()
  const root = buildLevel(items || [], null)
  const session = { levels: [root], onClose, anchorEl: typeof Element !== 'undefined' && anchor instanceof Element ? anchor : null }
  M = session
  overlayEl().append(root.el)
  place(root.el, rectOf(anchor), align)
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('contextmenu', onPointerDown, true)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('blur', closeMenus)
  window.addEventListener('resize', closeMenus)
  return { close: () => M === session && closeMenus() }
}

// ------------------------------------------------------------------ tooltips

let tipEl = null
let tipTarget = null
let showTimer = 0
let pendingEl = null
let hiddenAt = 0
let watch = 0
let tipsReady = false

const tipText = (el) => el.getAttribute('data-tip') || ''

function buildTip(el) {
  const text = tipText(el)
  const keys = el.getAttribute('data-tip-keys')
  const lines = text.split('\n')
  const tip = h('div', { class: 'tip' + (lines.length > 1 ? ' rows' : ''), role: 'tooltip' })
  if (lines.length > 1) {
    tip.append(h('div', { class: 'tip-t' }, lines[0]), ...lines.slice(1).map((l) => h('div', { class: 'tip-r' }, l)))
    if (keys) tip.append(kbds(keys))
  } else {
    tip.append(h('span', { class: 'tip-t' }, text))
    if (keys) tip.append(kbds(keys))
  }
  return tip
}

function placeTip(tip, el) {
  const m = 8
  const r = el.getBoundingClientRect()
  tip.style.left = '0px'
  tip.style.top = '0px'
  const w = tip.offsetWidth
  const hh = tip.offsetHeight
  let pos = el.getAttribute('data-tip-pos') || 'bottom'
  if (pos === 'bottom' && r.bottom + 8 + hh > innerHeight - m) pos = 'top'
  else if (pos === 'top' && r.top - 8 - hh < m) pos = 'bottom'
  let left
  let top
  if (pos === 'left' || pos === 'right') {
    top = r.top + r.height / 2 - hh / 2
    left = pos === 'left' ? r.left - 8 - w : r.right + 8
    if (left < m || left + w > innerWidth - m) left = clamp(r.left + r.width / 2 - w / 2, m, innerWidth - w - m)
  } else {
    left = r.left + r.width / 2 - w / 2
    top = pos === 'top' ? r.top - 8 - hh : r.bottom + 8
  }
  tip.style.left = clamp(left, m, Math.max(m, innerWidth - w - m)) + 'px'
  tip.style.top = clamp(top, m, Math.max(m, innerHeight - hh - m)) + 'px'
}

function showTip(el) {
  if (!el.isConnected || !tipText(el)) return
  hideTip(true)
  tipTarget = el
  tipEl = buildTip(el)
  tipEl.dataset.text = tipText(el) + '|' + (el.getAttribute('data-tip-keys') || '')
  overlayEl().append(tipEl)
  placeTip(tipEl, el)
  watch = setInterval(() => {
    if (!tipTarget || !tipTarget.isConnected || !tipText(tipTarget)) return hideTip()
    const sig = tipText(tipTarget) + '|' + (tipTarget.getAttribute('data-tip-keys') || '')
    if (tipEl && tipEl.dataset.text !== sig) {
      const el2 = tipTarget
      showTip(el2)
    }
  }, 250)
}

function hideTip(silent) {
  clearTimeout(showTimer)
  pendingEl = null
  clearInterval(watch)
  if (tipEl) {
    tipEl.remove()
    if (!silent) hiddenAt = performance.now()
  }
  tipEl = null
  tipTarget = null
}

function schedule(el, delay) {
  clearTimeout(showTimer)
  pendingEl = el
  showTimer = setTimeout(() => showTip(el), delay)
}

/** Any element with data-tip="Text" (+ data-tip-keys="Ctrl+K", data-tip-pos="top|bottom|left|right"; "\n" makes a rows tooltip). Idempotent. */
export function initTooltips() {
  if (tipsReady) return
  tipsReady = true
  const noHover = () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches
  document.addEventListener(
    'pointerover',
    (e) => {
      if (e.pointerType === 'touch' || noHover()) return
      const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null
      if (el && (el === pendingEl || (el === tipTarget && tipEl))) return
      if (!el) {
        if (tipEl || showTimer) hideTip()
        return
      }
      if (M && M.levels.some((l) => l.el.contains(el))) return
      const warm = !!tipEl || performance.now() - hiddenAt < 300
      if (tipEl) hideTip(true)
      schedule(el, warm ? 80 : 450)
    },
    true,
  )
  document.addEventListener('pointerdown', () => hideTip(), true)
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hideTip(), true)
  document.addEventListener('scroll', () => hideTip(), true)
  document.addEventListener(
    'focusin',
    (e) => {
      if (noHover()) return
      const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null
      if (el && el.matches(':focus-visible')) schedule(el, 120)
    },
    true,
  )
  document.addEventListener('focusout', () => hideTip(), true)
  document.documentElement.addEventListener('pointerleave', () => hideTip())
  window.addEventListener('blur', () => hideTip())
}

