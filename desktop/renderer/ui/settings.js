// The Settings sheet: docked at the right of the stage, an icon tab strip, a search box that filters every page, and the pages
// from settings-pages.js. Opening it sets --tn-sheet on <html>, so the panes beside it shrink.
import { h, $, clamp } from './dom.js'
import { app } from './store.js'
import { icon } from './icons.js'
import { page } from './controls.js'
import { PAGES, refreshBound, refreshLive, stopTransient, rememberDefaultKeys } from './settings-pages.js'

const root = document.documentElement
const pages = PAGES.filter((p) => !p.sep)
const MIN = 360
const MAX = 720

let sheet = null
let body = null
let searchEl = null
let tabsEl = null
let current = 'general'
let open = false
let query = ''
let offs = []
const built = new Map() // page id -> element
const scroll = new Map() // page id -> scrollTop

const num = (p) => String(pages.indexOf(p) + 1).padStart(2, '0')
const width = () => clamp(+app.settings.sheet_width || 440, MIN, MAX)
const setVar = (px) => root.style.setProperty('--tn-sheet', `${px}px`)

function pageEl(p) {
  if (p.volatile) built.delete(p.id)
  let el = built.get(p.id)
  if (!el) {
    el = page({ eyebrow: `${num(p)} · ${p.name}`, title: p.title, blurb: p.blurb, sections: p.build() })
    el.dataset.page = p.id
    built.set(p.id, el)
  }
  return el
}

function showPage(id, { keepScroll = true } = {}) {
  const p = pages.find((x) => x.id === id) || pages[0]
  if (body.firstChild) scroll.set(current, body.scrollTop)
  stopTransient()
  current = p.id
  for (const b of tabsEl.querySelectorAll('.pf-tab')) {
    const on = b.dataset.page === p.id && !query
    b.classList.toggle('on', on)
    b.setAttribute('aria-selected', String(on))
  }
  if (query) return renderSearch()
  const el = pageEl(p)
  el.style.animation = 'none'
  body.replaceChildren(el)
  void el.offsetWidth
  el.style.animation = ''
  body.scrollTop = keepScroll ? scroll.get(p.id) || 0 : 0
  refreshBound()
  refreshLive()
}

/** Search keeps the real page elements (their controls stay live) and hides whatever does not match. */
function renderSearch() {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const groups = []
  for (const p of pages) {
    const el = pageEl(p)
    let hits = 0
    for (const sec of el.querySelectorAll('.pf-sec')) {
      let any = 0
      for (const r of sec.querySelectorAll('.pf-row')) {
        const q = r.dataset.q || r.textContent.toLowerCase()
        const ok = words.every((w) => q.includes(w))
        r.hidden = !ok
        if (ok) any++
      }
      sec.hidden = !any
      hits += any
    }
    const head = el.querySelector('.pf-head')
    if (head) head.hidden = true
    if (!hits) continue
    groups.push(h('div', { class: 'pf-group' }, h('div', { class: 'pf-group-h' }, h('span', { class: 'pf-group-e' }, `${num(p)} · ${p.name}`), h('span', { class: 'pf-group-n' }, p.title)), el))
  }
  body.replaceChildren(h('div', { class: 'pf-results' }, groups.length ? groups : h('div', { class: 'pf-empty' }, `No settings match “${query}”.`)))
  body.scrollTop = 0
  refreshBound()
}

function clearSearch() {
  query = ''
  searchEl.value = ''
  for (const el of built.values()) {
    const head = el.querySelector('.pf-head')
    if (head) head.hidden = false
    el.querySelectorAll('[hidden]').forEach((n) => n.removeAttribute('hidden'))
  }
}

function build() {
  searchEl = h('input', { type: 'search', placeholder: 'Search settings', spellcheck: false, autocomplete: 'off', attrs: { 'aria-label': 'Search settings' } })
  searchEl.addEventListener('input', () => {
    const was = query
    query = searchEl.value.trim()
    if (query) renderSearch()
    else if (was) {
      clearSearch()
      showPage(current)
    }
    for (const b of tabsEl.querySelectorAll('.pf-tab')) b.classList.toggle('on', !query && b.dataset.page === current)
  })
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchEl.value) {
      e.stopPropagation()
      searchEl.value = ''
      searchEl.dispatchEvent(new Event('input'))
    }
  })
  tabsEl = h(
    'div',
    { class: 'pf-tabs', role: 'tablist' },
    PAGES.map((p) => (p.sep ? h('span', { class: 'pf-tabs-sep' }) : h('button', { class: 'pf-tab', type: 'button', role: 'tab', dataset: { page: p.id }, attrs: { 'data-tip': p.name, 'aria-label': p.name }, onClick: () => (query && (clearSearch(), (query = ''), (searchEl.value = '')), showPage(p.id)) }, icon(p.icon)))),
  )
  body = h('div', { class: 'pf-body' })
  const grip = h('div', { class: 'pf-grip', role: 'separator', attrs: { 'aria-orientation': 'vertical', tabindex: '0', 'aria-label': 'Resize settings' } })
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    grip.setPointerCapture(e.pointerId)
    grip.classList.add('drag')
    sheet.classList.add('resizing')
    const stage = $('#stage').getBoundingClientRect()
    let w = width()
    const move = (m) => {
      w = clamp(Math.round(stage.right - 3 - m.clientX), MIN, MAX)
      setVar(w)
    }
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      grip.classList.remove('drag')
      sheet.classList.remove('resizing')
      app.set({ sheet_width: w })
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  })
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const w = clamp(width() + (e.key === 'ArrowLeft' ? 20 : -20), MIN, MAX)
    setVar(w)
    app.set({ sheet_width: w })
  })
  sheet = h(
    'div',
    { class: 'tn-sheet', role: 'dialog', attrs: { 'aria-label': 'Settings' } },
    grip,
    h('div', { class: 'pf-top' }, h('span', { class: 'pf-tile' }, icon('sliders', 16)), h('span', { class: 'pf-top-t' }, 'Settings'), h('button', { class: 'pf-x', type: 'button', attrs: { 'data-tip': 'Close', 'data-tip-keys': 'Escape', 'aria-label': 'Close settings' }, onClick: closeSettings }, icon('close'))),
    h('label', { class: 'pf-search' }, icon('search', 15, 'pico'), searchEl),
    tabsEl,
    body,
  )
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.stopPropagation()
      closeSettings()
    }
  })
}

export const settingsOpen = () => open

export function openSettings(pageId) {
  const host = document.getElementById('sheet-host')
  if (!host) return
  if (!sheet) build()
  rememberDefaultKeys()
  if (!open) {
    open = true
    host.replaceChildren(sheet)
    root.classList.add('sheet-open')
    setVar(width())
    offs = [
      app.on('settings', (p) => {
        if ('sheet_width' in p && !sheet.classList.contains('resizing')) setVar(width())
        refreshBound()
      }),
      app.on('state', () => refreshLive()),
    ]
  }
  if (query) {
    clearSearch()
    query = ''
  }
  showPage(pages.some((p) => p.id === pageId) ? pageId : current, { keepScroll: !pageId })
  requestAnimationFrame(() => {
    if (!pageId || !searchEl.matches(':focus')) sheet.querySelector('.pf-tab.on')?.focus({ preventScroll: true })
  })
}

export function closeSettings() {
  if (!open) return
  open = false
  stopTransient()
  scroll.set(current, body.scrollTop)
  offs.forEach((f) => f())
  offs = []
  root.classList.remove('sheet-open')
  root.style.setProperty('--tn-sheet', '0px')
  sheet.remove()
  const f = app.focusedPaneId && document.querySelector(`[data-pane="${app.focusedPaneId}"] textarea`)
  if (f) f.focus()
}

export function toggleSettings(pageId) {
  if (open && (!pageId || pageId === current)) closeSettings()
  else openSettings(pageId)
}
