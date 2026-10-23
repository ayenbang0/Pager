// Notebook block: a Jupyter-compatible editor for .ipynb (nbformat 4) on a plain Python. The file is read and written by
// the main-process handler (electron/blocks/notebook.cjs), which also owns one `pager_kernel` process per block; this
// module is the notebook UI: cells, outputs, the toolbar, the kernel chip, keyboard (command / edit mode).
// Pure logic (outputs from kernel events, ANSI, Python highlighting, Markdown) lives in notebook-model.js.
import { h, fromHTML } from '../ui/dom.js'
import { closeMenus, showMenu } from '../ui/popover.js'
import { confirmDialog, promptDialog } from '../ui/dialog.js'
import * as M from './notebook-model.js'

// The block's stylesheet loads itself, so any host that imports the module gets the styling.
const CSS = new URL('./notebook.css', import.meta.url).href
if (!document.querySelector(`link[href="${CSS}"]`)) document.head.append(h('link', { rel: 'stylesheet', href: CSS }))

const svg = (body) => `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICONS = {
  notebook: svg('<path d="M3.5 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8z"/><path d="M3.5 5.2h-1.2M3.5 8h-1.2M3.5 10.8h-1.2M6 5.5h4M6 8h3"/>'),
  play: svg('<path d="M5 3.4v9.2l7.4-4.6z"/>'),
  playAll: svg('<path d="M3 3.4v9.2l6-4.6zM10.2 3.4v9.2M13 4.2v7.6"/>'),
  stop: svg('<rect x="4" y="4" width="8" height="8" rx="1.6"/>'),
  restart: svg('<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.8v2.7h-2.7"/>'),
  plus: svg('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
  up: svg('<path d="M8 12.5v-9M4.2 7l3.8-3.8L11.8 7"/>'),
  down: svg('<path d="M8 3.5v9M4.2 9l3.8 3.8L11.8 9"/>'),
  trash: svg('<path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.5 4.5l.6 8.2c0 .5.4.8.8.8h4.2c.4 0 .8-.3.8-.8l.6-8.2M6.6 7v4M9.4 7v4"/>'),
  chevDown: svg('<path d="M4 6.2l4 4 4-4"/>'),
  chevRight: svg('<path d="M6.2 4l4 4-4 4"/>'),
  more: svg('<circle cx="3.6" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.4" cy="8" r=".6"/>'),
  warn: svg('<path d="M8 2.8l5.6 9.6H2.4z"/><path d="M8 6.8v2.6M8 11.2h.01"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
}
const ico = (k) => fromHTML(ICONS[k])

const DEFAULTS = {
  python: '',
  start_on_open: false,
  stop_on_error: true,
  ask_restart: true,
  autosave_secs: 120,
  record_timing: false,
  line_numbers: false,
  wrap_code: false,
  complete_while_typing: false,
  scroll_outputs_lines: 100,
  figure_format: 'retina',
}

const KIND_LABEL = { code: 'Code', markdown: 'Markdown', raw: 'Raw' }
const COMP_ICON = { module: 'M', function: 'ƒ', class: 'C', keyword: 'K', instance: 'v', statement: 'v', param: 'p', path: 'P', property: 'v' }

// ------------------------------------------------------------------------------------------------------------------
// HTML output: sanitised, then shown in a shadow root so a stray <style> cannot restyle the app.

const DROP_TAGS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'form', 'noscript', 'template', 'portal', 'dialog', 'svg:script'])
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'poster', 'background', 'action', 'formaction', 'data', 'srcset', 'ping'])
const SAFE_URL = /^(?:https?:|mailto:|#|data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml)[;,]|attachment:|\.{0,2}\/|[^:]*$)/i

function cleanCss(css) {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/behavior\s*:[^;}]*/gi, '')
    .replace(/url\(\s*(['"]?)(?!data:image\/)[^)]*\)/gi, 'url()')
}

/** Parse in an inert document and strip anything that can run code or reach the app: scripts, frames, handlers, javascript: URLs. */
export function sanitize(html, { allowStyle = false } = {}) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
  const walk = (node) => {
    for (const child of Array.from(node.children)) {
      const tag = child.localName
      if (DROP_TAGS.has(tag) || (tag === 'style' && !allowStyle) || (tag === 'input' && !(child.getAttribute('type') === 'checkbox' && child.hasAttribute('disabled')))) {
        child.remove()
        continue
      }
      if (tag === 'style') child.textContent = cleanCss(child.textContent)
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') child.removeAttribute(attr.name)
        else if (URL_ATTRS.has(name)) {
          const v = attr.value.replace(/[\u0000-\u0020\u007f-\u009f]/g, '')
          if (name === 'srcset' || !SAFE_URL.test(v)) child.removeAttribute(attr.name)
        } else if (name === 'style') child.setAttribute('style', cleanCss(attr.value))
      }
      if (tag === 'a') {
        child.setAttribute('rel', 'noopener noreferrer')
        child.removeAttribute('target')
      }
      walk(child)
    }
  }
  walk(doc.body)
  const frag = document.createDocumentFragment()
  frag.append(...Array.from(doc.body.childNodes).map((n) => document.importNode(n, true)))
  return frag
}

const HTML_BASE_CSS = `
:host { display: block; color: var(--t1); font: 12.5px/1.5 var(--sans); overflow-x: auto; }
* { box-sizing: border-box; }
table { border: none; border-collapse: collapse; font-variant-numeric: tabular-nums; margin: 2px 0; }
th, td { padding: 4px 12px; text-align: right; border: none; }
thead th { font-weight: 550; color: var(--t2); box-shadow: inset 0 -1px 0 var(--l2); }
tbody th { font-weight: 500; color: var(--t3); }
tbody tr:hover { background: var(--l1); }
a { color: var(--accent-ink); }
img, svg { max-width: 100%; height: auto; }
pre, code { font-family: var(--mono); font-size: 12px; }
pre { margin: 0; white-space: pre-wrap; }
`

// ------------------------------------------------------------------------------------------------------------------
// ANSI -> DOM

function ansiHtml(text) {
  const runs = M.ansiRuns(text)
  let out = ''
  for (const r of runs) {
    const cls = []
    const style = []
    if (typeof r.fg === 'number') cls.push('af' + r.fg)
    else if (r.fg) style.push('color:' + r.fg)
    if (typeof r.bg === 'number') cls.push('ab' + r.bg)
    else if (r.bg) style.push('background:' + r.bg)
    if (r.bold) cls.push('a-b')
    if (r.dim) cls.push('a-d')
    if (r.italic) cls.push('a-i')
    if (r.underline) cls.push('a-u')
    const esc = M.escapeHtml(r.text)
    out += cls.length || style.length ? `<span${cls.length ? ` class="${cls.join(' ')}"` : ''}${style.length ? ` style="${style.join(';')}"` : ''}>${esc}</span>` : esc
  }
  return out
}

function lineCount(text) {
  let n = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
  return n
}

function highlightLines(text, python) {
  const lines = ['']
  const toks = python ? M.pythonTokens(text) : [['', text]]
  for (const [cls, t] of toks) {
    const parts = t.split('\n')
    parts.forEach((p, i) => {
      if (i > 0) lines.push('')
      if (p) lines[lines.length - 1] += cls ? `<span class="nb-${cls}">${M.escapeHtml(p)}</span>` : M.escapeHtml(p)
    })
  }
  return lines.map((l) => `<span class="nb-l">${l}</span>`).join('')
}

function insertText(ta, text) {
  ta.focus()
  if (document.execCommand && document.execCommand('insertText', false, text)) return
  ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop()
const dirName = (p) => {
  const i = Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\'))
  return i > 0 ? String(p).slice(0, i) : ''
}

let uidSeq = 0
const uid = (p) => `${p}-${Date.now().toString(36)}${(++uidSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

// ------------------------------------------------------------------------------------------------------------------

class Notebook {
  constructor(el, ctx) {
    this.el = el
    this.ctx = ctx
    this.args = ctx.args || {}
    this.key = uid('nb')
    this.cfg = { ...DEFAULTS }
    this.cells = []
    this.sel = 0
    this.nb = null
    this.format = null
    this.path = null
    this.name = 'Untitled.ipynb'
    this.mtimeMs = null
    this.dirty = false
    this.dirtySince = 0
    this.execs = new Map()
    this.execSeq = 0
    this.displays = new Map()
    this.folded = new Set()
    this.deleted = []
    this.clip = null
    this.pythons = null
    this.pythonChoice = null
    this.banners = new Map()
    this.disposed = false
    this.k = { state: 'none', info: null, python: null, message: '', starting: null }
    this.cw = 0
    this.build()
    this.onHide = () => this.ctx.rpc('shutdown', { key: this.key }).catch(() => {})
    window.addEventListener('pagehide', this.onHide)
    this.timers = [setInterval(() => this.tick(), 250)]
    this.off = ctx.onEvent ? ctx.onEvent((ev, payload) => this.onHostEvent(ev, payload)) : null
    this.init()
  }

  // ------------------------------------------------------------------------------------------------- skeleton

  build() {
    const btn = (key, tip, keys, fn, cls = '') =>
      h('button', { class: 'nb-btn ' + cls, type: 'button', attrs: { 'data-tip': tip, ...(keys ? { 'data-tip-keys': keys } : {}), 'aria-label': tip }, onClick: fn }, ico(key))
    this.btnRun = btn('play', 'Run cell', 'Shift Enter', () => this.runSelected({ advance: true }))
    this.btnStop = btn('stop', 'Interrupt the kernel', 'I I', () => this.interrupt())
    this.btnRestart = btn('restart', 'Restart the kernel', '0 0', () => this.restart())
    this.btnAll = btn('playAll', 'Run all cells', '', () => this.runAll())
    this.kindSel = h(
      'select',
      { class: 'nb-kind', attrs: { 'aria-label': 'Cell type' }, onChange: () => this.setKind(this.cur(), this.kindSel.value) },
      Object.entries(KIND_LABEL).map(([v, l]) => h('option', { value: v }, l)),
    )
    this.nameEl = h('span', { class: 'nb-name' })
    this.dotEl = h('span', { class: 'nb-dirty', attrs: { 'aria-label': 'Unsaved changes' }, hidden: true })
    this.dot = h('span', { class: 'nb-kdot' })
    this.chipText = h('span', { class: 'nb-kt' }, 'Python')
    this.chip = h('button', { class: 'nb-chip', type: 'button', attrs: { 'aria-haspopup': 'menu' }, onClick: () => this.kernelMenu() }, this.dot, this.chipText, ico('chevDown'))
    this.btnMore = btn('more', 'Notebook menu', '', () => this.moreMenu())
    this.bar = h(
      'div',
      { class: 'nb-bar' },
      h('span', { class: 'nb-bico' }, ico('notebook')),
      h('span', { class: 'nb-title' }, this.nameEl, this.dotEl),
      h('span', { class: 'nb-bsep' }),
      this.btnRun,
      this.btnStop,
      this.btnRestart,
      this.btnAll,
      this.kindSel,
      h('span', { class: 'nb-grow' }),
      this.chip,
      this.btnMore,
    )
    this.bannerEl = h('div', { class: 'nb-banners' })
    this.cellsEl = h('div', { class: 'nb-cells' })
    this.addEl = h(
      'div',
      { class: 'nb-add' },
      h('button', { class: 'nb-addb', type: 'button', onClick: () => this.insertCell('code', this.cells.length - 1, true) }, ico('plus'), 'Code'),
      h('button', { class: 'nb-addb', type: 'button', onClick: () => this.insertCell('markdown', this.cells.length - 1, true) }, ico('plus'), 'Markdown'),
    )
    this.scroller = h('div', { class: 'nb-scroll' }, this.cellsEl, this.addEl)
    this.stateEl = h('div', { class: 'nb-state' }, h('span', { class: 'nb-spin' }), 'Opening…')
    this.root = h('div', { class: 'nb', tabindex: '-1', onKeydown: (e) => this.onCommandKey(e) }, this.bar, this.bannerEl, this.scroller, this.stateEl)
    this.el.append(this.root)
    this.root.addEventListener('focusin', (e) => {
      const cell = this.cellOf(e.target)
      if (cell) this.select(this.cells.indexOf(cell), { keepFocus: true })
    })
    this.root.addEventListener('pointerdown', (e) => {
      const cell = this.cellOf(e.target)
      if (!cell) return
      this.select(this.cells.indexOf(cell), { keepFocus: true })
      if (!e.target.closest('textarea, button, input, a, select, summary, .nb-out, .nb-md')) this.root.focus({ preventScroll: true })
    })
    this.root.addEventListener('copy', () => {})
    this.setBar()
  }

  cellOf(node) {
    const el = node && node.closest ? node.closest('.nb-cell') : null
    return el ? this.cells.find((c) => c.el === el) : null
  }

  cur() {
    return this.cells[this.sel] || null
  }

  setBar() {
    this.nameEl.textContent = this.name
    this.dotEl.hidden = !this.dirty
    const running = this.cells.some((c) => c.state !== 'idle')
    this.btnStop.disabled = !running
    const s = this.k.state
    this.root.dataset.kernel = s === 'idle' && running ? 'busy' : s
    let label = 'Python'
    if (this.k.python) label = this.k.python.label
    else if (this.k.info) label = 'Python ' + this.k.info.python
    else if (this.pythons && this.pythons[0]) label = this.pythons[(this.pythonChoice && this.pythons.findIndex((p) => p.exe === this.pythonChoice)) || 0]?.label || this.pythons[0].label
    if (s === 'nopython') label = 'No Python'
    if (s === 'starting') label = 'Starting…'
    if (s === 'dead') label = this.k.python ? this.k.python.label + ' · stopped' : 'Kernel stopped'
    this.chipText.textContent = label
    const cell = this.cur()
    if (cell && this.kindSel.value !== cell.kind) this.kindSel.value = cell.kind
    this.ctx.setTitle && this.ctx.setTitle(this.name + (this.dirty ? ' •' : ''))
  }

  // ------------------------------------------------------------------------------------------------- loading

  async loadSettings() {
    const cfg = { ...DEFAULTS }
    try {
      const d = window.pager && window.pager.d
      const s = d ? await d.call('settings.get') : null
      Object.assign(cfg, (s && s.notebook) || {})
    } catch {
      /* no daemon in this host */
    }
    Object.assign(cfg, (this.ctx.settings && this.ctx.settings.notebook) || {}, this.args.settings || {})
    this.cfg = cfg
    this.applyCfg()
  }

  applyCfg() {
    this.root.classList.toggle('ln', !!this.cfg.line_numbers)
    this.root.classList.toggle('wrap', !!this.cfg.wrap_code)
    this.root.style.setProperty('--nb-out-lines', String(this.cfg.scroll_outputs_lines || 0))
  }

  async init() {
    await this.loadSettings()
    try {
      const r = await this.ctx.rpc('open', { path: this.args.path || null, cwd: this.ctx.cwd || undefined })
      if (this.disposed) return
      if (r.ok === false) return this.fatal(r.error, r.path)
      this.load(r)
    } catch (err) {
      return this.fatal(err && err.message ? err.message : String(err), this.args.path)
    }
    this.ctx.rpc('interpreters', { cwd: this.kernelDir(), python: this.cfg.python || undefined }).then(
      (r) => {
        this.pythons = r.list
        if (!r.list.length) {
          this.k.state = 'nopython'
          this.k.message = 'No Python 3.8 or newer was found. Install Python, then run a cell again (or pick an interpreter in Settings > Notebooks).'
          this.setBanner('python', { kind: 'warn', text: this.k.message, actions: [{ label: 'Check again', run: () => this.recheckPython() }] })
        }
        this.setBar()
        if (this.cfg.start_on_open && r.list.length) this.ensureKernel()
      },
      () => {},
    )
  }

  fatal(message, path) {
    this.stateEl.replaceChildren(
      h('div', { class: 'nb-fatal' }, h('div', { class: 'nb-fatal-t' }, ico('warn'), 'This notebook cannot be opened'), h('div', { class: 'nb-fatal-m' }, message), path ? h('div', { class: 'nb-fatal-p' }, path) : null, h('button', { class: 'nb-addb', type: 'button', onClick: () => { this.stateEl.replaceChildren(h('span', { class: 'nb-spin' }), 'Opening…'); this.init() } }, 'Try again')),
    )
    this.stateEl.hidden = false
    this.name = baseName(path) || this.name
    this.setBar()
  }

  load(r) {
    this.path = r.path
    this.name = r.name || 'Untitled.ipynb'
    this.nb = r.nb
    this.format = r.format
    this.mtimeMs = r.mtimeMs
    this.cells = []
    this.cellsEl.replaceChildren()
    for (const raw of this.nb.cells) this.cells.push(this.buildCell(raw))
    if (!this.cells.length) this.cells.push(this.buildCell(this.freshRaw('code')))
    this.cellsEl.append(...this.cells.map((c) => c.el))
    this.stateEl.hidden = true
    this.dirty = !!r.missing
    this.dirtySince = r.missing ? Date.now() : 0
    this.sel = 0
    this.pythonChoice = this.path ? localStorage.getItem('pager.nb.python:' + this.path) : null
    this.applyFolds()
    this.select(0, { keepFocus: true, scroll: false })
    this.setBar()
  }

  kernelDir() {
    return (this.path && dirName(this.path)) || this.ctx.cwd || undefined
  }

  // ------------------------------------------------------------------------------------------------- cells

  freshRaw(kind) {
    const minor = this.nb && typeof this.nb.nbformat_minor === 'number' ? this.nb.nbformat_minor : 5
    return M.newCell(kind, minor >= 5 ? M.cellId() : undefined)
  }

  buildCell(raw) {
    const kind = raw.cell_type === 'code' || raw.cell_type === 'markdown' ? raw.cell_type : 'raw'
    const cell = { raw, kind, uid: uid('c'), state: 'idle', ms: null, run: M.newRun(), execId: null, editing: false, note: null, lineNumbers: null, t0: 0 }
    const meta = raw.metadata && raw.metadata.execution
    if (meta && meta['iopub.execute_input'] && meta['shell.execute_reply']) {
      const d = Date.parse(meta['shell.execute_reply']) - Date.parse(meta['iopub.execute_input'])
      if (d >= 0) cell.ms = d
    }
    cell.gut = h('div', { class: 'nb-gut' })
    cell.timeEl = h('div', { class: 'nb-time' })
    cell.mdEl = h('div', { class: 'nb-md', attrs: { 'data-placeholder': 'Empty markdown cell. Double-click or press Enter to edit.' } })
    cell.outsEl = h('div', { class: 'nb-outs' })
    cell.edWrap = this.buildEditor(cell)
    cell.tools = h(
      'div',
      { class: 'nb-tools' },
      h('button', { class: 'nb-tb', type: 'button', attrs: { 'data-tip': 'Run cell', 'aria-label': 'Run cell' }, onClick: () => this.runCells([cell]) }, ico('play')),
      h('button', { class: 'nb-tb', type: 'button', attrs: { 'data-tip': 'Move up', 'aria-label': 'Move cell up' }, onClick: () => this.move(cell, -1) }, ico('up')),
      h('button', { class: 'nb-tb', type: 'button', attrs: { 'data-tip': 'Move down', 'aria-label': 'Move cell down' }, onClick: () => this.move(cell, 1) }, ico('down')),
      h('button', { class: 'nb-tb', type: 'button', attrs: { 'data-tip': 'Add cell below', 'aria-label': 'Add a cell below' }, onClick: () => this.insertCell('code', this.cells.indexOf(cell), true) }, ico('plus')),
      h('button', { class: 'nb-tb danger', type: 'button', attrs: { 'data-tip': 'Delete cell', 'aria-label': 'Delete cell' }, onClick: () => this.deleteCell(cell) }, ico('trash')),
    )
    cell.body = h('div', { class: 'nb-body' }, cell.edWrap, cell.mdEl, cell.outsEl)
    cell.el = h('div', { class: `nb-cell nb-${kind}` }, cell.gut, cell.body, cell.tools, cell.timeEl)
    cell.mdEl.addEventListener('dblclick', () => this.editCell(cell))
    cell.mdEl.addEventListener('click', (e) => this.onLinkClick(e))
    this.refreshCell(cell)
    if (kind === 'markdown') this.renderMd(cell)
    else this.renderOutputs(cell)
    return cell
  }

  refreshCell(cell) {
    const el = cell.el
    el.classList.remove('nb-code', 'nb-markdown', 'nb-raw')
    el.classList.add('nb-' + cell.kind)
    el.classList.toggle('editing', cell.editing)
    el.dataset.state = cell.state
    cell.edWrap.hidden = cell.kind === 'markdown' && !cell.editing
    cell.mdEl.hidden = cell.kind !== 'markdown' || cell.editing
    cell.outsEl.hidden = cell.kind !== 'code'
    el.classList.toggle('ln', cell.lineNumbers === null ? false : cell.lineNumbers)
    el.classList.toggle('no-ln', cell.lineNumbers === false)
    this.paintGutter(cell)
    this.paintTime(cell)
  }

  paintGutter(cell) {
    cell.gut.replaceChildren()
    if (cell.kind === 'code') {
      const n = cell.raw.execution_count
      const label = cell.state === 'running' ? '[*]:' : cell.state === 'queued' ? '[…]:' : n ? `[${n}]:` : '[ ]:'
      cell.gut.append(h('span', { class: 'nb-prompt' }, label))
    } else if (cell.kind === 'markdown' && this.headingLevel(cell) > 0) {
      const folded = this.folded.has(cell)
      cell.gut.append(h('button', { class: 'nb-fold' + (folded ? ' on' : ''), type: 'button', attrs: { 'aria-label': folded ? 'Expand section' : 'Collapse section', 'data-tip': folded ? 'Expand section' : 'Collapse section' }, onClick: () => this.toggleFold(cell) }, ico(folded ? 'chevRight' : 'chevDown')))
    }
  }

  paintTime(cell) {
    let text = ''
    if (cell.state === 'running') text = M.formatDuration(performance.now() - cell.t0)
    else if (cell.state === 'idle' && cell.ms !== null && cell.kind === 'code') text = M.formatDuration(cell.ms)
    cell.timeEl.textContent = text
  }

  tick() {
    let any = false
    for (const c of this.cells) {
      if (c.state === 'running') {
        this.paintTime(c)
        any = true
      }
    }
    if (any) this.setBar()
    this.autosave()
  }

  headingLevel(cell) {
    const m = /^\s{0,3}(#{1,6})\s/.exec(M.sourceOf(cell.raw))
    return m ? m[1].length : 0
  }

  toggleFold(cell) {
    if (this.folded.has(cell)) this.folded.delete(cell)
    else this.folded.add(cell)
    this.applyFolds()
    this.paintGutter(cell)
  }

  applyFolds() {
    let level = null
    for (const c of this.cells) {
      const lv = c.kind === 'markdown' ? this.headingLevel(c) : 0
      if (level !== null && lv > 0 && lv <= level) level = null
      c.el.classList.toggle('folded-away', level !== null)
      if (level === null && lv > 0 && this.folded.has(c)) level = lv
    }
  }

  // ------------------------------------------------------------------------------------------------- editor

  buildEditor(cell) {
    const ta = h('textarea', { class: 'nb-ta', rows: 1, attrs: { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', 'aria-label': `${KIND_LABEL[cell.kind]} cell source` } })
    ta.value = M.sourceOf(cell.raw)
    const hl = h('pre', { class: 'nb-hl', attrs: { 'aria-hidden': 'true' } })
    const inner = h('div', { class: 'nb-ed-in' }, hl, ta)
    const wrap = h('div', { class: 'nb-ed' }, inner)
    cell.ta = ta
    cell.hl = hl
    const paint = () => {
      cell.hl.innerHTML = highlightLines(ta.value, cell.kind === 'code')
    }
    cell.paint = paint
    paint()
    ta.addEventListener('input', (e) => {
      if (M.setSource(cell.raw, ta.value)) this.markDirty()
      paint()
      if (cell.kind === 'markdown' && !cell.editing) this.renderMd(cell)
      this.closePopups()
      if (this.cfg.complete_while_typing && cell.kind === 'code' && e.inputType && e.inputType.startsWith('insert') && /[A-Za-z0-9_.]$/.test(ta.value.slice(0, ta.selectionStart))) {
        clearTimeout(cell.compTimer)
        cell.compTimer = setTimeout(() => this.complete(cell, { auto: true }), 220)
      }
    })
    ta.addEventListener('keydown', (e) => this.onEditorKey(cell, e))
    ta.addEventListener('blur', () => setTimeout(() => !this.root.contains(document.activeElement) && this.closePopups(), 120))
    return wrap
  }

  setSourceText(cell, text) {
    cell.ta.value = text
    if (M.setSource(cell.raw, text)) this.markDirty()
    cell.paint()
  }

  editCell(cell) {
    const i = this.cells.indexOf(cell)
    if (i < 0) return
    if (cell.kind === 'markdown') {
      cell.editing = true
      this.refreshCell(cell)
    }
    this.select(i, { keepFocus: true })
    cell.ta.focus()
  }

  charWidth() {
    if (this.cw) return this.cw
    const probe = h('span', { class: 'nb-probe' }, '0'.repeat(20))
    this.root.append(probe)
    this.cw = probe.getBoundingClientRect().width / 20 || 7.5
    probe.remove()
    return this.cw
  }

  onEditorKey(cell, e) {
    const ta = cell.ta
    if (this.popup && this.popupKey(cell, e)) return
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      this.runSelected({ advance: true })
    } else if (e.key === 'Enter' && mod) {
      e.preventDefault()
      this.runCells([cell])
      if (cell.kind === 'markdown') this.leaveEdit(cell)
    } else if (e.key === 'Enter' && e.altKey) {
      e.preventDefault()
      this.runCells([cell])
      this.insertCell('code', this.cells.indexOf(cell), true)
    } else if (e.key === 's' && mod) {
      e.preventDefault()
      this.save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      this.leaveEdit(cell)
    } else if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault()
      this.onTab(cell, e.shiftKey)
    } else if (e.key === 'Enter' && !mod && !e.altKey && cell.kind === 'code' && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault()
      const before = ta.value.slice(0, ta.selectionStart)
      const line = before.slice(before.lastIndexOf('\n') + 1)
      insertText(ta, '\n' + M.autoIndent(line))
    } else if (mod && e.key === '/' && cell.kind === 'code') {
      e.preventDefault()
      this.toggleComment(cell)
    } else if (mod && (e.key === ']' || e.key === '[')) {
      e.preventDefault()
      this.shiftLines(cell, e.key === '[' ? -1 : 1)
    } else if (e.key === 'ArrowUp' && !e.shiftKey && !mod && !e.altKey && ta.selectionStart === ta.selectionEnd && !ta.value.slice(0, ta.selectionStart).includes('\n')) {
      const i = this.cells.indexOf(cell)
      const prev = this.visibleNeighbor(i, -1)
      if (prev) {
        e.preventDefault()
        this.editCell(prev)
        prev.ta.setSelectionRange(prev.ta.value.length, prev.ta.value.length)
      }
    } else if (e.key === 'ArrowDown' && !e.shiftKey && !mod && !e.altKey && ta.selectionStart === ta.selectionEnd && !ta.value.slice(ta.selectionEnd).includes('\n')) {
      const next = this.visibleNeighbor(this.cells.indexOf(cell), 1)
      if (next) {
        e.preventDefault()
        this.editCell(next)
        next.ta.setSelectionRange(0, 0)
      }
    }
  }

  visibleNeighbor(i, dir) {
    for (let k = i + dir; k >= 0 && k < this.cells.length; k += dir) if (!this.cells[k].el.classList.contains('folded-away')) return this.cells[k]
    return null
  }

  leaveEdit(cell) {
    this.closePopups()
    if (cell.kind === 'markdown') {
      cell.editing = false
      this.renderMd(cell)
      this.refreshCell(cell)
    }
    cell.ta.blur()
    this.root.focus({ preventScroll: true })
  }

  onTab(cell, shift) {
    const ta = cell.ta
    const { selectionStart: a, selectionEnd: b, value } = ta
    const multi = value.slice(a, b).includes('\n')
    const lineStart = value.lastIndexOf('\n', a - 1) + 1
    const before = value.slice(lineStart, a)
    if (shift) {
      if (multi || /^\s*$/.test(before)) return this.shiftLines(cell, -1)
      return this.inspect(cell)
    }
    if (multi) return this.shiftLines(cell, 1)
    if (cell.kind === 'code' && a === b && M.wantsCompletion(value.slice(0, a))) return this.complete(cell, {})
    insertText(ta, '    ')
  }

  shiftLines(cell, dir) {
    const ta = cell.ta
    const { value } = ta
    const a = value.lastIndexOf('\n', ta.selectionStart - 1) + 1
    let b = value.indexOf('\n', ta.selectionEnd)
    if (b < 0) b = value.length
    const lines = value.slice(a, b).split('\n')
    const out = lines.map((l) => (dir > 0 ? '    ' + l : l.replace(/^( {1,4}|\t)/, '')))
    const text = out.join('\n')
    ta.setSelectionRange(a, b)
    insertText(ta, text)
    ta.setSelectionRange(a, a + text.length)
  }

  toggleComment(cell) {
    const ta = cell.ta
    const { value } = ta
    const a = value.lastIndexOf('\n', ta.selectionStart - 1) + 1
    let b = value.indexOf('\n', ta.selectionEnd)
    if (b < 0) b = value.length
    const lines = value.slice(a, b).split('\n')
    const all = lines.filter((l) => l.trim()).every((l) => /^\s*#/.test(l))
    const text = lines.map((l) => (!l.trim() ? l : all ? l.replace(/^(\s*)# ?/, '$1') : l.replace(/^(\s*)/, '$1# '))).join('\n')
    ta.setSelectionRange(a, b)
    insertText(ta, text)
    ta.setSelectionRange(a, a + text.length)
  }

  // ------------------------------------------------------------------------------------------------- completion / inspect

  closePopups() {
    clearTimeout(this.compTimerAny)
    if (this.popup) {
      this.popup.el.remove()
      this.popup = null
    }
    if (this.tip) {
      this.tip.remove()
      this.tip = null
    }
  }

  caretBox(cell) {
    const ta = cell.ta
    const before = ta.value.slice(0, ta.selectionStart)
    const line = before.split('\n').length - 1
    const col = before.length - (before.lastIndexOf('\n') + 1)
    const lh = parseFloat(getComputedStyle(cell.hl).lineHeight) || 20
    const rect = cell.edWrap.getBoundingClientRect()
    const body = cell.body.getBoundingClientRect()
    const wrapped = this.cfg.wrap_code
    const x = (wrapped ? Math.min(col, 60) : col) * this.charWidth() + (cell.el.classList.contains('ln') || this.cfg.line_numbers ? 44 : 12) - (wrapped ? 0 : cell.edWrap.scrollLeft)
    return { left: Math.max(0, x), top: rect.top - body.top + (line + 1) * lh + 8 }
  }

  async complete(cell, { auto = false }) {
    const ta = cell.ta
    const cursor = ta.selectionStart
    const code = ta.value
    const ok = await this.ensureKernel()
    if (!ok.ok || cell.ta.value !== code) return
    let r
    try {
      r = await this.ctx.rpc('complete', { key: this.key, code, cursor })
    } catch {
      return
    }
    if (!r || cell.ta.value !== code || ta.selectionStart !== cursor) return
    const matches = (r.matches || []).map((m) => (typeof m === 'string' ? { text: m, type: '' } : m)).filter((m) => m && m.text)
    if (!matches.length) return
    const start = typeof r.cursor_start === 'number' ? r.cursor_start : cursor
    if (matches.length === 1 && !auto) return this.applyCompletion(cell, start, cursor, matches[0].text)
    this.closePopups()
    const pop = h('div', { class: 'nb-comp', role: 'listbox' })
    const rows = matches.slice(0, 200).map((m, i) =>
      h('div', { class: 'nb-comp-row' + (i === 0 ? ' on' : ''), role: 'option', onPointerdown: (e) => { e.preventDefault(); this.applyCompletion(cell, start, cursor, m.text) } }, h('span', { class: 'nb-comp-k k-' + (m.type || 'x') }, COMP_ICON[m.type] || '·'), h('span', { class: 'nb-comp-t' }, m.text), m.type ? h('span', { class: 'nb-comp-y' }, m.type) : null),
    )
    pop.append(...rows)
    const box = this.caretBox(cell)
    pop.style.left = box.left + 'px'
    pop.style.top = box.top + 'px'
    cell.body.append(pop)
    this.popup = { el: pop, rows, index: 0, matches, start, cursor }
  }

  applyCompletion(cell, start, end, text) {
    this.closePopups()
    cell.ta.setSelectionRange(start, Math.max(end, cell.ta.selectionStart))
    insertText(cell.ta, text)
  }

  popupKey(cell, e) {
    const p = this.popup
    const move = (d) => {
      p.rows[p.index].classList.remove('on')
      p.index = (p.index + d + p.rows.length) % p.rows.length
      p.rows[p.index].classList.add('on')
      p.rows[p.index].scrollIntoView({ block: 'nearest' })
    }
    if (e.key === 'ArrowDown') move(1)
    else if (e.key === 'ArrowUp') move(-1)
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return false
      this.applyCompletion(cell, p.start, p.cursor, p.matches[p.index].text)
    } else if (e.key === 'Escape') this.closePopups()
    else return false
    e.preventDefault()
    return true
  }

  async inspect(cell) {
    const ta = cell.ta
    const ok = await this.ensureKernel()
    if (!ok.ok) return
    let r
    try {
      r = await this.ctx.rpc('inspect', { key: this.key, code: ta.value, cursor: ta.selectionStart, detail: 0 })
    } catch {
      return
    }
    this.closePopups()
    if (!r || !r.found) return
    const text = (r.data && r.data['text/plain']) || ''
    if (!text) return
    const tip = h('div', { class: 'nb-tip' }, h('pre', { html: ansiHtml(text) }))
    const box = this.caretBox(cell)
    tip.style.left = box.left + 'px'
    tip.style.top = box.top + 'px'
    cell.body.append(tip)
    this.tip = tip
  }

  // ------------------------------------------------------------------------------------------------- selection & command mode

  select(i, { keepFocus = false, scroll = true } = {}) {
    if (!this.cells.length) return
    i = Math.max(0, Math.min(this.cells.length - 1, i))
    const prev = this.cells[this.sel]
    if (prev && prev !== this.cells[i]) {
      prev.el.classList.remove('sel')
      if (prev.kind === 'markdown' && prev.editing && document.activeElement !== prev.ta) {
        prev.editing = false
        this.renderMd(prev)
        this.refreshCell(prev)
      }
    }
    this.sel = i
    const cell = this.cells[i]
    cell.el.classList.add('sel')
    this.kindSel.value = cell.kind
    if (scroll) cell.el.scrollIntoView({ block: 'nearest' })
    if (!keepFocus) this.root.focus({ preventScroll: true })
  }

  onCommandKey(e) {
    if (e.target !== this.root) return
    const cell = this.cur()
    const mod = e.ctrlKey || e.metaKey
    const k = e.key
    const done = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (mod && k === 's') return (done(), this.save())
    if (mod || e.altKey) {
      if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown') && cell) return (done(), this.move(cell, k === 'ArrowUp' ? -1 : 1))
      if (k === 'Enter' && mod && cell) return (done(), this.runCells([cell]))
      if (k === 'Enter' && e.altKey && cell) return (done(), this.runCells([cell]), this.insertCell('code', this.sel, true))
      return
    }
    if (!cell) return
    const pending = this.chord
    this.chord = null
    if (k === 'Enter' && e.shiftKey) return (done(), this.runSelected({ advance: true }))
    if (k === 'Enter') return (done(), this.editCell(cell))
    if (k === 'ArrowUp' || k === 'k') return (done(), this.select(this.indexNeighbor(-1)))
    if (k === 'ArrowDown' || k === 'j') return (done(), this.select(this.indexNeighbor(1)))
    if (k === 'a') return (done(), this.insertCell('code', this.sel - 1, false))
    if (k === 'b') return (done(), this.insertCell('code', this.sel, false))
    if (k === 'm') return (done(), this.setKind(cell, 'markdown'))
    if (k === 'y') return (done(), this.setKind(cell, 'code'))
    if (k === 'r') return (done(), this.setKind(cell, 'raw'))
    if (/^[1-6]$/.test(k)) return (done(), this.setHeading(cell, Number(k)))
    if (k === 'd') {
      done()
      if (pending === 'd') this.deleteCell(cell)
      else this.chord = 'd'
      return
    }
    if (k === 'i') {
      done()
      if (pending === 'i') this.interrupt()
      else this.chord = 'i'
      return
    }
    if (k === '0') {
      done()
      if (pending === '0') this.restart()
      else this.chord = '0'
      return
    }
    if (k === 'c') return (done(), this.copyCell(cell))
    if (k === 'x') return (done(), this.copyCell(cell), this.deleteCell(cell, { remember: true }))
    if (k === 'v') return (done(), this.pasteCell())
    if (k === 'z') return (done(), this.undeleteCell())
    if (k === 'l') {
      done()
      cell.lineNumbers = cell.lineNumbers === null ? !this.cfg.line_numbers : !cell.lineNumbers
      this.refreshCell(cell)
      return
    }
    if (k === 'Escape') return (done(), this.closePopups())
  }

  indexNeighbor(dir) {
    const n = this.visibleNeighbor(this.sel, dir)
    return n ? this.cells.indexOf(n) : this.sel
  }

  // ------------------------------------------------------------------------------------------------- structure edits

  markDirty() {
    if (!this.dirty) this.dirtySince = Date.now()
    this.dirty = true
    this.setBar()
  }

  insertCell(kind, after, edit) {
    const raw = this.freshRaw(kind)
    const cell = this.buildCell(raw)
    const at = Math.max(-1, Math.min(this.cells.length - 1, after)) + 1
    this.cells.splice(at, 0, cell)
    this.cellsEl.insertBefore(cell.el, this.cells[at + 1] ? this.cells[at + 1].el : null)
    this.syncCells()
    this.markDirty()
    this.select(at, { keepFocus: !!edit })
    if (edit) this.editCell(cell)
    return cell
  }

  syncCells() {
    this.nb.cells = this.cells.map((c) => c.raw)
    this.applyFolds()
  }

  deleteCell(cell, { remember = true } = {}) {
    const i = this.cells.indexOf(cell)
    if (i < 0) return
    if (cell.state !== 'idle') this.interrupt()
    if (remember) this.deleted.push({ raw: cell.raw, index: i })
    if (this.deleted.length > 30) this.deleted.shift()
    this.cells.splice(i, 1)
    cell.el.remove()
    this.folded.delete(cell)
    if (!this.cells.length) {
      const fresh = this.buildCell(this.freshRaw('code'))
      this.cells.push(fresh)
      this.cellsEl.append(fresh.el)
    }
    this.syncCells()
    this.markDirty()
    this.sel = Math.min(i, this.cells.length - 1)
    this.select(this.sel)
  }

  undeleteCell() {
    const d = this.deleted.pop()
    if (!d) return
    const cell = this.buildCell(d.raw)
    const at = Math.min(d.index, this.cells.length)
    this.cells.splice(at, 0, cell)
    this.cellsEl.insertBefore(cell.el, this.cells[at + 1] ? this.cells[at + 1].el : null)
    this.syncCells()
    this.markDirty()
    this.select(at)
  }

  copyCell(cell) {
    this.clip = JSON.parse(JSON.stringify(cell.raw))
  }

  pasteCell() {
    if (!this.clip) return
    const raw = JSON.parse(JSON.stringify(this.clip))
    if (raw.id !== undefined) raw.id = M.cellId()
    const cell = this.buildCell(raw)
    const at = this.sel + 1
    this.cells.splice(at, 0, cell)
    this.cellsEl.insertBefore(cell.el, this.cells[at + 1] ? this.cells[at + 1].el : null)
    this.syncCells()
    this.markDirty()
    this.select(at)
  }

  move(cell, dir) {
    const i = this.cells.indexOf(cell)
    const j = i + dir
    if (i < 0 || j < 0 || j >= this.cells.length) return
    this.cells.splice(i, 1)
    this.cells.splice(j, 0, cell)
    this.cellsEl.insertBefore(cell.el, dir > 0 ? (this.cells[j + 1] ? this.cells[j + 1].el : null) : this.cells[j + 1].el)
    this.syncCells()
    this.markDirty()
    this.select(j, { keepFocus: document.activeElement === cell.ta })
  }

  setKind(cell, kind) {
    if (!cell || cell.kind === kind) return
    const i = this.cells.indexOf(cell)
    const raw = cell.raw
    raw.cell_type = kind
    if (kind === 'code') {
      if (!Array.isArray(raw.outputs)) raw.outputs = []
      if (!('execution_count' in raw)) raw.execution_count = null
    } else {
      delete raw.outputs
      delete raw.execution_count
    }
    const next = this.buildCell(raw)
    const wasSel = this.sel === i
    this.cells[i] = next
    cell.el.replaceWith(next.el)
    this.syncCells()
    this.markDirty()
    if (wasSel) this.select(i)
  }

  setHeading(cell, level) {
    if (cell.kind !== 'markdown') this.setKind(cell, 'markdown')
    const now = this.cur()
    const text = M.sourceOf(now.raw).replace(/^\s{0,3}#{1,6}\s*/, '')
    this.setSourceText(now, '#'.repeat(level) + ' ' + text)
    this.renderMd(now)
    this.paintGutter(now)
    this.applyFolds()
  }

  // ------------------------------------------------------------------------------------------------- markdown

  renderMd(cell) {
    const src = M.sourceOf(cell.raw)
    const frag = sanitize(M.renderMarkdown(src))
    const att = cell.raw.attachments
    for (const img of frag.querySelectorAll('img[src^="attachment:"]')) {
      const name = img.getAttribute('src').slice(11)
      const bundle = att && att[name]
      const mime = bundle && Object.keys(bundle).find((m) => m.startsWith('image/'))
      if (mime) img.src = `data:${mime};base64,${M.joinText(bundle[mime]).replace(/\s/g, '')}`
      else img.removeAttribute('src')
    }
    cell.mdEl.classList.toggle('empty', !src.trim())
    cell.mdEl.replaceChildren(frag)
    this.paintGutter(cell)
  }

  onLinkClick(e) {
    const a = e.target.closest && e.target.closest('a[href]')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') || ''
    if (/^https?:/i.test(href)) {
      try {
        this.ctx.openBlock && this.ctx.openBlock('browser', { url: href })
      } catch {
        /* no browser block here */
      }
    }
  }

  // ------------------------------------------------------------------------------------------------- outputs

  renderOutputs(cell) {
    const box = cell.outsEl
    box.replaceChildren()
    for (const out of cell.raw.outputs || []) box.append(this.outputEl(cell, out))
    if (cell.note) box.append(h('div', { class: 'nb-out nb-note' }, cell.note))
  }

  outputEl(cell, out) {
    let el
    if (out.output_type === 'stream') el = this.streamEl(out)
    else if (out.output_type === 'error') el = this.errorEl(out)
    else el = this.richEl(out)
    el._out = out
    return el
  }

  capLines(el, text) {
    const max = this.cfg.scroll_outputs_lines
    const capped = max > 0 && lineCount(text) > max
    el.classList.toggle('capped', capped)
    if (capped) el.style.setProperty('--nb-cap', String(max))
  }

  streamEl(out) {
    const el = h('div', { class: 'nb-out nb-stream' + (out.name === 'stderr' ? ' nb-stderr' : '') }, h('pre'))
    this.fillStream(el, out)
    return el
  }

  fillStream(el, out) {
    const text = M.joinText(out.text).replace(/\r$/, '')
    el.firstChild.innerHTML = ansiHtml(text)
    this.capLines(el, text)
  }

  errorEl(out) {
    const tb = Array.isArray(out.traceback) && out.traceback.length ? out.traceback.join('\n') : `${out.ename}: ${out.evalue}`
    const el = h('div', { class: 'nb-out nb-error' }, h('pre', { html: ansiHtml(tb) }))
    this.capLines(el, tb)
    return el
  }

  richEl(out) {
    const data = out.data || {}
    const mime = M.pickMime(data)
    const meta = (out.metadata && out.metadata[mime]) || {}
    const el = h('div', { class: 'nb-out nb-rich' + (out.output_type === 'execute_result' ? ' nb-result' : '') })
    if (out.output_type === 'execute_result') el.append(h('span', { class: 'nb-outp' }, `Out[${out.execution_count ?? ' '}]:`))
    const body = h('div', { class: 'nb-rbody' })
    el.append(body)
    const text = (m) => M.joinText(data[m])
    if (mime === 'text/html') {
      const host = h('div', { class: 'nb-html' })
      const root = host.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.textContent = HTML_BASE_CSS
      root.append(style, sanitize(text(mime), { allowStyle: true }))
      for (const a of root.querySelectorAll('a[href]')) a.addEventListener('click', (e) => this.onLinkClick(e))
      body.append(host)
      this.capLines(el, text(mime).replace(/<[^>]*>/g, ''))
    } else if (mime === 'text/markdown') {
      const md = h('div', { class: 'nb-md' })
      md.append(sanitize(M.renderMarkdown(text(mime))))
      md.addEventListener('click', (e) => this.onLinkClick(e))
      body.append(md)
    } else if (mime === 'image/svg+xml') {
      body.append(h('img', { class: 'nb-img', src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text(mime)), alt: 'SVG output' }))
    } else if (mime && mime.startsWith('image/')) {
      const img = h('img', { class: 'nb-img', src: `data:${mime};base64,${text(mime).replace(/\s/g, '')}`, alt: 'Image output' })
      if (meta.width) img.style.width = meta.width + 'px'
      if (meta.height) img.style.aspectRatio = meta.width && meta.height ? `${meta.width} / ${meta.height}` : ''
      body.append(img)
    } else if (mime === 'application/json') {
      const t = typeof data[mime] === 'string' ? data[mime] : JSON.stringify(data[mime], null, 2)
      body.append(h('pre', null, t))
      this.capLines(el, t)
    } else if (mime) {
      const t = text(mime).replace(/^\$\$|\$\$$/g, '')
      body.append(h('pre', { html: ansiHtml(t) }))
      this.capLines(el, t)
    } else body.append(h('pre', { class: 'dim' }, '(output without a displayable format)'))
    return el
  }

  patchOutputs(cell, change) {
    if (!change) return
    if (change.type === 'reset') return this.renderOutputs(cell)
    const outs = cell.raw.outputs
    const box = cell.outsEl
    if (change.type === 'append') {
      const el = this.outputEl(cell, outs[change.index])
      const tail = box.querySelector(':scope > .nb-note, :scope > .nb-askin')
      box.insertBefore(el, tail)
      this.followOutput(cell)
    } else if (change.type === 'stream') {
      cell.streamDirty = true
      if (!cell.streamRaf)
        cell.streamRaf = requestAnimationFrame(() => {
          cell.streamRaf = 0
          cell.streamDirty = false
          const els = Array.from(box.children).filter((c) => c._out)
          const last = els[els.length - 1]
          const out = outs[outs.length - 1]
          if (last && out && last._out === out) this.fillStream(last, out)
          else this.renderOutputs(cell)
          this.followOutput(cell)
        })
    }
  }

  followOutput(cell) {
    if (cell.state === 'running' && this.cells[this.sel] === cell && this.follow) cell.outsEl.lastElementChild && cell.outsEl.lastElementChild.scrollIntoView({ block: 'nearest' })
  }

  // ------------------------------------------------------------------------------------------------- kernel

  startArgs() {
    return { key: this.key, cwd: this.kernelDir(), python: this.pythonChoice || this.cfg.python || '', figureFormat: this.cfg.figure_format }
  }

  ensureKernel() {
    const s = this.k.state
    if (s === 'idle' || s === 'busy') return Promise.resolve({ ok: true })
    if (this.k.starting) return this.k.starting
    this.k.state = 'starting'
    this.setBar()
    this.k.starting = (async () => {
      let r
      try {
        r = await this.ctx.rpc('kernelStart', this.startArgs())
      } catch (err) {
        r = { ok: false, code: 'KERNEL_START', message: err && err.message ? err.message : String(err) }
      }
      this.k.starting = null
      if (this.disposed) return r
      if (r.ok) {
        this.k.info = r.info
        this.k.python = r.python
        this.k.state = 'idle'
        this.k.message = ''
        this.setBanner('python', null)
        this.setBanner('kernel', null)
      } else {
        this.k.state = r.code === 'NO_PYTHON' || r.code === 'BAD_PYTHON' ? 'nopython' : 'dead'
        this.k.message = r.message
        this.setBanner(r.code === 'NO_PYTHON' || r.code === 'BAD_PYTHON' ? 'python' : 'kernel', { kind: 'error', text: r.message, actions: [{ label: r.code === 'NO_PYTHON' ? 'Check again' : 'Try again', run: () => this.recheckPython() }] })
      }
      this.setBar()
      return r
    })()
    return this.k.starting
  }

  async recheckPython() {
    this.setBanner('python', null)
    this.setBanner('kernel', null)
    try {
      const r = await this.ctx.rpc('interpreters', { cwd: this.kernelDir(), python: this.cfg.python || undefined, refresh: true })
      this.pythons = r.list
    } catch {
      /* keep the old list */
    }
    this.k.state = 'none'
    const r = await this.ensureKernel()
    if (r.ok) this.ctx.toast && this.ctx.toast('ok', 'Python kernel ready')
  }

  onHostEvent(ev, payload) {
    if (ev !== 'kernel' || !payload || payload.key !== this.key) return
    this.onKernel(payload.ev)
  }

  onKernel(ev) {
    if (!ev) return
    if (ev.type === 'exit') return this.onKernelExit(ev)
    if (ev.type === 'update') {
      const out = this.displays.get(ev.display_id)
      if (out) {
        M.updateDisplay(out.out, ev)
        const cell = out.cell
        const el = Array.from(cell.outsEl.children).find((c) => c._out === out.out)
        if (el) el.replaceWith(this.outputEl(cell, out.out))
        this.markDirty()
      }
      return
    }
    const cell = ev.id !== undefined ? this.execs.get(ev.id) : null
    if (!cell) return
    if (ev.type === 'started') {
      cell.state = 'running'
      cell.t0 = performance.now()
      cell.ms = null
      cell.note = null
      this.follow = true
      this.refreshCell(cell)
    } else if (ev.type === 'input') {
      return this.askInput(cell, ev)
    }
    const change = M.applyEvent(cell.raw, cell.run, ev)
    if (ev.type === 'display' && ev.display_id) {
      const out = cell.raw.outputs[cell.raw.outputs.length - 1]
      this.displays.set(ev.display_id, { cell, out })
    }
    if (change && change.type === 'done') return this.onDone(cell, ev)
    this.patchOutputs(cell, change)
    if (ev.type === 'started') this.markDirty()
    this.setBar()
  }

  onDone(cell, ev) {
    this.execs.delete(cell.execId)
    cell.execId = null
    cell.state = 'idle'
    cell.ms = ev.status === 'aborted' ? null : ev.ms
    cell.input && cell.input.remove()
    cell.input = null
    if (this.cfg.record_timing && ev.status !== 'aborted') {
      const end = new Date()
      cell.raw.metadata = cell.raw.metadata || {}
      cell.raw.metadata.execution = { 'iopub.execute_input': new Date(end.getTime() - (ev.ms || 0)).toISOString(), 'shell.execute_reply': end.toISOString() }
    }
    this.refreshCell(cell)
    if (cell.streamRaf) {
      cancelAnimationFrame(cell.streamRaf)
      cell.streamRaf = 0
      this.renderOutputs(cell)
    }
    this.markDirty()
    this.setBar()
  }

  onKernelExit(ev) {
    this.k.state = 'dead'
    this.k.starting = null
    for (const cell of this.cells) {
      if (cell.state !== 'idle') {
        cell.state = 'idle'
        cell.execId = null
        cell.note = ev.expected ? null : 'The kernel stopped while this cell was running.'
        this.refreshCell(cell)
        this.renderOutputs(cell)
      }
    }
    this.execs.clear()
    if (!ev.expected) {
      const detail = ev.stderr ? '\n' + ev.stderr.split('\n').slice(-6).join('\n') : ''
      this.setBanner('kernel', { kind: 'error', text: `The Python kernel stopped${ev.code !== null && ev.code !== undefined ? ` (exit code ${ev.code})` : ''}. Run a cell to start a fresh one.${detail}`, actions: [{ label: 'Restart', run: () => this.restart({ ask: false }) }] })
    }
    this.setBar()
  }

  askInput(cell, ev) {
    cell.input && cell.input.remove()
    const field = h('input', { class: 'nb-input', type: ev.password ? 'password' : 'text', attrs: { autocomplete: 'off', spellcheck: 'false', 'aria-label': ev.prompt || 'Input' } })
    const row = h('div', { class: 'nb-out nb-askin' }, h('span', { class: 'nb-askp' }, ev.prompt || ''), field)
    cell.input = row
    cell.outsEl.append(row)
    field.focus()
    field.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.interrupt()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const value = field.value
        row.remove()
        cell.input = null
        const shown = (ev.prompt || '') + (ev.password ? '' : value) + '\n'
        const change = M.applyEvent(cell.raw, cell.run, { type: 'stream', name: 'stdout', text: shown })
        this.patchOutputs(cell, change)
        try {
          await this.ctx.rpc('inputReply', { key: this.key, value })
        } catch {
          /* kernel gone */
        }
        this.markDirty()
      }
    })
  }

  // ------------------------------------------------------------------------------------------------- running

  runSelected({ advance = false } = {}) {
    const cell = this.cur()
    if (!cell) return
    const i = this.sel
    if (cell.kind === 'markdown') {
      this.runCells([cell])
      this.leaveEdit(cell)
    } else this.runCells([cell])
    if (advance) {
      if (i === this.cells.length - 1) this.insertCell('code', i, false)
      else this.select(this.indexNeighbor(1))
      if (document.activeElement === cell.ta || document.activeElement === this.root) this.root.focus({ preventScroll: true })
    }
  }

  async runCells(list) {
    for (const c of list) {
      if (c.kind === 'markdown') {
        c.editing = false
        this.renderMd(c)
        this.refreshCell(c)
      }
    }
    const code = list.filter((c) => c.kind === 'code' && c.state === 'idle')
    if (!code.length) return
    for (const c of code) {
      c.note = null
      c.state = 'queued'
      c.execId = `${this.key}:${++this.execSeq}`
      c.run = M.newRun()
      this.execs.set(c.execId, c)
      this.refreshCell(c)
    }
    this.setBar()
    const fail = (message) => {
      for (const c of code) {
        this.execs.delete(c.execId)
        c.execId = null
        c.state = 'idle'
        c.note = message
        this.refreshCell(c)
        this.renderOutputs(c)
      }
      this.setBar()
    }
    const ready = await this.ensureKernel()
    if (!ready.ok) return fail(ready.message || 'The kernel could not start.')
    const cells = code.filter((c) => c.state === 'queued').map((c) => ({ id: c.execId, code: M.sourceOf(c.raw) }))
    if (!cells.length) return
    try {
      const r = await this.ctx.rpc('execute', { ...this.startArgs(), cells, stopOnError: !!this.cfg.stop_on_error, allowStdin: true })
      if (r && r.ok === false) fail(r.message || 'The kernel did not accept the cell.')
    } catch (err) {
      fail(err && err.message ? err.message : String(err))
    }
  }

  runAll() {
    return this.runCells(this.cells.slice())
  }

  async interrupt() {
    if (!this.cells.some((c) => c.state !== 'idle')) return
    try {
      await this.ctx.rpc('interrupt', { key: this.key })
    } catch {
      /* the kernel is gone; its exit event tidies up */
    }
  }

  async restart({ ask = this.cfg.ask_restart, andRun = false } = {}) {
    if (ask && this.k.state !== 'none' && this.k.state !== 'dead') {
      const yes = await confirmDialog({ title: 'Restart the kernel?', body: 'Restarting loses every variable and stops what is running.', confirm: 'Restart', danger: true })
      if (!yes) return
    }
    for (const c of this.cells) {
      if (c.state !== 'idle') {
        c.state = 'idle'
        c.execId = null
        this.refreshCell(c)
      }
    }
    this.execs.clear()
    this.setBanner('kernel', null)
    this.k.state = 'starting'
    this.k.info = null
    this.setBar()
    let r
    try {
      r = await this.ctx.rpc('restart', this.startArgs())
    } catch (err) {
      r = { ok: false, code: 'KERNEL_START', message: err && err.message ? err.message : String(err) }
    }
    if (r.ok) {
      this.k.state = 'idle'
      this.k.info = r.info
      this.k.python = r.python
      this.setBar()
      this.ctx.toast && this.ctx.toast('ok', 'Kernel restarted')
      if (andRun) this.runAll()
    } else {
      this.k.state = r.code === 'NO_PYTHON' || r.code === 'BAD_PYTHON' ? 'nopython' : 'dead'
      this.setBanner('python', { kind: 'error', text: r.message, actions: [{ label: 'Try again', run: () => this.recheckPython() }] })
      this.setBar()
    }
  }

  clearOutputs(cells = this.cells) {
    for (const c of cells) {
      if (c.kind !== 'code' || c.state !== 'idle') continue
      c.raw.outputs = []
      c.raw.execution_count = null
      c.ms = null
      c.note = null
      this.refreshCell(c)
      this.renderOutputs(c)
    }
    this.markDirty()
  }

  // ------------------------------------------------------------------------------------------------- menus

  kernelMenu() {
    const running = this.cells.some((c) => c.state !== 'idle')
    const items = [
      { label: 'Interrupt', icon: 'stop', disabled: !running, onClick: () => this.interrupt() },
      { label: 'Restart…', icon: 'refresh', onClick: () => this.restart() },
      { label: 'Restart and run all', icon: 'refresh', onClick: async () => { await this.restart(); this.runAll() } },
      { label: 'Shut down', icon: 'close', disabled: this.k.state === 'none' || this.k.state === 'dead', onClick: async () => { await this.ctx.rpc('shutdown', { key: this.key }); this.k.state = 'none'; this.k.info = null; this.setBar() } },
      { sep: true },
    ]
    const list = this.pythons || []
    const current = this.k.python ? this.k.python.exe : this.pythonChoice || (list[0] && list[0].exe)
    if (!list.length) items.push({ label: 'No Python found', disabled: true })
    for (const p of list) items.push({ label: `${p.label}  ·  ${p.detail}`, check: p.exe === current, onClick: () => this.choosePython(p) })
    items.push({ sep: true }, { label: 'Look for Python again', icon: 'refresh', onClick: () => this.recheckPython() }, { label: 'Variables…', onClick: () => this.showVariables() })
    showMenu({ anchor: this.chip, items, align: 'end' })
  }

  async choosePython(p) {
    if (this.k.python && this.k.python.exe === p.exe && (this.k.state === 'idle' || this.k.state === 'busy')) return
    this.pythonChoice = p.exe
    if (this.path) localStorage.setItem('pager.nb.python:' + this.path, p.exe)
    if (this.k.state === 'none' || this.k.state === 'dead' || this.k.state === 'nopython') {
      this.k.python = null
      this.k.state = 'none'
      this.setBar()
      return
    }
    await this.restart({ ask: false })
  }

  moreMenu() {
    const cell = this.cur()
    showMenu({
      anchor: this.btnMore,
      align: 'end',
      items: [
        { label: 'Save', keys: 'Ctrl S', onClick: () => this.save() },
        { label: 'Save as…', onClick: () => this.save({ as: true }) },
        { label: 'Reload from disk', disabled: !this.path, onClick: () => this.reload() },
        { sep: true },
        { label: 'Run all cells', icon: 'play', onClick: () => this.runAll() },
        { label: 'Run cells above', onClick: () => this.runCells(this.cells.slice(0, this.sel)) },
        { label: 'Run selected cell and below', onClick: () => this.runCells(this.cells.slice(this.sel)) },
        { label: 'Clear outputs of this cell', disabled: !cell || cell.kind !== 'code', onClick: () => this.clearOutputs([cell]) },
        { label: 'Clear all outputs', onClick: () => this.clearOutputs() },
        { sep: true },
        { label: 'Line numbers', check: !!this.cfg.line_numbers, onClick: () => { this.cfg.line_numbers = !this.cfg.line_numbers; this.applyCfg() } },
        { label: 'Wrap long lines', check: !!this.cfg.wrap_code, onClick: () => { this.cfg.wrap_code = !this.cfg.wrap_code; this.applyCfg() } },
        { label: 'Collapse all sections', onClick: () => { for (const c of this.cells) if (c.kind === 'markdown' && this.headingLevel(c)) this.folded.add(c); this.applyFolds(); this.cells.forEach((c) => this.paintGutter(c)) } },
        { label: 'Expand all sections', onClick: () => { this.folded.clear(); this.applyFolds(); this.cells.forEach((c) => this.paintGutter(c)) } },
      ],
    })
  }

  async showVariables() {
    const ready = await this.ensureKernel()
    if (!ready.ok) return
    let r
    try {
      r = await this.ctx.rpc('variables', { key: this.key })
    } catch {
      return
    }
    this.root.querySelector('.nb-vars')?.remove()
    const rows = (r.vars || []).map((v) => h('tr', null, h('td', { class: 'n' }, v.name), h('td', { class: 't' }, v.type), h('td', { class: 's' }, v.size || ''), h('td', { class: 'r' }, v.repr)))
    const panel = h(
      'div',
      { class: 'nb-vars', role: 'dialog', attrs: { 'aria-label': 'Variables' } },
      h('div', { class: 'nb-vars-h' }, h('span', null, 'Variables'), h('button', { class: 'nb-tb', type: 'button', attrs: { 'aria-label': 'Close' }, onClick: () => panel.remove() }, ico('close'))),
      rows.length ? h('div', { class: 'nb-vars-b' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Type'), h('th', null, 'Size'), h('th', null, 'Value'))), h('tbody', null, rows))) : h('div', { class: 'nb-vars-e' }, 'No variables yet. Run a cell that defines some.'),
    )
    this.root.append(panel)
  }

  // ------------------------------------------------------------------------------------------------- banners

  setBanner(key, spec) {
    if (spec) this.banners.set(key, spec)
    else this.banners.delete(key)
    this.bannerEl.replaceChildren(
      ...Array.from(this.banners, ([k, b]) =>
        h(
          'div',
          { class: 'nb-banner ' + b.kind, role: 'alert' },
          h('span', { class: 'nb-banner-i' }, ico('warn')),
          h('span', { class: 'nb-banner-t' }, b.text),
          ...(b.actions || []).map((a) => h('button', { class: 'nb-addb', type: 'button', onClick: a.run }, a.label)),
          h('button', { class: 'nb-tb', type: 'button', attrs: { 'aria-label': 'Dismiss' }, onClick: () => this.setBanner(k, null) }, ico('close')),
        ),
      ),
    )
  }

  // ------------------------------------------------------------------------------------------------- files

  snapshot() {
    this.nb.cells = this.cells.map((c) => c.raw)
    const info = this.nb.metadata && this.nb.metadata.language_info
    if (info && info.name === 'python' && !info.version && this.k.info) info.version = this.k.info.python
    return this.nb
  }

  async save({ as = false, force = false, silent = false } = {}) {
    if (!this.nb) return false
    let file = this.path
    let create = false
    if (!file || as) {
      const name = await promptDialog({ title: as ? 'Save notebook as' : 'Save notebook', label: 'File name', value: this.path ? baseName(this.path) : this.name, confirm: 'Save' })
      if (!name) return false
      file = /\.ipynb$/i.test(name) ? name : name + '.ipynb'
      if (!/^[A-Za-z]:|^[\\/]/.test(file)) file = (this.path ? dirName(this.path) : this.ctx.cwd || '') + (this.ctx.cwd && this.ctx.cwd.includes('\\') ? '\\' : '/') + file
      create = file !== this.path
    }
    try {
      const r = await this.ctx.rpc('save', { path: file, nb: this.snapshot(), format: this.format, expectMtimeMs: create ? undefined : this.mtimeMs ?? undefined, create, force })
      if (!r.ok) {
        this.setBanner('file', {
          kind: 'warn',
          text: r.conflict === 'exists' ? `${baseName(file)} already exists.` : `${baseName(file)} changed on disk since it was opened.`,
          actions: [{ label: 'Overwrite', run: () => { this.setBanner('file', null); this.path = file; this.save({ force: true }) } }, ...(r.conflict === 'changed' ? [{ label: 'Reload', run: () => this.reload() }] : [])],
        })
        return false
      }
      this.setBanner('file', null)
      this.path = r.path
      this.name = r.name
      this.mtimeMs = r.mtimeMs
      this.dirty = false
      this.setBar()
      if (!silent) this.ctx.toast && this.ctx.toast('ok', `Saved ${r.name}`)
      return true
    } catch (err) {
      this.setBanner('file', { kind: 'error', text: `Could not save: ${err && err.message ? err.message : err}`, actions: [] })
      return false
    }
  }

  autosave() {
    const secs = Number(this.cfg.autosave_secs) || 0
    if (!secs || !this.dirty || !this.path || this.saving) return
    if (Date.now() - this.dirtySince < secs * 1000) return
    this.saving = true
    this.save({ silent: true }).finally(() => {
      this.saving = false
      if (this.dirty) this.dirtySince = Date.now()
    })
  }

  async reload() {
    if (!this.path) return
    if (this.dirty && !(await confirmDialog({ title: 'Discard your changes?', body: `Reload ${this.name} from disk and drop the unsaved edits.`, confirm: 'Reload', danger: true }))) return
    this.setBanner('file', null)
    const r = await this.ctx.rpc('open', { path: this.path })
    if (r.ok === false) return this.setBanner('file', { kind: 'error', text: r.error, actions: [] })
    this.load(r)
  }

  // ------------------------------------------------------------------------------------------------- lifecycle

  dispose() {
    this.disposed = true
    for (const t of this.timers) clearInterval(t)
    window.removeEventListener('pagehide', this.onHide)
    if (typeof this.off === 'function') this.off()
    this.closePopups()
    if (this.nb && this.dirty && this.path && Number(this.cfg.autosave_secs) > 0) {
      this.ctx.rpc('save', { path: this.path, nb: this.snapshot(), format: this.format, expectMtimeMs: this.mtimeMs ?? undefined }).catch(() => {})
    }
    this.ctx.rpc('shutdown', { key: this.key }).catch(() => {})
    this.root.remove()
  }

  focus() {
    const cell = this.cur()
    if (cell && cell.editing) cell.ta.focus()
    else this.root.focus({ preventScroll: true })
  }
}

export default {
  id: 'notebook',
  title: 'Notebook',
  icon: ICONS.notebook,
  mount(el, ctx) {
    const nb = new Notebook(el, ctx)
    return { dispose: () => nb.dispose(), focus: () => nb.focus(), resize() {} }
  },
}
