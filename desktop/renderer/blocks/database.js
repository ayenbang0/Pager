// Database block: a SQLite browser (Structure / Browse / Execute / Pragmas). The engine runs in a child process of the
// bundled node (desktop/electron/blocks/database.cjs); this file is only the view. Files open read-only; Edit mode
// stages changes in one transaction that Write changes commits and Revert rolls back.
import { h, fromHTML, uid, clamp } from '../ui/dom.js'
import { confirmDialog } from '../ui/dialog.js'
import {
  columnChips, displayValue, editText, formatBytes, formatMs, nextSort, offsetForRow, pageLabel, pageOffsets, parseCellInput,
  plural, rowsToTsv, tokenizeSql, valueKind,
} from './database-util.js'

// The block ships its own stylesheet; load it once, whoever mounts us.
if (!document.getElementById('db-css')) document.head.append(h('link', { id: 'db-css', rel: 'stylesheet', href: new URL('./database.css', import.meta.url).href }))

// ---------------------------------------------------------------- icons (16px, stroke 1.45)
const P = (d) => `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const I = {
  db: P('<ellipse cx="8" cy="3.8" rx="5" ry="2"/><path d="M3 3.8v8.4c0 1.1 2.2 2 5 2s5-.9 5-2V3.8"/><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>'),
  table: P('<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M2 6.5h12M2 10h12M6.5 6.5v7"/>'),
  view: P('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  index: P('<path d="M3 4h10M3 8h6M3 12h3"/><path d="M11.5 9.5l2 2.5-2 2.5"/>'),
  trigger: P('<path d="M8.8 1.8L3.6 9h4l-.6 5.2L12.4 7h-4z"/>'),
  key: P('<circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.4 8.6L13 3M11 5l1.5 1.5"/>'),
  chevR: P('<path d="M6 3.5L10.5 8 6 12.5"/>'),
  chevD: P('<path d="M3.5 6L8 10.5 12.5 6"/>'),
  first: P('<path d="M4 3v10M12 3.5L7 8l5 4.5"/>'),
  prev: P('<path d="M10 3.5L5.5 8l4.5 4.5"/>'),
  next: P('<path d="M6 3.5L10.5 8 6 12.5"/>'),
  last: P('<path d="M12 3v10M4 3.5L9 8l-5 4.5"/>'),
  lock: P('<rect x="3.5" y="7" width="9" height="6.5" rx="1.8"/><path d="M5.5 7V5.2a2.5 2.5 0 015 0V7"/>'),
  pencil: P('<path d="M10.5 2.8l2.7 2.7-7.6 7.6-3.3.6.6-3.3z"/>'),
  refresh: P('<path d="M13.5 8a5.5 5.5 0 11-1.7-4"/><path d="M13.5 2.5v3h-3"/>'),
  plus: P('<path d="M8 3v10M3 8h10"/>'),
  trash: P('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  save: P('<path d="M3 3.5a1 1 0 011-1h6.6L13 4.9V12.5a1 1 0 01-1 1H4a1 1 0 01-1-1z"/><path d="M5.5 2.5v3h4v-3M5.5 13.5v-4h5v4"/>'),
  undo: P('<path d="M5.5 3.5l-3 3 3 3"/><path d="M2.5 6.5h6a3.5 3.5 0 010 7H6"/>'),
  play: P('<path d="M5 3.2v9.6l8-4.8z"/>'),
  stop: P('<rect x="4" y="4" width="8" height="8" rx="1.5"/>'),
  copy: P('<rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 3.5v-.2a1.3 1.3 0 00-1.3-1.3H4.3A1.3 1.3 0 003 3.3v4.9a1.3 1.3 0 001.3 1.3h.2"/>'),
  folder: P('<path d="M2 12.5V4a1 1 0 011-1h3l1.5 1.8H13a1 1 0 011 1V7"/><path d="M2.4 13.5l1.7-6h10l-1.7 6z"/>'),
  filePlus: P('<path d="M9.5 2H4.5a1 1 0 00-1 1v10a1 1 0 001 1h7a1 1 0 001-1V5z"/><path d="M9.5 2v3.5h3M8 8v4M6 10h4"/>'),
  dots: P('<circle cx="3.5" cy="8" r=".7"/><circle cx="8" cy="8" r=".7"/><circle cx="12.5" cy="8" r=".7"/>'),
  download: P('<path d="M8 2.5v7.5M4.8 7.2L8 10.4l3.2-3.2M3 13h10"/>'),
  check: P('<path d="M3 8.5l3.2 3L13 4.5"/>'),
  x: P('<path d="M4 4l8 8M12 4l-8 8"/>'),
  panel: P('<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M2 9.5h12"/>'),
  clock: P('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>'),
  alert: P('<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.1"/>'),
  sortUp: P('<path d="M4 9.5L8 5.5l4 4"/>'),
  sortDown: P('<path d="M4 6.5l4 4 4-4"/>'),
  shield: P('<path d="M8 2l5 1.8v4c0 3-2.2 5-5 6.2-2.8-1.2-5-3.2-5-6.2v-4z"/><path d="M5.8 8l1.6 1.6L10.4 6.4"/>'),
  filter: P('<path d="M2.5 3.5h11L9.5 8.5V13l-3-1.5V8.5z"/>'),
}
const icon = (name) => fromHTML(I[name])
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const TABS = [
  ['structure', 'Structure'],
  ['browse', 'Browse'],
  ['execute', 'Execute'],
  ['pragmas', 'Pragmas'],
]
const PAGE_SIZES = [25, 50, 100, 250, 500, 1000]
const FILTER_HELP = 'Filters: text matches anywhere · =x  <>x  >5  <=5 · NULL  !NULL · "" (empty) · /regex/ · low~high'

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('pager.db.' + key); return v === null ? fallback : JSON.parse(v) } catch { return fallback }
  },
  set(key, value) {
    try { localStorage.setItem('pager.db.' + key, JSON.stringify(value)) } catch { /* private mode or full: not essential */ }
  },
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop()
const dirName = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '')
const errText = (e) => {
  const m = e && e.message ? e.message : String(e)
  return /database (table )?is locked/i.test(m) ? 'The database is locked: another connection (a second block or another program) has uncommitted changes. ' + m : m
}

// ---------------------------------------------------------------- small UI parts
function button({ icon: ic, label, title, cls = '', onClick, kbd }) {
  const b = h('button', { type: 'button', class: `db-btn btn sm ${cls.replace(/\bprimary\b/g, 'accent')}`, title: title || '' }, ic ? icon(ic) : null, label ? h('span', { class: 'db-btn-l' }, label) : null, kbd ? h('kbd', null, kbd) : null)
  if (onClick) b.addEventListener('click', (e) => { if (!b.disabled) onClick(e) })
  return b
}

/** A popover menu under `anchor`. items: { label, icon, kbd, onClick, disabled, danger, check, sep, head, note }. Returns close(). */
function popMenu(root, anchor, items, { align = 'left', width } = {}) {
  const menu = h('div', { class: 'db-pop', role: 'menu' })
  if (width) menu.style.minWidth = width + 'px'
  const rows = []
  for (const it of items) {
    if (it.sep) { menu.append(h('div', { class: 'db-pop-sep' })); continue }
    if (it.head) { menu.append(h('div', { class: 'db-pop-head' }, it.head)); continue }
    if (it.note) { menu.append(h('div', { class: 'db-pop-note' }, it.note)); continue }
    const row = h('button', { type: 'button', class: 'db-pop-i' + (it.danger ? ' danger' : '') + (it.check ? ' on' : ''), role: 'menuitem', disabled: !!it.disabled, title: it.title || '' },
      it.icon ? icon(it.icon) : h('span', { class: 'ico-sp' }), h('span', { class: 'db-pop-l' }, it.label), it.sub ? h('span', { class: 'db-pop-sub' }, it.sub) : null, it.kbd ? h('kbd', null, it.kbd) : null, it.check ? icon('check') : null)
    row.addEventListener('click', () => { close(); it.onClick && it.onClick() })
    menu.append(row)
    if (!it.disabled) rows.push(row)
  }
  root.append(menu)
  const rr = root.getBoundingClientRect()
  const ar = anchor.getBoundingClientRect()
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  let left = (align === 'right' ? ar.right - mw : ar.left) - rr.left
  left = clamp(left, 6, Math.max(6, rr.width - mw - 6))
  let top = ar.bottom - rr.top + 4
  if (top + mh > rr.height - 6) top = Math.max(6, ar.top - rr.top - mh - 4)
  menu.style.left = left + 'px'
  menu.style.top = top + 'px'
  menu.style.maxHeight = Math.max(120, rr.height - 12) + 'px'
  let closed = false
  const onDown = (e) => { if (!menu.contains(e.target)) close() }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus && anchor.focus() }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const i = rows.indexOf(document.activeElement)
      rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus()
    }
  }
  function close() {
    if (closed) return
    closed = true
    document.removeEventListener('pointerdown', onDown, true)
    menu.removeEventListener('keydown', onKey)
    menu.remove()
  }
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0)
  menu.addEventListener('keydown', onKey)
  rows[0]?.focus()
  menu.close = close
  return close
}

/** Modal confirm using the shell kit. Resolves true on the primary button. */
function confirmBox(_root, { title, body, ok = 'Continue', danger = false }) {
  return confirmDialog({ title, body, confirm: ok, danger })
}

// ---------------------------------------------------------------- the grid
/** Rows and columns with sticky header, optional filter row, sort, resizable columns, keyboard navigation and inline editing. */
class Grid {
  constructor(o) {
    this.o = o
    this.cols = []
    this.rows = []
    this.offset = 0
    this.sort = []
    this.filters = {}
    this.sel = null
    this.rowsSel = new Set()
    this.dirty = new Set()
    this.sig = ''
    this.widths = new Map()
    this.id = ''
    this.ed = null
    this.head = h('div', { class: 'db-gh' })
    this.filt = o.filters ? h('div', { class: 'db-gf' }) : null
    this.body = h('div', { class: 'db-gb' })
    this.empty = h('div', { class: 'db-empty', hidden: true })
    this.el = h('div', { class: 'db-grid', tabIndex: 0 }, this.head, this.filt, this.body, this.empty)
    this.el.addEventListener('pointerdown', (e) => this.onDown(e))
    this.el.addEventListener('dblclick', (e) => this.onDbl(e))
    this.el.addEventListener('keydown', (e) => this.onKey(e))
    this.el.addEventListener('contextmenu', (e) => this.onContext(e))
    this.el.addEventListener('focus', () => { if (!this.sel && this.rows.length && this.cols.length) this.select(0, 0, false) })
  }

  get canEdit() { return !!this.o.canEdit && this.o.canEdit() }

  setData(d) {
    this.cols = d.columns
    this.rows = d.rows
    this.offset = d.offset || 0
    this.sort = d.sort || []
    this.filters = d.filters || {}
    this.id = d.id || ''
    const sig = this.id + '|' + d.columns.map((c) => c.name + '\0' + (c.type || '')).join('\x01')
    this.cancelEdit()
    this.sel = null
    this.rowsSel.clear()
    this.dirty.clear()
    if (sig !== this.sig) {
      this.sig = sig
      this.autoWidths()
      this.buildHead()
    } else this.updateHead()
    this.applyWidths()
    this.renderRows(d.emptyText)
  }

  autoWidths() {
    this.cols.forEach((c, i) => {
      const k = this.id + ':' + c.name
      if (this.widths.has(k)) return
      let chars = c.name.length + (c.type ? c.type.length * 0.8 + 1 : 0) + (c.pk ? 2 : 0) + 4
      for (let r = 0; r < Math.min(30, this.rows.length); r++) chars = Math.max(chars, Math.min(48, displayValue(this.rows[r][i]).text.length))
      this.widths.set(k, clamp(Math.round(chars * 7.4 + 28), 84, 340))
    })
  }

  colW(i) { return this.widths.get(this.id + ':' + this.cols[i].name) || 120 }

  applyWidths() {
    const rn = Math.max(46, String(this.offset + this.rows.length).length * 8 + 28)
    const ws = this.cols.map((_, i) => this.colW(i))
    this.el.style.setProperty('--cols', `${rn}px ${ws.map((w) => w + 'px').join(' ')}`)
    this.el.style.setProperty('--gw', rn + ws.reduce((a, b) => a + b, 0) + 'px')
    this.el.style.setProperty('--rn', rn + 'px')
  }

  buildHead() {
    this.head.replaceChildren(h('div', { class: 'db-rn db-hc' }), ...this.cols.map((c, i) => this.headCell(c, i)))
    if (this.filt) {
      this.filt.replaceChildren(h('div', { class: 'db-rn db-fc' }, h('span', { class: 'db-fi', title: FILTER_HELP }, icon('filter'))), ...this.cols.map((c) => {
        const inp = h('input', { class: 'db-fin', type: 'text', placeholder: 'Filter', spellcheck: false, autocomplete: 'off', title: FILTER_HELP, value: this.filters[c.name] || '' })
        let t = 0
        inp.addEventListener('input', () => {
          clearTimeout(t)
          t = setTimeout(() => this.o.onFilter && this.o.onFilter(c.name, inp.value), 260)
        })
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { clearTimeout(t); this.o.onFilter && this.o.onFilter(c.name, inp.value) }
          else if (e.key === 'Escape') { inp.value = ''; clearTimeout(t); this.o.onFilter && this.o.onFilter(c.name, '') }
          else if (e.key === 'ArrowDown') { e.preventDefault(); this.el.focus() }
          e.stopPropagation()
        })
        return h('div', { class: 'db-fc' }, inp)
      }))
    }
    this.updateHead()
  }

  headCell(c, i) {
    const cell = h('div', { class: 'db-hc', dataset: { c: i }, title: `${c.name}${c.type ? ' · ' + c.type : ''}${c.pk ? ' · primary key' : ''}${c.notnull ? ' · not null' : ''}` },
      c.pk ? icon('key') : null,
      h('span', { class: 'db-hn' }, c.name),
      c.type ? h('span', { class: 'db-ht' }, c.type) : null,
      h('span', { class: 'db-hs' }),
      this.o.resizable === false ? null : h('span', { class: 'db-rz', onPointerdown: (e) => this.startResize(e, i) }))
    if (this.o.sortable) cell.classList.add('sortable')
    return cell
  }

  updateHead() {
    const cells = this.head.querySelectorAll('.db-hc[data-c]')
    cells.forEach((cell, i) => {
      const c = this.cols[i]
      const idx = this.sort.findIndex((s) => s.col === c.name)
      const s = cell.querySelector('.db-hs')
      s.replaceChildren()
      cell.classList.toggle('sorted', idx >= 0)
      if (idx >= 0) {
        s.append(icon(this.sort[idx].dir === 'desc' ? 'sortDown' : 'sortUp'))
        if (this.sort.length > 1) s.append(h('i', null, idx + 1))
      }
    })
    if (this.filt) {
      this.filt.querySelectorAll('.db-fin').forEach((inp, i) => {
        const want = this.filters[this.cols[i].name] || ''
        if (document.activeElement !== inp && inp.value !== want) inp.value = want
        inp.classList.toggle('on', !!want)
      })
    }
  }

  startResize(e, i) {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const start = this.colW(i)
    const key = this.id + ':' + this.cols[i].name
    const move = (ev) => { this.widths.set(key, clamp(start + ev.clientX - startX, 52, 900)); this.applyWidths() }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); this.el.classList.remove('resizing') }
    this.el.classList.add('resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  renderRows(emptyText) {
    let html = ''
    for (let r = 0; r < this.rows.length; r++) {
      html += `<div class="db-r" data-r="${r}"><div class="db-rn">${(this.offset + r + 1).toLocaleString('en-US')}</div>`
      const row = this.rows[r]
      for (let c = 0; c < this.cols.length; c++) {
        const d = displayValue(row[c])
        html += `<div class="db-c k-${d.kind}" data-c="${c}"${d.title ? ` title="${esc(d.title)}"` : ''}>${esc(d.text)}</div>`
      }
      html += '</div>'
    }
    this.body.innerHTML = html
    this.empty.hidden = this.rows.length > 0
    this.empty.textContent = emptyText || 'No rows'
  }

  cellEl(r, c) { return this.body.children[r]?.children[c + 1] || null }

  paintCell(r, c) {
    const el = this.cellEl(r, c)
    if (!el) return
    const d = displayValue(this.rows[r][c])
    el.className = `db-c k-${d.kind}` + (this.dirty.has(r + ':' + c) ? ' dirty' : '') + (this.sel && this.sel.r === r && this.sel.c === c ? ' sel' : '')
    el.textContent = d.text
    if (d.title) el.title = d.title
    else el.removeAttribute('title')
  }

  select(r, c, scroll = true, opts = {}) {
    if (!this.rows.length || !this.cols.length) return
    r = clamp(r, 0, this.rows.length - 1)
    c = clamp(c, 0, this.cols.length - 1)
    if (this.sel) {
      this.cellEl(this.sel.r, this.sel.c)?.classList.remove('sel')
      this.body.children[this.sel.r]?.classList.remove('cur')
    }
    this.sel = { r, c }
    if (!opts.keepRows) { this.rowsSel.clear(); this.paintRows() }
    this.cellEl(r, c)?.classList.add('sel')
    this.body.children[r]?.classList.add('cur')
    if (scroll) this.cellEl(r, c)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    this.o.onSelect && this.o.onSelect(r, c)
  }

  paintRows() {
    for (let r = 0; r < this.body.children.length; r++) this.body.children[r].classList.toggle('picked', this.rowsSel.has(r))
  }

  selectedRows() {
    if (this.rowsSel.size) return [...this.rowsSel].sort((a, b) => a - b)
    return this.sel ? [this.sel.r] : []
  }

  onDown(e) {
    const t = e.target
    if (t.closest('.db-gh, .db-gf, input, textarea')) {
      const hc = t.closest('.db-hc[data-c]')
      if (hc && !t.closest('.db-rz') && this.o.sortable && this.o.onSort) this.o.onSort(this.cols[+hc.dataset.c].name, e.ctrlKey || e.shiftKey || e.metaKey)
      return
    }
    const row = t.closest('.db-r')
    if (!row) return
    const r = +row.dataset.r
    if (this.ed && this.ed.r === r && t.closest('.db-c') === this.cellEl(r, this.ed.c)) return
    this.commitEdit()
    if (t.closest('.db-rn')) {
      if (e.shiftKey && this.sel) {
        const [a, b] = [Math.min(this.sel.r, r), Math.max(this.sel.r, r)]
        this.rowsSel = new Set(Array.from({ length: b - a + 1 }, (_, i) => a + i))
      } else if (e.ctrlKey || e.metaKey) {
        if (this.rowsSel.has(r)) this.rowsSel.delete(r)
        else { if (!this.rowsSel.size && this.sel) this.rowsSel.add(this.sel.r); this.rowsSel.add(r) }
      } else this.rowsSel = new Set([r])
      this.select(r, this.sel ? this.sel.c : 0, false, { keepRows: true })
      this.paintRows()
      this.el.focus()
      return
    }
    const cell = t.closest('.db-c')
    if (cell) this.select(r, +cell.dataset.c, false)
  }

  onDbl(e) {
    const cell = e.target.closest('.db-c')
    const row = e.target.closest('.db-r')
    if (cell && row) this.beginEdit(+row.dataset.r, +cell.dataset.c)
  }

  onContext(e) {
    const cell = e.target.closest('.db-c')
    const row = e.target.closest('.db-r')
    if (!row) return
    e.preventDefault()
    const r = +row.dataset.r
    if (cell) this.select(r, +cell.dataset.c, false, { keepRows: this.rowsSel.has(r) })
    else if (!this.rowsSel.has(r)) { this.rowsSel = new Set([r]); this.paintRows() }
    this.o.onContext && this.o.onContext(e, r, cell ? +cell.dataset.c : this.sel ? this.sel.c : 0)
  }

  onKey(e) {
    if (e.target !== this.el) return
    const s = this.sel
    const mod = e.ctrlKey || e.metaKey
    const page = Math.max(1, Math.floor(this.el.clientHeight / 26) - 2)
    switch (e.key) {
      case 'ArrowDown': s ? this.select(s.r + 1, s.c) : this.select(0, 0); break
      case 'ArrowUp': s ? this.select(s.r - 1, s.c) : this.select(0, 0); break
      case 'ArrowRight': s ? this.select(s.r, s.c + 1) : this.select(0, 0); break
      case 'ArrowLeft': s ? this.select(s.r, s.c - 1) : this.select(0, 0); break
      case 'Home': s && this.select(mod ? 0 : s.r, 0); break
      case 'End': s && this.select(mod ? this.rows.length - 1 : s.r, this.cols.length - 1); break
      case 'PageDown': if (s && s.r < this.rows.length - 1) this.select(s.r + page, s.c); else this.o.onPage && this.o.onPage('next'); break
      case 'PageUp': if (s && s.r > 0) this.select(s.r - page, s.c); else this.o.onPage && this.o.onPage('prev'); break
      case 'Enter': case 'F2': if (s) this.beginEdit(s.r, s.c); break
      case 'Delete': case 'Backspace': if (s && this.o.onDelete) this.o.onDelete(this.selectedRows(), s.c, e.shiftKey); break
      case 'a': case 'A': if (mod && this.rows.length) { this.rowsSel = new Set(this.rows.map((_, i) => i)); this.paintRows() } else return; break
      case 'c': case 'C': if (mod && s) this.copy(); else return; break
      default:
        if (!mod && !e.altKey && e.key.length === 1 && s && this.canEdit) { this.beginEdit(s.r, s.c, e.key) } else return
    }
    e.preventDefault()
  }

  copy() {
    if (!this.sel) return
    const rows = this.rowsSel.size ? this.selectedRows().map((r) => this.rows[r]) : null
    let text
    if (rows) text = rowsToTsv(rows)
    else text = rowsToTsv([[this.rows[this.sel.r][this.sel.c]]])
    navigator.clipboard?.writeText(text).catch(() => {})
    this.o.onCopied && this.o.onCopied(rows ? rows.length : 0)
  }

  /** Start editing a cell in place. `first` replaces the content with the typed character. */
  beginEdit(r, c, first) {
    if (!this.o.onCommit) return
    if (!this.canEdit) { this.o.onBlocked && this.o.onBlocked(); return }
    const cur = this.rows[r][c]
    const text = editText(cur)
    if (text === null || /[\r\n]/.test(text) || text.length > 240) { this.o.onOpenCell && this.o.onOpenCell(r, c); return }
    this.commitEdit()
    this.select(r, c, true, { keepRows: true })
    const el = this.cellEl(r, c)
    const input = h('input', { class: 'db-edit', type: 'text', spellcheck: false, autocomplete: 'off', value: first !== undefined ? first : text })
    const ed = { r, c, input, original: text, done: false }
    this.ed = ed
    el.classList.add('editing')
    el.replaceChildren(input)
    input.focus()
    if (first === undefined) input.select()
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); this.commitEdit().then((ok) => { if (ok) { this.el.focus(); if (!e.shiftKey && r + 1 < this.rows.length) this.select(r + 1, c) } }) }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); this.el.focus() }
      else if (e.key === 'Tab') { e.preventDefault(); this.commitEdit().then((ok) => { if (ok) { this.el.focus(); this.select(r, c + (e.shiftKey ? -1 : 1)) } }) }
    })
    input.addEventListener('blur', () => { if (this.ed === ed) this.commitEdit() })
  }

  cancelEdit() {
    const ed = this.ed
    if (!ed) return
    this.ed = null
    ed.done = true
    ed.input.remove()
    this.paintCell(ed.r, ed.c)
    this.cellEl(ed.r, ed.c)?.classList.remove('editing', 'bad')
  }

  /** Commit the open editor: resolves true when it closed (saved, unchanged or cancelled), false when the engine refused. */
  async commitEdit() {
    const ed = this.ed
    if (!ed || ed.done) return true
    const el = this.cellEl(ed.r, ed.c)
    const value = ed.input.value
    if (value === ed.original) { this.cancelEdit(); return true }
    ed.done = true
    el?.classList.add('saving')
    try {
      await this.o.onCommit(ed.r, ed.c, parseCellInput(value, this.cols[ed.c].type))
      if (this.ed === ed) this.ed = null
      el?.classList.remove('editing', 'saving', 'bad')
      this.paintCell(ed.r, ed.c)
      return true
    } catch (e) {
      // keep the editor open so the value can be fixed; Esc reverts
      ed.done = false
      el?.classList.remove('saving')
      el?.classList.add('bad')
      this.o.onError && this.o.onError(e)
      ed.input.focus()
      return false
    }
  }

  /** Apply a value to a cell from outside (inspector, Set NULL). */
  async setCell(r, c, wire) {
    await this.o.onCommit(r, c, wire)
    this.paintCell(r, c)
  }

  markDirty(r, c) { this.dirty.add(r + ':' + c) }
}

// ---------------------------------------------------------------- the block
export default {
  id: 'database',
  title: 'Database',
  icon: I.db,
  mount(el, ctx) {
    const sid = uid('db')
    const args = ctx.args || {}
    const S = {
      path: null, name: '', size: 0, version: '', readOnly: true, pending: 0, tab: TABS.some((t) => t[0] === args.tab) ? args.tab : 'browse',
      schema: null, dead: false,
    }
    const B = { table: args.table || null, offset: 0, limit: PAGE_SIZES.includes(args.pageSize) || args.pageSize > 0 ? args.pageSize : store.get('page', 100), filters: {}, sort: [], data: null, token: 0, inspector: false }
    const rpc = (method, a) => ctx.rpc(method, { sid, ...a })
    const notify = (level, text) => { try { ctx.toast(level, text) } catch { /* no toast host */ } }
    const fail = (e) => {
      if (e && e.code === 'INTERRUPTED') return
      notify('error', errText(e))
      if (e && e.code === 'WORKER_EXIT') banner(errText(e), 'error', [button({ label: 'Reopen', cls: 'sm', onClick: () => openFile(S.path, { readOnly: S.readOnly }) })])
    }

    // ---- chrome
    const root = h('div', { class: 'db', tabIndex: -1 })
    el.append(root)
    const nameEl = h('span', { class: 'db-name' }, 'Database')
    const metaEl = h('span', { class: 'db-meta' })
    const modeBtn = h('button', { type: 'button', class: 'db-mode', onClick: () => toggleMode() })
    const seg = h('div', { class: 'db-seg', role: 'tablist' }, TABS.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: 'db-seg-b', dataset: { tab: id }, onClick: () => setTab(id) }, label)))
    const revertBtn = button({ icon: 'undo', label: 'Revert', title: 'Roll back every change made since the last write', cls: 'quiet', onClick: () => revert() })
    const writeBtn = button({ icon: 'save', label: 'Write changes', title: 'Commit the staged changes to the file (Ctrl+S)', cls: 'accent', onClick: () => write() })
    const moreBtn = button({ icon: 'dots', title: 'More', cls: 'quiet icon', onClick: () => moreMenu(moreBtn) })
    const bar = h('div', { class: 'db-bar' },
      h('div', { class: 'db-id' }, icon('db'), nameEl, metaEl), modeBtn, seg, h('span', { class: 'db-sp' }), revertBtn, writeBtn, moreBtn)
    const bannerEl = h('div', { class: 'db-banner', hidden: true })
    const panes = {
      structure: h('section', { class: 'db-pane db-structure', hidden: true }),
      browse: h('section', { class: 'db-pane db-browse', hidden: true }),
      execute: h('section', { class: 'db-pane db-execute', hidden: true }),
      pragmas: h('section', { class: 'db-pane db-pragmas', hidden: true }),
    }
    const emptyEl = h('section', { class: 'db-welcome', hidden: true })
    const body = h('div', { class: 'db-body' }, ...Object.values(panes), emptyEl)
    root.append(bar, bannerEl, body)

    function banner(text, tone = 'info', actions = []) {
      bannerEl.replaceChildren(icon(tone === 'error' ? 'alert' : 'shield'), h('span', { class: 'db-banner-t' }, text), ...actions, button({ icon: 'x', cls: 'quiet icon', title: 'Dismiss', onClick: () => { bannerEl.hidden = true } }))
      bannerEl.className = 'db-banner ' + tone
      bannerEl.hidden = false
    }
    const clearBanner = () => { bannerEl.hidden = true }

    // ---- session
    function applyStatus(s) {
      if (!s) return
      if (s.size !== undefined) S.size = s.size
      if (s.readOnly !== undefined) S.readOnly = s.readOnly
      if (s.pending !== undefined) S.pending = s.pending
      if (s.version) S.version = s.version
      paintChrome()
    }

    function paintChrome() {
      const open = !!S.path
      root.classList.toggle('is-empty', !open)
      root.classList.toggle('is-edit', open && !S.readOnly)
      seg.hidden = !open
      modeBtn.hidden = !open
      revertBtn.hidden = !open || S.readOnly
      writeBtn.hidden = !open || S.readOnly
      revertBtn.disabled = S.pending === 0
      writeBtn.disabled = S.pending === 0
      writeBtn.querySelector('.db-btn-l').textContent = S.pending ? `Write changes · ${S.pending}` : 'Write changes'
      modeBtn.replaceChildren(icon(S.readOnly ? 'lock' : 'pencil'), h('span', null, S.readOnly ? 'Read-only' : 'Editing'))
      modeBtn.classList.toggle('on', !S.readOnly)
      modeBtn.title = S.readOnly ? 'Open for editing (changes stay staged until Write changes)' : 'Return to read-only'
      nameEl.textContent = open ? S.name : 'Database'
      nameEl.title = S.path || ''
      metaEl.textContent = open ? `${formatBytes(S.size)} · SQLite ${S.version}` : ''
      seg.querySelectorAll('.db-seg-b').forEach((b) => { const on = b.dataset.tab === S.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on) })
      for (const [id, p] of Object.entries(panes)) p.hidden = !open || id !== S.tab
      emptyEl.hidden = open
      ctx.setTitle && ctx.setTitle(open ? S.name : 'Database')
    }

    async function openFile(path, { readOnly = true, create = false } = {}) {
      clearBanner()
      try {
        const st = await rpc('open', { path, readOnly, create })
        const keep = S.path === st.path || (!S.path && args.table) ? B.table : null
        S.path = st.path
        S.name = st.name
        S.dead = false
        applyStatus(st)
        B.table = keep; B.offset = 0; B.filters = {}; B.sort = []; B.data = null
        pragmaState.data = null
        await loadSchema()
        if (!B.table || !tableObjects().some((t) => t.name === B.table)) B.table = (S.schema.tables.find((t) => !t.internal) || S.schema.tables[0] || S.schema.views[0])?.name || null
        if (args.tab === undefined && S.tab === 'browse' && !B.table) S.tab = 'structure'
        remember(st.path)
        execState.sql = store.get('sql:' + st.path, execState.sql)
        execState.result = null
        paintChrome()
        showTab(true)
      } catch (e) {
        notify('error', errText(e))
        if (!S.path) banner(errText(e), 'error')
        else banner(errText(e), 'error')
      }
    }

    async function closeFile() {
      if (S.pending && !(await confirmBox(root, { title: 'Discard staged changes?', body: `${plural(S.pending, 'change')} have not been written.`, ok: 'Discard and close', danger: true }))) return
      try { await rpc('close', {}) } catch { /* the engine may already be gone */ }
      S.path = null
      S.pending = 0
      S.schema = null
      paintChrome()
      renderWelcome()
    }

    async function toggleMode() {
      try {
        applyStatus(await rpc('setMode', { readOnly: !S.readOnly }))
        showTab(true)
        if (!S.readOnly) notify('info', 'Editing is on. Changes stay staged until you press Write changes.')
      } catch (e) { fail(e) }
    }

    async function write() {
      try {
        applyStatus(await rpc('commit', {}))
        notify('ok', 'Changes written to ' + S.name)
        if (B.data) grids.browse.dirty.clear(), grids.browse.el.querySelectorAll('.dirty').forEach((n) => n.classList.remove('dirty'))
        loadSchema().then(() => { if (S.tab === 'structure') renderStructure() })
      } catch (e) { fail(e) }
    }

    async function revert() {
      if (!S.pending) return
      if (!(await confirmBox(root, { title: 'Revert changes?', body: `${plural(S.pending, 'staged change')} will be rolled back.`, ok: 'Revert', danger: true }))) return
      try {
        applyStatus(await rpc('revert', {}))
        await loadSchema()
        showTab(true)
        notify('info', 'Changes reverted')
      } catch (e) { fail(e) }
    }

    function moreMenu(anchor) {
      popMenu(root, anchor, [
        { label: 'Open database…', icon: 'folder', onClick: () => pickOpen() },
        { label: 'New database…', icon: 'filePlus', onClick: () => pickNew() },
        { sep: true },
        { label: 'Reload', icon: 'refresh', disabled: !S.path, onClick: () => reload() },
        { label: 'Copy path', icon: 'copy', disabled: !S.path, onClick: () => navigator.clipboard?.writeText(S.path) },
        { sep: true },
        { label: 'Close database', icon: 'x', disabled: !S.path, onClick: () => closeFile() },
      ], { align: 'right' })
    }

    async function pickOpen() {
      try {
        const r = await ctx.rpc('pickOpen', { defaultPath: S.path ? dirName(S.path) : ctx.cwd })
        if (r.path) await openFile(r.path)
      } catch (e) { fail(e) }
    }

    async function pickNew() {
      try {
        const r = await ctx.rpc('pickNew', { defaultPath: (S.path ? dirName(S.path) : ctx.cwd || '') + '/new.db' })
        if (r.path) await openFile(r.path, { readOnly: false, create: true })
      } catch (e) { fail(e) }
    }

    async function reload() {
      try {
        applyStatus(await rpc('status', {}))
        await loadSchema()
        showTab(true)
      } catch (e) { fail(e) }
    }

    function remember(path) {
      const list = [path, ...store.get('recent', []).filter((p) => p !== path)].slice(0, 8)
      store.set('recent', list)
    }

    const tableObjects = () => (S.schema ? [...S.schema.tables, ...S.schema.views] : [])
    async function loadSchema() {
      S.schema = await rpc('schema', {})
      return S.schema
    }

    // ---- tabs
    function setTab(id) {
      S.tab = id
      paintChrome()
      showTab(false)
    }
    function showTab(force) {
      if (!S.path) return
      if (S.tab === 'structure') renderStructure()
      else if (S.tab === 'browse') { if (force || !B.data) loadPage(); else grids.browse.el.focus({ preventScroll: true }) }
      else if (S.tab === 'execute') { renderExecute(); execState.ta.focus() }
      else if (S.tab === 'pragmas') { if (force || !pragmaState.data) loadPragmas() }
    }

    // ---------------------------------------------------------------- welcome (no database yet)
    async function renderWelcome() {
      const recent = store.get('recent', []).filter((p) => p !== S.path)
      emptyEl.replaceChildren(
        h('div', { class: 'db-welcome-card' },
          h('h2', null, 'SQLite databases'),
          h('p', null, 'Files open read-only. Turn on Editing to make changes.'),
          h('div', { class: 'db-welcome-act' },
            button({ icon: 'folder', label: 'Open database…', cls: 'accent', onClick: pickOpen }),
            button({ icon: 'filePlus', label: 'New database…', onClick: pickNew })),
          recent.length ? h('div', { class: 'db-list' }, h('div', { class: 'db-list-h' }, 'Recent'), recent.map((p) => fileRow({ path: p, name: baseName(p) }, dirName(p)))) : null,
          h('div', { class: 'db-list', dataset: { scan: '1' } }, h('div', { class: 'db-list-h' }, ctx.cwd ? 'In ' + baseName(ctx.cwd) : 'Nearby'), h('div', { class: 'db-list-n' }, 'Looking…'))))
      try {
        const r = await ctx.rpc('scan', { dir: ctx.cwd || undefined })
        const box = emptyEl.querySelector('[data-scan] .db-list-n')
        if (!box) return
        const shown = r.files.filter((f) => !recent.includes(f.path))
        if (!shown.length) box.textContent = 'No database files here.'
        else box.replaceWith(...shown.slice(0, 8).map((f) => fileRow(f, f.path.slice(r.dir.length + 1))))
      } catch { emptyEl.querySelector('[data-scan]')?.remove() }
    }

    function fileRow(f, sub) {
      return h('button', { type: 'button', class: 'db-file', onClick: () => openFile(f.path), title: f.path },
        icon('db'), h('span', { class: 'db-file-n' }, f.name), h('span', { class: 'db-file-s' }, sub), f.size !== undefined ? h('span', { class: 'db-file-z' }, formatBytes(f.size)) : null)
    }

    // ---------------------------------------------------------------- Structure
    const structState = { open: new Set(), selected: null }
    function renderStructure() {
      const pane = panes.structure
      const sc = S.schema
      if (!sc) return
      const prevScroll = pane.querySelector('.db-tree')?.scrollTop || 0
      const tree = h('div', { class: 'db-tree' })
      const section = (label, count, rows) => {
        tree.append(h('div', { class: 'db-sec' }, label, h('span', { class: 'db-sec-n' }, count)))
        rows.forEach((r) => tree.append(r))
        if (!rows.length) tree.append(h('div', { class: 'db-none' }, 'None'))
      }
      const objRow = (kind, o, extra, children) => {
        const key = kind + ':' + o.name
        const open = structState.open.has(key)
        const row = h('div', { class: 'db-o' + (structState.selected === key ? ' sel' : '') + (o.internal ? ' internal' : ''), dataset: { key } },
          children && children.length ? h('span', { class: 'db-o-tw' }, icon(open ? 'chevD' : 'chevR')) : h('span', { class: 'db-o-tw' }),
          h('span', { class: 'db-o-ic ' + kind }, icon(kind === 'table' ? 'table' : kind === 'view' ? 'view' : kind === 'index' ? 'index' : 'trigger')),
          h('span', { class: 'db-o-n' }, o.name), extra,
          h('span', { class: 'db-o-sql' }, (o.sql || '').replace(/\s+/g, ' ')))
        row.addEventListener('click', () => {
          structState.selected = key
          if (children && children.length) { if (open) structState.open.delete(key); else structState.open.add(key) }
          renderStructure()
        })
        if (kind === 'table' || kind === 'view') {
          row.addEventListener('dblclick', () => { B.table = o.name; B.offset = 0; B.filters = {}; B.sort = []; B.data = null; setTab('browse') })
        }
        const wrap = [row]
        if (open && children) wrap.push(...children)
        return wrap
      }
      const colRows = (t) => t.columns.map((c) => h('div', { class: 'db-col' },
        h('span', { class: 'db-col-n' }, c.pk ? icon('key') : null, c.name),
        h('span', { class: 'db-col-t' }, c.type || '—'),
        h('span', { class: 'db-col-c' }, columnChips(c, t).map((ch) => h('span', { class: 'db-chip' + (ch.fk ? ' fk' : ''), title: ch.title }, ch.label))),
        h('span', { class: 'db-col-d' }, c.dflt !== null ? 'default ' + c.dflt : '')))
      const subRows = (t) => [
        ...t.indexes.filter((i) => i.origin === 'c' || !i.sql === false).map((i) => h('div', { class: 'db-col sub' }, h('span', { class: 'db-col-n' }, icon('index'), i.name), h('span', { class: 'db-col-t' }, i.unique ? 'unique index' : 'index'), h('span', { class: 'db-col-c' }, i.columns.map((c) => h('span', { class: 'db-chip' }, c))), h('span', { class: 'db-col-d' }, i.partial ? 'partial' : ''))),
        ...(t.triggers || []).map((n) => h('div', { class: 'db-col sub' }, h('span', { class: 'db-col-n' }, icon('trigger'), n), h('span', { class: 'db-col-t' }, 'trigger'), h('span', { class: 'db-col-c' }), h('span', { class: 'db-col-d' }))),
      ]
      const tables = sc.tables.map((t) => objRow('table', t,
        h('span', { class: 'db-o-meta' }, t.rows !== null ? plural(t.rows, 'row') : '', t.withoutRowid ? h('span', { class: 'db-chip' }, 'WITHOUT ROWID') : null, t.strict ? h('span', { class: 'db-chip' }, 'STRICT') : null, t.kind === 'virtual' ? h('span', { class: 'db-chip' }, 'VIRTUAL') : null),
        [...colRows(t), ...subRows(t)])).flat()
      const views = sc.views.map((v) => objRow('view', v, h('span', { class: 'db-o-meta' }, plural(v.columns.length, 'column')), colRows(v))).flat()
      const indexes = sc.indexes.filter((i) => !i.internal).map((i) => objRow('index', i, h('span', { class: 'db-o-meta' }, 'on ' + i.table, i.unique ? h('span', { class: 'db-chip' }, 'UNIQUE') : null, i.partial ? h('span', { class: 'db-chip' }, 'PARTIAL') : null), null)).flat()
      const triggers = sc.triggers.map((t) => objRow('trigger', t, h('span', { class: 'db-o-meta' }, 'on ' + t.table), null)).flat()
      section('Tables', sc.tables.length, tables)
      section('Views', sc.views.length, views)
      section('Indices', sc.indexes.filter((i) => !i.internal).length, indexes)
      section('Triggers', sc.triggers.length, triggers)
      const sel = structState.selected && findObject(structState.selected)
      const sqlBox = h('div', { class: 'db-sqlbox' },
        h('div', { class: 'db-sqlbox-h' }, h('span', null, sel ? 'Schema · ' + sel.name : 'Schema'), sel && sel.sql ? button({ icon: 'copy', label: 'Copy', cls: 'quiet sm', onClick: () => { navigator.clipboard?.writeText(sel.sql); notify('ok', 'Copied') } }) : null,
          sel && (sel.kind === 'table' || sel.kind === 'view') ? button({ icon: 'table', label: 'Browse', cls: 'quiet sm', onClick: () => { B.table = sel.name; B.offset = 0; B.filters = {}; B.sort = []; B.data = null; setTab('browse') } }) : null),
        h('pre', { class: 'db-sql-pre' }, sel && sel.sql ? highlight(sel.sql) : h('span', { class: 'db-hint' }, 'Select a table, view, index or trigger to see its CREATE statement. Double-click a table to browse it.')))
      pane.replaceChildren(tree, ...(sel ? [sqlBox] : []))
      tree.scrollTop = prevScroll
    }

    function findObject(key) {
      const [kind, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
      const sc = S.schema
      const list = kind === 'table' ? sc.tables : kind === 'view' ? sc.views : kind === 'index' ? sc.indexes : sc.triggers
      const o = list.find((x) => x.name === name)
      return o ? { ...o, kind } : null
    }

    function highlight(sql) {
      const frag = document.createDocumentFragment()
      for (const t of tokenizeSql(sql)) frag.append(t.t === 'ws' || t.t === 'op' ? document.createTextNode(t.s) : h('span', { class: 't-' + t.t }, t.s))
      return frag
    }

    // ---------------------------------------------------------------- Browse
    const grids = {}
    const bTable = () => tableObjects().find((t) => t.name === B.table)
    const tableBtn = h('button', { type: 'button', class: 'db-picker', onClick: () => tableMenu(tableBtn) })
    const newBtn = h('div', { class: 'db-split' },
      h('button', { type: 'button', class: 'db-btn', onClick: () => newRecord() }, icon('plus'), h('span', { class: 'db-btn-l' }, 'New Record')),
      h('button', { type: 'button', class: 'db-btn db-split-c', title: 'More record actions', onClick: (e) => recordMenu(e.currentTarget.parentElement) }, icon('chevD')))
    const refreshBtn = button({ icon: 'refresh', title: 'Reload this page', cls: 'quiet icon', onClick: () => loadPage() })
    const clearBtn = button({ icon: 'x', label: 'Clear filters', cls: 'quiet sm', onClick: () => { B.filters = {}; B.offset = 0; loadPage() } })
    const saveBtn = button({ icon: 'download', label: 'Save results', title: 'Save the rows of this table (with the filters and sort) as CSV or JSON', cls: 'quiet', onClick: () => saveMenu(saveBtn, () => ({ table: B.table, filters: cleanFilters(), sort: B.sort, name: B.table })) })
    const infoEl = h('span', { class: 'db-info' })
    const toolbarB = h('div', { class: 'db-tools' }, tableBtn, newBtn, refreshBtn, clearBtn, h('span', { class: 'db-sp' }), infoEl, saveBtn)
    const pagerEl = h('div', { class: 'db-pager' })
    const inspector = h('div', { class: 'db-insp', hidden: true })
    grids.browse = new Grid({
      filters: true,
      sortable: true,
      canEdit: () => !S.readOnly && !!B.data && B.data.editable,
      onSort: (col, add) => { B.sort = nextSort(B.sort, col, add); B.offset = 0; loadPage() },
      onFilter: (col, text) => { if (text) B.filters[col] = text; else delete B.filters[col]; B.offset = 0; loadPage() },
      onPage: (dir) => goPage(dir),
      onCommit: async (r, c, wire) => {
        const d = B.data
        const res = await rpc('update', { table: d.table, key: d.keys[r], column: d.columns[c].name, value: wire })
        d.rows[r][c] = res.cell
        grids.browse.rows = d.rows
        grids.browse.markDirty(r, c)
        S.pending = res.pending
        paintChrome()
        if (B.inspector && grids.browse.sel && grids.browse.sel.r === r && grids.browse.sel.c === c) fillInspector()
      },
      onError: (e) => { notify('error', errText(e)); infoEl.textContent = errText(e); infoEl.classList.add('bad'); setTimeout(() => infoEl.classList.remove('bad'), 4000) },
      onBlocked: () => blockedHint(),
      onOpenCell: (r, c) => { grids.browse.select(r, c); openInspector() },
      onSelect: () => { if (B.inspector) fillInspector() },
      onContext: (e, r, c) => cellMenu(e, r, c),
      onDelete: (rows, c, shift) => (shift || grids.browse.rowsSel.size ? deleteRows(rows) : setNull(rows[0], c)),
      onCopied: (n) => notify('ok', n ? `Copied ${plural(n, 'row')}` : 'Copied'),
    })
    panes.browse.append(toolbarB, grids.browse.el, inspector, pagerEl)

    function cleanFilters() {
      const out = {}
      for (const [k, v] of Object.entries(B.filters)) if (String(v).trim()) out[k] = v
      return out
    }

    function blockedHint() {
      const d = B.data
      if (!d) return
      if (!d.editable) notify('info', d.type === 'view' ? 'Views cannot be edited.' : 'This table has no rowid or primary key, so its rows cannot be edited.')
      else notify('info', 'The database is read-only. Turn on Editing in the toolbar to change cells.')
    }

    async function loadPage() {
      if (!B.table) {
        B.data = null
        tableBtn.replaceChildren(icon('table'), h('span', { class: 'db-picker-n' }, 'No tables'))
        grids.browse.setData({ columns: [], rows: [], id: '', emptyText: 'This database has no tables yet. Use Execute to create one.' })
        pagerEl.replaceChildren()
        infoEl.textContent = ''
        return
      }
      const token = ++B.token
      try {
        const d = await rpc('browse', { table: B.table, offset: B.offset, limit: B.limit, filters: cleanFilters(), sort: B.sort })
        if (token !== B.token) return
        if (d.total > 0 && d.rows.length === 0 && B.offset > 0) { B.offset = offsetForRow(d.total, B.limit, d.total); return loadPage() }
        B.data = d
        paintBrowse()
      } catch (e) {
        if (token !== B.token) return
        if (e.code === 'NOT_FOUND' && B.table) { B.table = null; B.data = null; return loadPage() }
        fail(e)
      }
    }

    function paintBrowse() {
      const d = B.data
      const filtered = Object.keys(cleanFilters()).length > 0
      tableBtn.replaceChildren(icon(d.type === 'view' ? 'view' : 'table'), h('span', { class: 'db-picker-n' }, d.table), icon('chevD'))
      clearBtn.hidden = !filtered
      newBtn.querySelector('.db-btn').disabled = S.readOnly || d.type === 'view'
      grids.browse.setData({
        id: 'b:' + d.table, columns: d.columns, rows: d.rows, offset: d.offset, sort: B.sort, filters: B.filters,
        emptyText: filtered ? 'No rows match the filters' : 'This table is empty',
      })
      infoEl.textContent = d.keyMode === 'none' && d.type === 'table' ? 'No rowid: read-only' : d.type === 'view' ? 'View' : ''
      paintPager()
      if (B.inspector) fillInspector()
    }

    function paintPager() {
      const d = B.data
      const o = pageOffsets(d.offset, d.limit, d.total)
      const nav = (name, title, off, on) => h('button', { type: 'button', class: 'db-pg', title, disabled: !on, onClick: () => { B.offset = off; loadPage() } }, icon(name))
      const go = h('input', { class: 'db-go', type: 'text', inputMode: 'numeric', placeholder: 'Go to row', title: 'Go to row (Enter)', spellcheck: false })
      go.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') { B.offset = offsetForRow(go.value, d.limit, d.total); loadPage() }
      })
      const size = h('select', { class: 'db-sel', title: 'Rows per page', onChange: () => { B.limit = +size.value; store.set('page', B.limit); B.offset = 0; loadPage() } },
        [...new Set([...PAGE_SIZES, d.limit])].sort((a, b) => a - b).map((n) => h('option', { value: n, selected: n === d.limit }, n + ' rows')))
      pagerEl.replaceChildren(
        h('div', { class: 'db-pg-g' }, nav('first', 'First page', o.first, o.hasPrev), nav('prev', 'Previous page', o.prev, o.hasPrev),
          h('span', { class: 'db-pg-l' }, pageLabel(d.offset, d.rows.length, d.total)),
          nav('next', 'Next page', o.next, o.hasNext), nav('last', 'Last page', o.last, o.hasNext)),
        go,
        h('span', { class: 'db-sp' }),
        button({ icon: 'panel', label: 'Cell', title: 'Show the selected cell in full (Shift+Enter)', cls: 'quiet sm' + (B.inspector ? ' on' : ''), onClick: () => (B.inspector ? closeInspector() : openInspector()) }),
        size)
    }

    function goPage(dir) {
      const d = B.data
      if (!d) return
      const o = pageOffsets(d.offset, d.limit, d.total)
      if (dir === 'next' && o.hasNext) { B.offset = o.next; loadPage() }
      else if (dir === 'prev' && o.hasPrev) { B.offset = o.prev; loadPage() }
    }

    function tableMenu(anchor) {
      const mk = (t, icn) => ({ label: t.name, icon: icn, sub: t.rows !== undefined && t.rows !== null ? t.rows.toLocaleString('en-US') : '', check: t.name === B.table, onClick: () => { B.table = t.name; B.offset = 0; B.filters = {}; B.sort = []; B.data = null; loadPage() } })
      const items = []
      const tables = S.schema.tables.filter((t) => !t.internal)
      if (tables.length) items.push({ head: 'Tables' }, ...tables.map((t) => mk(t, 'table')))
      if (S.schema.views.length) items.push({ head: 'Views' }, ...S.schema.views.map((t) => mk(t, 'view')))
      if (!items.length) items.push({ note: 'No tables in this database.' })
      popMenu(root, anchor, items, { width: 240 })
    }

    function recordMenu(anchor) {
      const g = grids.browse
      const can = g.canEdit
      popMenu(root, anchor, [
        { label: 'New record', icon: 'plus', disabled: !can, onClick: () => newRecord() },
        { label: 'Delete selected record(s)', icon: 'trash', danger: true, disabled: !can || !g.sel, kbd: 'Shift+Del', onClick: () => deleteRows(g.selectedRows()) },
        { sep: true },
        { label: 'Set cell to NULL', disabled: !can || !g.sel, kbd: 'Del', onClick: () => g.sel && setNull(g.sel.r, g.sel.c) },
        { label: 'Copy', icon: 'copy', disabled: !g.sel, kbd: 'Ctrl+C', onClick: () => g.copy() },
        { label: 'Show cell in full', icon: 'panel', disabled: !g.sel, kbd: 'Shift+Enter', onClick: () => openInspector() },
      ])
    }

    function cellMenu(e, r, c) {
      const g = grids.browse
      const can = g.canEdit
      const anchor = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) }
      popMenu(root, anchor, [
        { label: 'Edit cell', icon: 'pencil', disabled: !can, kbd: 'Enter', onClick: () => g.beginEdit(r, c) },
        { label: 'Set to NULL', disabled: !can, kbd: 'Del', onClick: () => setNull(r, c) },
        { label: 'Show in full', icon: 'panel', kbd: 'Shift+Enter', onClick: () => openInspector() },
        { sep: true },
        { label: g.rowsSel.size > 1 ? `Copy ${g.rowsSel.size} rows` : 'Copy', icon: 'copy', kbd: 'Ctrl+C', onClick: () => g.copy() },
        { label: 'Delete record' + (g.rowsSel.size > 1 ? 's' : ''), icon: 'trash', danger: true, disabled: !can, onClick: () => deleteRows(g.selectedRows()) },
      ])
    }

    async function setNull(r, c) {
      try { await grids.browse.setCell(r, c, null) } catch (e) { fail(e) }
    }

    async function newRecord() {
      const d = B.data
      if (!d || S.readOnly || d.type === 'view') return blockedHint()
      const t = bTable()
      const values = {}
      for (const col of t?.columns || []) {
        if (col.generated || (col.pk && /int/i.test(col.type)) || !col.notnull || col.dflt !== null) continue
        values[col.name] = /int|real|floa|doub|num|dec|bool/i.test(col.type) ? 0 : /blob/i.test(col.type) ? { t: 'blob', hex: '' } : ''
      }
      try {
        const res = await rpc('insert', { table: d.table, values })
        S.pending = res.pending
        paintChrome()
        B.filters = {}
        B.sort = []
        B.offset = offsetForRow(d.total + 1, B.limit, d.total + 1)
        await loadPage()
        const g = grids.browse
        g.select(g.rows.length - 1, 0)
        g.el.focus()
      } catch (e) { fail(e) }
    }

    async function deleteRows(rows) {
      const d = B.data
      if (!d || !rows.length) return
      if (S.readOnly || !d.editable) return blockedHint()
      if (!(await confirmBox(root, { title: `Delete ${plural(rows.length, 'record')}?`, body: 'The rows are removed in the staged transaction. Revert undoes this until you write.', ok: 'Delete', danger: true }))) return
      try {
        const res = await rpc('deleteRows', { table: d.table, keys: rows.map((r) => d.keys[r]) })
        S.pending = res.pending
        paintChrome()
        await loadPage()
      } catch (e) { fail(e) }
    }

    // ---- cell inspector
    function openInspector() {
      B.inspector = true
      inspector.hidden = false
      fillInspector()
      if (B.data) paintPager()
    }
    function closeInspector() {
      B.inspector = false
      inspector.hidden = true
      if (B.data) paintPager()
    }
    let inspToken = 0
    async function fillInspector() {
      const g = grids.browse
      const d = B.data
      if (!d || !g.sel) { inspector.replaceChildren(h('div', { class: 'db-hint pad' }, 'Select a cell.')); return }
      const { r, c } = g.sel
      const col = d.columns[c]
      const cur = d.rows[r][c]
      const kind = valueKind(cur)
      const token = ++inspToken
      let value = cur
      const truncated = kind === 'blob' ? cur.n > cur.hex.length / 2 : kind === 'text' && typeof cur === 'object' && cur.n > String(cur.v).length
      if (truncated && d.keys[r] !== undefined) {
        try { value = await rpc('cell', { table: d.table, key: d.keys[r], column: col.name }) } catch { value = cur }
        if (token !== inspToken) return
      }
      const isBlob = valueKind(value) === 'blob'
      const text = isBlob ? hexDump(value) : valueKind(value) === 'null' ? '' : typeof value === 'object' ? String(value.v) : String(value)
      const stillTrunc = !isBlob && typeof value === 'object' && value.n > String(value.v).length
      const can = g.canEdit && !isBlob && !stillTrunc
      const ta = h('textarea', { class: 'db-insp-ta', spellcheck: false, readOnly: !can, value: text, placeholder: kind === 'null' ? 'NULL' : '' })
      const apply = button({ icon: 'check', label: 'Apply', cls: 'accent sm', onClick: async () => {
        try { await g.setCell(r, c, parseCellInput(ta.value, col.type)); fillInspector() } catch (e) { fail(e) }
      } })
      apply.disabled = true
      ta.addEventListener('input', () => { apply.disabled = ta.value === text })
      ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !apply.disabled) apply.click(); if (e.key === 'Escape') g.el.focus() })
      const len = isBlob ? `${formatBytes(value.n)}${value.hex.length / 2 < value.n ? ` · first ${value.hex.length / 2} bytes` : ''}` : kind === 'null' ? 'NULL' : `${(typeof value === 'object' ? value.n ?? String(value.v).length : String(value).length).toLocaleString('en-US')} chars`
      inspector.replaceChildren(
        h('div', { class: 'db-insp-h' },
          h('span', { class: 'db-insp-t' }, col.name), col.type ? h('span', { class: 'db-chip' }, col.type) : null, h('span', { class: 'db-chip' }, kind === 'null' ? 'NULL' : kind.toUpperCase()), h('span', { class: 'db-insp-n' }, len),
          h('span', { class: 'db-sp' }),
          can ? button({ label: 'Set NULL', cls: 'quiet sm', onClick: () => setNull(r, c).then(fillInspector) }) : null,
          can ? apply : null,
          button({ icon: 'x', cls: 'quiet icon sm', title: 'Close', onClick: closeInspector })),
        ta)
    }

    function hexDump(v) {
      const bytes = v.hex.match(/../g) || []
      const lines = []
      for (let i = 0; i < bytes.length; i += 16) {
        const row = bytes.slice(i, i + 16)
        lines.push(i.toString(16).padStart(6, '0') + '  ' + row.join(' ').padEnd(47) + '  ' + row.map((b) => { const n = parseInt(b, 16); return n >= 32 && n < 127 ? String.fromCharCode(n) : '.' }).join(''))
      }
      return lines.join('\n')
    }

    // ---- save results (shared)
    function saveMenu(anchor, describe) {
      const go = async (format) => {
        try {
          const r = await ctx.rpc('exportResults', { sid, format, ...describe() })
          if (r.path) notify('ok', `Saved ${plural(r.rows, 'row')} to ${baseName(r.path)}`)
        } catch (e) { fail(e) }
      }
      popMenu(root, anchor, [
        { head: 'Save results as' },
        { label: 'CSV', icon: 'download', sub: 'comma-separated', onClick: () => go('csv') },
        { label: 'JSON', icon: 'download', sub: 'array of objects', onClick: () => go('json') },
      ], { align: 'right', width: 210 })
    }

    // ---------------------------------------------------------------- Execute
    const execState = {
      sql: '', result: null, running: false, hist: store.get('hist', []), splitH: store.get('splitH', 190),
      ta: null, built: false,
    }
    grids.exec = new Grid({
      sortable: false, filters: false, canEdit: () => false,
      onCopied: (n) => notify('ok', n ? `Copied ${plural(n, 'row')}` : 'Copied'),
    })

    function renderExecute() {
      if (execState.built) { paintExecResult(); return }
      execState.built = true
      const pane = panes.execute
      const ta = h('textarea', { class: 'db-ta', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', wrap: 'off', placeholder: 'SELECT * FROM … ;   Ctrl+Enter runs the selection, or everything', value: execState.sql })
      const hl = h('pre', { class: 'db-hl', 'aria-hidden': 'true' })
      const gut = h('div', { class: 'db-gut', 'aria-hidden': 'true' })
      execState.ta = ta
      const paint = () => {
        const v = ta.value
        const frag = document.createDocumentFragment()
        for (const t of tokenizeSql(v)) frag.append(t.t === 'ws' || t.t === 'op' ? document.createTextNode(t.s) : h('span', { class: 't-' + t.t }, t.s))
        frag.append(document.createTextNode('\n'))
        hl.replaceChildren(frag)
        const lines = v.split('\n').length
        if (gut.childElementCount !== lines) gut.replaceChildren(...Array.from({ length: lines }, (_, i) => h('div', null, i + 1)))
        execState.sql = v
        store.set('sql:' + S.path, v)
      }
      const sync = () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; gut.scrollTop = ta.scrollTop }
      ta.addEventListener('input', () => { paint(); sync() })
      ta.addEventListener('scroll', sync)
      ta.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run() }
        else if (e.key === 'Tab') {
          e.preventDefault()
          ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end')
          ta.dispatchEvent(new Event('input'))
        } else if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); toggleComment(ta) }
        else if (e.key === 'Escape') ta.blur()
      })
      execState.paint = () => { ta.value = execState.sql; paint() }
      const editor = h('div', { class: 'db-editor', style: { height: execState.splitH + 'px' } }, gut, h('div', { class: 'db-ta-wrap' }, hl, ta))
      execState.editor = editor
      execState.runBtn = button({ icon: 'play', label: 'Run', title: 'Run the selection, or all statements (Ctrl+Enter)', cls: 'accent', kbd: 'Ctrl+↵', onClick: () => run() })
      execState.stopBtn = button({ icon: 'stop', label: 'Stop', title: 'Stop the running statement', cls: 'danger', onClick: () => stop() })
      execState.stopBtn.hidden = true
      execState.histBtn = button({ icon: 'clock', title: 'Earlier statements', cls: 'quiet icon', onClick: () => histMenu(execState.histBtn) })
      execState.info = h('span', { class: 'db-info' })
      execState.saveBtn = button({ icon: 'download', label: 'Save results', cls: 'quiet', onClick: () => saveMenu(execState.saveBtn, () => ({ query: execState.result.query, name: 'results' })) })
      execState.copyBtn = button({ icon: 'copy', title: 'Copy the result as tab-separated text', cls: 'quiet icon', onClick: () => { const r = execState.result; if (r && r.rows) { navigator.clipboard?.writeText([r.columns.join('\t'), rowsToTsv(r.rows)].join('\n')); notify('ok', 'Copied') } } })
      const tools = h('div', { class: 'db-tools' }, execState.runBtn, execState.stopBtn, execState.histBtn, h('span', { class: 'db-sp' }), execState.info, execState.copyBtn, execState.saveBtn)
      const split = h('div', { class: 'db-vsplit', title: 'Drag to resize' })
      split.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        const y0 = e.clientY
        const h0 = editor.offsetHeight
        const max = pane.clientHeight - 160
        const move = (ev) => { editor.style.height = clamp(h0 + ev.clientY - y0, 70, Math.max(100, max)) + 'px' }
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); execState.splitH = editor.offsetHeight; store.set('splitH', execState.splitH) }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      })
      execState.resultBox = h('div', { class: 'db-result' })
      pane.replaceChildren(editor, split, tools, execState.resultBox)
      paint()
      paintExecResult()
    }

    function toggleComment(ta) {
      const v = ta.value
      const a = v.lastIndexOf('\n', ta.selectionStart - 1) + 1
      let b = v.indexOf('\n', ta.selectionEnd)
      if (b < 0) b = v.length
      const lines = v.slice(a, b).split('\n')
      const all = lines.every((l) => /^\s*--/.test(l) || !l.trim())
      const out = lines.map((l) => (all ? l.replace(/^(\s*)-- ?/, '$1') : l.trim() ? '-- ' + l : l)).join('\n')
      ta.setRangeText(out, a, b, 'select')
      ta.dispatchEvent(new Event('input'))
    }

    function histMenu(anchor) {
      const items = execState.hist.length
        ? execState.hist.map((q) => ({ label: q.replace(/\s+/g, ' ').slice(0, 70), onClick: () => { execState.sql = q; execState.paint(); execState.ta.focus() } }))
        : [{ note: 'Statements you run appear here.' }]
      if (execState.hist.length) items.push({ sep: true }, { label: 'Clear history', onClick: () => { execState.hist = []; store.set('hist', []) } })
      popMenu(root, anchor, items, { width: 360 })
    }

    async function run() {
      if (execState.running) return
      const ta = execState.ta
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd)
      const sql = sel.trim() ? sel : ta.value
      if (!sql.trim()) { execState.info.textContent = 'Nothing to run'; return }
      execState.running = true
      execState.runBtn.disabled = true
      execState.stopBtn.hidden = false
      execState.info.textContent = 'Running…'
      execState.info.classList.add('busy')
      try {
        const res = await rpc('execute', { sql })
        execState.result = res
        applyStatus({ pending: res.pending })
        execState.hist = [sql.trim(), ...execState.hist.filter((q) => q !== sql.trim())].slice(0, 30)
        store.set('hist', execState.hist)
        if (!S.readOnly) { loadSchema().then(() => { if (S.tab === 'structure') renderStructure() }); B.data = null }
      } catch (e) {
        if (e.code === 'INTERRUPTED') { execState.result = { error: { message: 'Stopped.' }, stopped: true } } else execState.result = { error: { message: errText(e) } }
        if (e.code === 'WORKER_EXIT') banner(errText(e), 'error', [button({ label: 'Reopen', cls: 'sm', onClick: () => openFile(S.path, { readOnly: S.readOnly }) })])
      } finally {
        execState.running = false
        execState.runBtn.disabled = false
        execState.stopBtn.hidden = true
        execState.info.classList.remove('busy')
      }
      paintExecResult()
    }

    async function stop() {
      if (!execState.running) return
      if (S.pending && !(await confirmBox(root, { title: 'Stop the statement?', body: `Stopping restarts the engine, which discards ${plural(S.pending, 'staged change')}.`, ok: 'Stop and discard', danger: true }))) return
      try { await ctx.rpc('interrupt', { sid }) } catch { /* already finished */ }
      const mode = S.readOnly
      S.pending = 0
      await openFile(S.path, { readOnly: mode })
      execState.result = { error: { message: 'Stopped. The engine was restarted' + (mode ? '.' : '; staged changes were discarded.') }, stopped: true }
      S.tab = 'execute'
      paintChrome()
      showTab(false)
      paintExecResult()
    }

    function paintExecResult() {
      const r = execState.result
      const box = execState.resultBox
      if (!box) return
      const info = execState.info
      execState.saveBtn.hidden = true
      execState.copyBtn.hidden = true
      if (!r) {
        info.textContent = ''
        box.replaceChildren(h('div', { class: 'db-hint pad' }, 'Results appear here.'))
        return
      }
      if (r.error) {
        const err = r.error
        info.textContent = r.ms ? formatMs(r.ms) : ''
        box.replaceChildren(h('div', { class: 'db-err' + (r.stopped ? ' stopped' : '') }, icon('alert'),
          h('div', null, h('div', { class: 'db-err-m' }, err.message),
            err.statement ? h('div', { class: 'db-err-w' }, `Statement ${err.statement}${r.total > 1 ? ' of ' + r.total : ''}${err.line ? ` · line ${err.line}` : ''}`) : null,
            err.sql ? h('pre', { class: 'db-err-sql' }, err.sql) : null)))
        return
      }
      const parts = []
      if (r.columns) parts.push(`${r.truncated ? plural(r.rowCount, 'row') + '+' : plural(r.rowCount, 'row')}`)
      else if (r.changes !== null && r.changes !== undefined && r.changes > 0) parts.push(`${plural(r.changes, 'row')} affected`)
      else parts.push('Done')
      if (r.total > 1) parts.push(`${r.statements} of ${plural(r.total, 'statement')}`)
      parts.push(formatMs(r.ms))
      info.textContent = parts.join(' · ')
      if (r.columns) {
        execState.saveBtn.hidden = !r.query
        execState.copyBtn.hidden = false
        const cols = r.columns.map((name) => ({ name, type: '', pk: 0 }))
        grids.exec.setData({ id: 'x:' + r.query, columns: cols, rows: r.rows, emptyText: 'The query returned no rows' })
        box.replaceChildren(...(r.truncated ? [h('div', { class: 'db-note' }, icon('alert'), `Showing the first ${r.rowCount.toLocaleString('en-US')} rows. Add a LIMIT, or Save results to get them all.`)] : []), grids.exec.el)
      } else {
        const lines = [r.changes > 0 ? `${plural(r.changes, 'row')} changed` : 'The statement ran without returning rows']
        if (r.lastInsertRowid) lines.push('Last inserted row id ' + r.lastInsertRowid)
        if (!S.readOnly && S.pending) lines.push('The change is staged. Press Write changes to keep it.')
        box.replaceChildren(h('div', { class: 'db-okbox' }, icon('check'), h('div', null, lines.map((l) => h('div', null, l)))))
      }
    }

    // ---------------------------------------------------------------- Pragmas
    const pragmaState = { data: null, check: null, busy: null }
    async function loadPragmas() {
      try {
        pragmaState.data = await rpc('pragmas', {})
        applyStatus({ pending: pragmaState.data.pending, readOnly: pragmaState.data.readOnly })
        renderPragmas()
      } catch (e) { fail(e) }
    }

    function renderPragmas() {
      const pane = panes.pragmas
      const d = pragmaState.data
      if (!d) return
      const groups = new Map()
      for (const p of d.pragmas) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p) }
      const scroll = pane.querySelector('.db-pg-scroll')?.scrollTop || 0
      const checkBtn = (kind, label, desc) => button({ icon: 'shield', label, title: desc, onClick: async () => {
        pragmaState.check = { kind, running: true }
        renderPragmas()
        try { pragmaState.check = await rpc('check', { kind }) } catch (e) { pragmaState.check = { kind, ok: false, lines: [errText(e)] } }
        renderPragmas()
      } })
      const ck = pragmaState.check
      const checks = h('div', { class: 'db-card' },
        h('div', { class: 'db-row' }, h('div', { class: 'db-row-t' }, h('div', { class: 'db-row-l' }, 'Health checks'), h('div', { class: 'db-row-d' }, 'Look for corruption and broken foreign keys. Integrity check reads the whole file.')),
          h('div', { class: 'db-row-c wrap' }, checkBtn('quick_check', 'Quick check', 'PRAGMA quick_check'), checkBtn('integrity_check', 'Integrity check', 'PRAGMA integrity_check'), checkBtn('foreign_key_check', 'Foreign keys', 'PRAGMA foreign_key_check'))),
        ck ? h('div', { class: 'db-check ' + (ck.running ? 'busy' : ck.ok ? 'ok' : 'bad') }, ck.running ? `Running ${ck.kind.replace('_', ' ')}…` : [h('div', { class: 'db-check-h' }, icon(ck.ok ? 'check' : 'alert'), `${ck.kind.replaceAll('_', ' ')}: ${ck.ok ? 'passed' : 'found problems'}`), h('pre', null, ck.lines.join('\n'))]) : null)
      const sections = [h('div', { class: 'db-eyebrow' }, '00 · Health'), checks]
      let n = 0
      for (const [group, list] of groups) {
        n++
        sections.push(h('div', { class: 'db-eyebrow' }, `${String(n).padStart(2, '0')} · ${group}`),
          h('div', { class: 'db-card' }, list.map((p) => pragmaRow(p))))
      }
      const sc = h('div', { class: 'db-pg-scroll' }, ...sections)
      pane.replaceChildren(sc)
      sc.scrollTop = scroll
    }

    function pragmaRow(p) {
      const locked = p.needsWrite && S.readOnly
      const apply = async (value) => {
        try {
          const r = await rpc('setPragma', { name: p.name, value })
          if (!r.applied) notify('info', `${p.label} was not changed by SQLite` + (p.name === 'journal_mode' ? ' (the current mode cannot switch).' : '.'))
          applyStatus({ pending: r.pending })
        } catch (e) { notify('error', errText(e)) }
        await loadPragmas()
      }
      let control
      if (p.kind === 'bool') {
        control = h('button', { type: 'button', class: 'db-sw' + (p.value ? ' on' : ''), role: 'switch', 'aria-checked': !!p.value, 'aria-label': p.label, disabled: locked, onClick: () => apply(p.value ? 0 : 1) }, h('i'))
      } else if (p.kind === 'enum') {
        control = h('select', { class: 'db-sel', disabled: locked, 'aria-label': p.label, onChange: (e) => apply(e.target.value) }, p.options.map((o) => h('option', { value: o.value, selected: o.value === p.value }, o.label)))
        if (!p.options.some((o) => o.value === p.value)) control.prepend(h('option', { value: p.value, selected: true }, String(p.value)))
      } else if (p.kind === 'int') {
        const inp = h('input', { class: 'db-num', type: 'text', inputMode: 'numeric', value: p.value === null ? '' : String(p.value), disabled: locked, 'aria-label': p.label, title: `${p.min} to ${p.max}` })
        const commit = () => { if (inp.value.trim() !== String(p.value)) apply(inp.value.trim()) }
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); if (e.key === 'Escape') { inp.value = String(p.value); inp.blur() } })
        inp.addEventListener('blur', commit)
        control = inp
      } else control = h('span', { class: 'db-val mono' }, p.value === null ? '—' : typeof p.value === 'number' ? p.value.toLocaleString('en-US') : String(p.value))
      return h('div', { class: 'db-row' + (locked ? ' locked' : '') },
        h('div', { class: 'db-row-t' }, h('div', { class: 'db-row-l' }, p.label, h('span', { class: 'db-row-k' }, p.name), p.kind !== 'readonly' && !p.persistent ? h('span', { class: 'db-chip', title: 'Applies to this connection only; SQLite resets it when the file is opened again' }, 'session') : null, locked ? h('span', { class: 'db-chip' }, 'needs Editing') : null),
          h('div', { class: 'db-row-d' }, p.desc, p.error ? h('span', { class: 'db-row-e' }, ' ' + p.error) : null)),
        h('div', { class: 'db-row-c' }, control))
    }

    // ---------------------------------------------------------------- events, keys, lifecycle
    const off = ctx.onEvent ? ctx.onEvent((ev, payload) => {
      if (ev === 'closed' && payload && payload.sid === sid && S.path && !S.dead) {
        S.dead = true
        S.pending = 0
        banner(payload.reason || 'The database engine stopped.', 'error', [button({ label: 'Reopen', cls: 'sm', onClick: () => openFile(S.path, { readOnly: true }) })])
        paintChrome()
      }
    }) : null

    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && S.path && !S.readOnly) { e.preventDefault(); if (S.pending) write() }
      else if (e.shiftKey && e.key === 'Enter' && S.tab === 'browse' && document.activeElement === grids.browse.el) { e.preventDefault(); openInspector() }
    }
    root.addEventListener('keydown', onKey)
    const onHide = () => { ctx.rpc('close', { sid }).catch(() => {}) }
    window.addEventListener('pagehide', onHide)

    paintChrome()
    renderWelcome()
    if (args.path) openFile(args.path, { readOnly: args.readOnly !== false })

    return {
      dispose() {
        root.removeEventListener('keydown', onKey)
        window.removeEventListener('pagehide', onHide)
        if (typeof off === 'function') off()
        ctx.rpc('close', { sid }).catch(() => {})
        root.remove()
      },
      focus() {
        if (!S.path) return emptyEl.querySelector('button')?.focus()
        if (S.tab === 'browse') grids.browse.el.focus({ preventScroll: true })
        else if (S.tab === 'execute') execState.ta?.focus()
        else root.focus({ preventScroll: true })
      },
      resize() {},
    }
  },
}
