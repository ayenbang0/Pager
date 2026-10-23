// Files block: one file per pane. Header (history, breadcrumb, "N vs index" chip, status, Rendered|Source, "…" menu), a CodeMirror
// source view with a git change bar, a block-editing Rendered Markdown view, image / PDF / audio / video previews and a hex view.
// All disk access goes through ctx.rpc -> desktop/electron/blocks/files.cjs (path-validated, mtime-checked).
import { h } from '../ui/dom.js'
import * as U from './files-util.js'
import { createCodeEditor } from './files-code.js'
import { createMarkdownView } from './files-md.js'
import { createImageView, createAvView, createPdfView, createHexView } from './files-media.js'

const ico = (d, extra = '') => `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`
const I = {
  back: ico('<path d="M9.5 3.5 5 8l4.5 4.5"/>'),
  fwd: ico('<path d="M6.5 3.5 11 8l-4.5 4.5"/>'),
  eye: ico('<path d="M1.8 8S4 3.6 8 3.6 14.2 8 14.2 8 12 12.4 8 12.4 1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.9"/>'),
  code: ico('<path d="m5.8 4.6-3.4 3.4 3.4 3.4M10.2 4.6l3.4 3.4-3.4 3.4"/>'),
  more: ico('<circle cx="3.6" cy="8" r=".6" fill="currentColor"/><circle cx="8" cy="8" r=".6" fill="currentColor"/><circle cx="12.4" cy="8" r=".6" fill="currentColor"/>'),
  sub: ico('<path d="m6.5 3.5 4.5 4.5-4.5 4.5"/>'),
  check: ico('<path d="m3.6 8.4 2.9 2.9 5.9-6.2"/>'),
  file: ico('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>'),
  warn: ico('<path d="M8 2.6 14 13H2z"/><path d="M8 6.6v3M8 11.5v.1"/>'),
  hex: ico('<path d="M3 5h3M3 8h3M3 11h3M9 5h4M9 8h4M9 11h4"/>'),
}
const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
const WINDOWS = typeof navigator !== 'undefined' && /Win/.test(navigator.platform)
const kbd = (s) => (MAC ? s.replace('Ctrl+', '⌘').replace('Alt+', '⌥').replace('Shift+', '⇧').replace(/\+/g, '') : s)
const OPEN_MD_RENDERED = new Map() // path -> bool, remembered while the app runs
const JOURNAL = 'pager.files.journal.'
const MAX_JOURNAL = 2 * 1024 * 1024

let cssDone = false
function ensureCss() {
  if (cssDone || typeof document === 'undefined') return
  cssDone = true
  const href = new URL('./files.css', import.meta.url).href
  if (!Array.from(document.styleSheets).some((s) => s.href === href)) document.head.append(h('link', { rel: 'stylesheet', href }))
}

function luminance(color) {
  const m = /#([0-9a-f]{6})|rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(color || '')
  if (!m) return 0
  const [r, g, b] = m[1] ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [+m[2], +m[3], +m[4]]
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}
const isDark = () => luminance(getComputedStyle(document.documentElement).getPropertyValue('--tv-bg').trim() || getComputedStyle(document.body).backgroundColor) < 0.5

function readArgs(ctx) {
  let a = ctx.args
  if (!a && typeof ctx.command === 'string') { try { a = JSON.parse(ctx.command) } catch { a = null } }
  a = a && typeof a === 'object' ? { ...a } : {}
  if (typeof a.path === 'string' && !a.line) {
    const p = U.parsePathSpec(a.path)
    a.path = p.path
    a.line = p.line
    a.col = p.col
  }
  return a
}

async function readPrefs(ctx) {
  let s = null
  try {
    if (typeof ctx.settings === 'function') s = await ctx.settings()
    else if (ctx.settings && typeof ctx.settings === 'object') s = ctx.settings
    else if (window.pager && window.pager.d) s = await window.pager.d.call('settings.get')
  } catch { s = null }
  s = (s && (s.settings || s)) || {}
  const f = (s.files && typeof s.files === 'object' ? s.files : {})
  const pick = (k, d) => (f[k] !== undefined ? f[k] : s['files_' + k] !== undefined ? s['files_' + k] : d)
  return {
    markdownRendered: pick('markdown_rendered', true) !== false,
    wrapCode: !!pick('wrap_code', false),
    wrapProse: pick('wrap_prose', true) !== false,
    lineNumbers: pick('line_numbers', true) !== false,
    tabWidth: Math.min(16, Math.max(1, +pick('tab_width', 4) || 4)),
    autoSave: pick('auto_save', 'off'),
    fontSize: +s.font_size || 0,
  }
}

const block = {
  id: 'files',
  title: 'Files',
  icon: I.file,
  hotkey: 'Ctrl+O',
  mount(el, ctx) {
    ensureCss()
    return mountFiles(el, ctx)
  },
}
export default block

function mountFiles(host, ctx) {
  const args = readArgs(ctx)
  let prefs = { markdownRendered: true, wrapCode: false, wrapProse: true, lineNumbers: true, tabWidth: 4, autoSave: 'off', fontSize: 0 }
  const rpc = (m, a) => ctx.rpc(m, a)
  const wid = 'fb' + Math.random().toString(36).slice(2, 8)

  /** Everything about the open file. */
  const S = {
    path: '', root: ctx.cwd || '', repo: null, name: '', kind: 'empty', // empty | text | image | audio | video | pdf | binary | large | error
    mode: 'source', // text kind: rendered | source ; binary kind: hex
    text: '', saved: '', mtimeMs: 0, size: 0, eol: 'lf', encoding: 'utf8', bom: false, eolForced: false,
    ec: {}, dirty: false, marks: [], gutter: null, noRepo: false, wrap: null, asText: false, svg: false,
  }
  let view = null // the current viewer
  let viewKind = null // 'code' | 'md' | 'img' | 'av' | 'pdf' | 'hex'
  let mdOk = true
  let seq = 0
  let hist = []
  let hi = -1
  let cursor = { label: '', line: 1, col: 1 }
  let disposed = false
  const timers = { gutter: 0, journal: 0, auto: 0 }
  const popovers = []
  const cleanups = []

  // ---------------------------------------------------------------- DOM
  const btnBack = h('button', { class: 'fb-nav', title: kbd('Alt+Left'), 'aria-label': 'Back', html: I.back, onClick: () => go(-1) })
  const btnFwd = h('button', { class: 'fb-nav', title: kbd('Alt+Right'), 'aria-label': 'Forward', html: I.fwd, onClick: () => go(1) })
  const crumb = h('div', { class: 'fb-crumb' })
  const dot = h('span', { class: 'fb-dirty', title: 'Unsaved changes', hidden: true })
  const chip = h('button', { class: 'fb-chip', hidden: true, title: 'Changes against the index', onClick: () => openGit() })
  const status = h('div', { class: 'fb-status mono' })
  const segRendered = h('button', { class: 'fb-seg-b', title: 'Rendered (' + kbd('Ctrl+Shift+M') + ')', 'aria-label': 'Rendered', html: I.eye, onClick: () => setMode('rendered') })
  const segSource = h('button', { class: 'fb-seg-b', title: 'Source (' + kbd('Ctrl+Shift+M') + ')', 'aria-label': 'Source', html: I.code, onClick: () => setMode('source') })
  const seg = h('div', { class: 'fb-seg', hidden: true }, segRendered, segSource)
  const btnMore = h('button', { class: 'fb-more', title: 'More', 'aria-label': 'More', 'aria-haspopup': 'menu', html: I.more, onClick: () => toggleMenu() })
  const header = h('div', { class: 'fb-head' }, btnBack, btnFwd, crumb, dot, chip, h('div', { class: 'fb-sp' }), status, seg, btnMore)
  const banner = h('div', { class: 'fb-banner', hidden: true })
  const body = h('div', { class: 'fb-body' })
  const root = h('div', { class: 'fb', tabIndex: -1 }, header, banner, body)
  host.append(root)

  // ---------------------------------------------------------------- helpers
  const toast = (level, text) => (ctx.toast ? ctx.toast(level, text) : undefined)
  const currentText = () => {
    if (viewKind === 'code') return view.getText()
    if (viewKind === 'md') return view.getText()
    return S.text
  }
  const fail = (e) => toast('error', String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''))
  const bcRoot = () => S.repo || S.root

  function renderHeader() {
    btnBack.disabled = hi <= 0
    btnFwd.disabled = hi >= hist.length - 1
    crumb.textContent = ''
    if (S.path) {
      const segs = U.breadcrumb(S.path, bcRoot())
      segs.forEach((s, i) => {
        const last = i === segs.length - 1
        if (i) crumb.append(h('span', { class: 'fb-sepc', html: I.sub }))
        crumb.append(h(last ? 'span' : 'button', {
          class: 'fb-seg-c' + (last ? ' file' + (S.kind === 'text' && !U.hasRendered(S.path) ? ' code' : '') : ''), title: s.path, tabIndex: last ? undefined : -1,
          onClick: last ? undefined : () => ctx.openPath && ctx.openPath(s.path),
        }, s.name))
      })
    } else crumb.append(h('span', { class: 'fb-seg-c file' }, 'No file'))
    dot.hidden = !S.dirty
    ctx.setTitle && ctx.setTitle((S.name || 'Files') + (S.dirty ? ' •' : ''))
    seg.hidden = !((S.kind === 'text' && U.hasRendered(S.path)) || (S.kind === 'image' && S.svg))
    const rendered = S.kind === 'image' || (S.kind === 'text' && S.mode === 'rendered')
    segRendered.classList.toggle('on', rendered)
    segSource.classList.toggle('on', !rendered)
    renderChip()
    renderStatus()
  }

  function renderChip() {
    const g = S.gutter
    const show = !!(g && g.repo && g.count > 0 && S.kind === 'text')
    chip.hidden = !show
    if (show) {
      chip.textContent = ''
      chip.append(h('span', { class: 'n' }, String(g.count)), h('span', { class: 'l' }, 'vs index'))
      chip.title = g.tracked ? `${g.count} changed ${g.count === 1 ? 'region' : 'regions'} against the index` : 'New file: not in the index yet'
    }
  }

  function renderStatus() {
    status.textContent = ''
    if (S.kind === 'text') {
      const parts = []
      if (cursor.label) parts.push(cursor.label)
      parts.push(`Ln ${cursor.line}, Col ${cursor.col}`)
      status.append(h('span', null, parts.join(' · ')))
      const extra = []
      if (S.encoding !== 'utf8' || S.bom) extra.push(U.encodingLabel(S.encoding, S.bom))
      if (S.eol === 'crlf') extra.push('CRLF')
      if (extra.length) status.append(h('span', { class: 'x' }, extra.join(' · ')))
    } else if (S.kind === 'binary' || S.mode === 'hex') {
      status.append(h('span', null, `${U.humanSize(S.size)}${cursor.hexOffset !== undefined ? ' · 0x' + cursor.hexOffset.toString(16) : ''}`))
    } else if (S.kind === 'empty' || S.kind === 'error') {
      // nothing
    } else status.append(h('span', null, U.humanSize(S.size)))
  }

  function setDirty(d) {
    if (S.dirty === d) return
    S.dirty = d
    dot.hidden = !d
    ctx.setTitle && ctx.setTitle((S.name || 'Files') + (d ? ' •' : ''))
    if (!d) { clearTimeout(timers.journal); try { localStorage.removeItem(JOURNAL + S.path) } catch { /* private mode */ } }
  }

  function noteChange() {
    if (S.kind !== 'text') return
    let d = S.eolForced
    if (!d) d = viewKind === 'code' ? view.isDirty() : currentText() !== S.saved
    setDirty(d)
    scheduleGutter()
    scheduleJournal()
    scheduleAutoSave()
  }

  // ---------------------------------------------------------------- git gutter
  function scheduleGutter(delay = 380) {
    clearTimeout(timers.gutter)
    if (S.kind !== 'text' || S.noRepo) return
    timers.gutter = setTimeout(refreshGutter, delay)
  }
  async function refreshGutter() {
    if (S.kind !== 'text' || disposed) return
    const my = seq
    const text = currentText()
    if (text.length > 4 * 1024 * 1024) return
    try {
      const g = await rpc('gutter', { path: S.path, root: S.root, text })
      if (my !== seq || disposed) return
      if (!g.repo) { S.noRepo = true; S.gutter = null; applyMarks([]); renderChip(); return }
      S.gutter = g
      applyMarks(g.marks || [])
      renderChip()
    } catch { /* not a repo / git missing: no change bar */ }
  }
  function applyMarks(m) {
    S.marks = m
    if (viewKind === 'code') view.setMarks(m)
    else if (viewKind === 'md') view.setMarks(m)
  }

  // ---------------------------------------------------------------- hot-exit journal
  function scheduleJournal() {
    clearTimeout(timers.journal)
    if (!S.dirty) return
    timers.journal = setTimeout(writeJournal, 900)
  }
  function writeJournal() {
    if (!S.dirty || S.kind !== 'text' || !S.path) return
    try {
      const text = currentText()
      if (text.length > MAX_JOURNAL) return
      localStorage.setItem(JOURNAL + S.path, JSON.stringify({ text, mtimeMs: S.mtimeMs, t: Date.now() }))
    } catch { /* quota */ }
  }

  // ---------------------------------------------------------------- auto save
  function scheduleAutoSave() {
    clearTimeout(timers.auto)
    const a = prefs.autoSave
    const ms = a && typeof a === 'object' ? +(a.after_delay ?? a.afterDelay) : 0
    if (ms > 0 && S.dirty) timers.auto = setTimeout(() => { if (S.dirty) save({ silent: true }) }, ms)
  }
  const onFocusOut = (ev) => {
    if (prefs.autoSave === 'on_focus_change' && S.dirty && !root.contains(ev.relatedTarget)) save({ silent: true })
  }

  // ---------------------------------------------------------------- views
  function clearView() {
    if (view) { try { view.destroy() } catch { /* already gone */ } }
    view = null
    viewKind = null
    body.textContent = ''
  }

  function empty(icon, title, sub, actions = []) {
    clearView()
    body.append(h('div', { class: 'fb-empty' },
      h('div', { class: 'fb-empty-i', html: icon }),
      h('div', { class: 'fb-empty-t' }, title),
      sub ? h('div', { class: 'fb-empty-s' }, sub) : null,
      actions.length ? h('div', { class: 'fb-empty-a' }, actions.map((a) => h('button', { class: 'fb-btn' + (a.primary ? ' primary' : ''), onClick: a.run }, a.label))) : null))
  }

  const wrapOn = () => (S.wrap !== null ? S.wrap : (U.isMarkdownPath(S.path) ? prefs.wrapProse : prefs.wrapCode))

  async function buildCode(text) {
    clearView()
    const host2 = h('div', { class: 'fb-code' })
    body.append(host2)
    const big = S.size > 8 * 1024 * 1024
    const indent = S.ec.indentStyle === 'tab' ? '\t' : S.ec.indentStyle === 'space' || S.ec.indentSize ? ' '.repeat(S.ec.indentSize || prefs.tabWidth) : null
    const det = indent ? null : U.detectIndent(S.saved)
    const unit = indent || (det ? (det.tab ? '\t' : ' '.repeat(det.size)) : ' '.repeat(prefs.tabWidth))
    const tab = S.ec.tabWidth || (det && det.tab ? 4 : unit === '\t' ? 4 : unit.length) || prefs.tabWidth
    const my = seq
    const ed = await createCodeEditor(host2, {
      text: S.saved, lang: U.langForPath(S.path), wrap: big ? false : wrapOn(), lineNumbers: prefs.lineNumbers, tabSize: tab, indent: unit, plain: big,
      onChange: () => noteChange(),
      onCursor: (c) => { cursor = { label: '', line: c.line, col: c.col }; renderStatus() },
    })
    if (my !== seq || disposed) { ed.destroy(); return false }
    view = ed
    viewKind = 'code'
    if (text !== S.saved) ed.setText(text)
    ed.setMarks(S.marks)
    return true
  }

  async function buildMarkdown(text) {
    clearView()
    const md = createMarkdownView(body, {
      resolveMedia: async (rel) => {
        try {
          const abs = U.resolveLink(S.path, rel)
          return (await rpc('media', { path: abs, root: S.root })).url
        } catch { return null }
      },
      onChange: () => noteChange(),
      onCursor: (c) => { cursor = c; renderStatus() },
      onLink: (href) => openLink(href),
      isDark,
    })
    const my = seq
    const ok = await md.setText(text)
    if (my !== seq || disposed) { md.destroy(); return false }
    if (!ok) { md.destroy(); mdOk = false; return null }
    view = md
    viewKind = 'md'
    md.setMarks(S.marks)
    return true
  }

  async function showText(res, opts = {}) {
    S.kind = 'text'
    S.text = res.content
    S.saved = res.content
    S.eol = res.eol
    S.encoding = res.encoding
    S.bom = !!res.bom
    S.eolForced = false
    if (res.content === '' && S.ec.eol) S.eol = S.ec.eol
    mdOk = true
    let want = U.isMarkdownPath(S.path)
    let mode = 'source'
    if (want) {
      mode = opts.mode || (OPEN_MD_RENDERED.has(S.path) ? (OPEN_MD_RENDERED.get(S.path) ? 'rendered' : 'source') : (prefs.markdownRendered ? 'rendered' : 'source'))
    }
    S.mode = mode
    let text = res.content
    if (opts.restore != null) text = opts.restore
    if (mode === 'rendered') {
      const ok = await buildMarkdown(text)
      if (ok === false) return
      if (ok === null) {
        S.mode = 'source'
        showBanner({ text: 'This Markdown cannot be edited as blocks without changing it, so the source is shown.', actions: [{ label: 'Dismiss', run: hideBanner }] })
        await buildCode(text)
      }
    } else if ((await buildCode(text)) === false) return
    cursor = { label: '', line: 1, col: 1 }
    noteChange()
    if (S.eolForced) setDirty(true)
    if (opts.line) {
      if (viewKind === 'code') view.goto(opts.line, opts.col || 1)
      else view.scrollToLine(opts.line)
    }
    renderHeader()
    if (opts.focus !== false) focus(opts.line)
  }

  function showMedia(res) {
    clearView()
    S.kind = res.kind
    S.mode = 'source'
    if (res.kind === 'image') {
      view = createImageView(body, { url: res.url, name: res.name, size: res.size })
      viewKind = 'img'
    } else if (res.kind === 'pdf') {
      view = createPdfView(body, { rpc, path: res.path, root: S.root })
      viewKind = 'pdf'
    } else {
      view = createAvView(body, { kind: res.kind, url: res.url, name: res.name, size: res.size })
      viewKind = 'av'
    }
  }

  function showHex(res) {
    clearView()
    S.kind = 'binary'
    S.mode = 'hex'
    view = createHexView(body, { rpc, path: res.path, root: S.root, size: res.size, onCursor: (off) => { cursor.hexOffset = off; renderStatus() } })
    viewKind = 'hex'
  }

  // ---------------------------------------------------------------- opening
  async function open(spec, o = {}) {
    const my = ++seq
    const s = typeof spec === 'string' ? { path: spec } : spec
    if (!s || !s.path) return
    if (S.dirty && !o.force) {
      const choice = await confirmLeave()
      if (choice === 'cancel') { seq--; return }
    }
    hideBanner()
    timersClear()
    let abs = s.path
    try {
      let g
      try {
        g = await rpc('grant', { path: abs })
      } catch (e) {
        if (!(args.create || s.create)) throw e
        await rpc('grant', { path: U.dirOf(abs) || '.' })
        await rpc('create', { path: abs, root: U.dirOf(abs) })
        g = await rpc('grant', { path: abs })
      }
      if (my !== seq) return
      abs = g.path
      let root = ctx.cwd && U.relPath(abs, ctx.cwd) !== abs.replace(/\\/g, '/') ? ctx.cwd : g.root
      if (ctx.cwd && root === ctx.cwd) { try { await rpc('grant', { path: ctx.cwd }) } catch { /* cwd gone */ } }
      S.root = root
      S.path = abs
      S.name = U.baseOf(abs)
      S.svg = U.extOf(abs) === 'svg'
      S.marks = []
      S.gutter = null
      S.noRepo = false
      S.ec = {}
      const read = await rpc('read', { path: abs, root, encoding: o.encoding, as: o.as })
      if (my !== seq) return
      try { S.repo = (await rpc('info', { path: abs, root })).repo || null } catch { S.repo = null }
      S.size = read.size || 0
      S.mtimeMs = read.mtimeMs || 0
      watch(abs)
      if (read.kind === 'text') {
        try { S.ec = await rpc('editorconfig', { path: abs, root }) } catch { S.ec = {} }
        if (my !== seq) return
        S.dirty = false
        let restore = null
        try {
          const j = JSON.parse(localStorage.getItem(JOURNAL + abs) || 'null')
          if (j && j.mtimeMs === S.mtimeMs && typeof j.text === 'string' && j.text !== read.content && !o.encoding) restore = j.text
        } catch { /* corrupt journal */ }
        S.lossy = !!read.lossy
        await showText(read, { line: s.line, col: s.col, mode: o.mode, restore })
        if (read.sniffed) showBanner({ text: 'This file is not valid UTF-8, so it was opened as Windows-1252. Saving keeps that encoding.', actions: [{ label: 'Dismiss', run: hideBanner }] })
        if (restore !== null) {
          S.dirty = false
          noteChange()
          showBanner({
            text: 'Unsaved changes from your last session were restored.',
            actions: [{ label: 'Discard them', run: () => { replaceText(S.saved); S.eolForced = false; setDirty(false); hideBanner() } }, { label: 'Keep', primary: true, run: hideBanner }],
          })
        }
      } else if (read.kind === 'binary') {
        showHex(read)
      } else if (read.kind === 'large') {
        S.kind = 'large'
        empty(I.warn, 'This file is too large to edit', `${U.humanSize(read.size)}. Open it as text anyway, browse the bytes, or use another app.`, [
          ...(read.size <= 64 * 1024 * 1024 ? [{ label: 'Open as Text', run: () => open({ path: abs }, { as: 'text', force: true }) }] : []),
          { label: 'View as Hex', primary: true, run: () => open({ path: abs }, { as: 'hex', force: true }) },
          { label: 'Open in Default App', run: () => rpc('openDefault', { path: abs, root }).catch(fail) },
        ])
      } else if (read.kind === 'dir') {
        S.kind = 'error'
        empty(I.file, 'This is a folder', abs, [{ label: 'Show in Explorer', run: () => rpc('reveal', { path: abs, root }).catch(fail) }])
      } else {
        showMedia(read)
      }
      if (o.push !== false) pushHistory({ path: abs, line: s.line, col: s.col })
      renderHeader()
    } catch (e) {
      if (my !== seq) return
      S.path = abs
      S.name = U.baseOf(abs)
      S.kind = 'error'
      S.dirty = false
      const msg = String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
      const missing = /ENOENT/.test(msg)
      empty(I.warn, missing ? 'This file does not exist' : 'This file cannot be opened', missing ? abs : msg, [
        ...(missing ? [{ label: 'Create File', primary: true, run: () => open({ path: abs, create: true }, { force: true }) }] : []),
      ])
      if (o.push !== false && abs) pushHistory({ path: abs })
      renderHeader()
    }
  }

  function pushHistory(entry) {
    if (hist[hi] && hist[hi].path === entry.path) { hist[hi] = entry; return }
    hist = hist.slice(0, hi + 1)
    hist.push(entry)
    if (hist.length > 100) hist.shift()
    hi = hist.length - 1
  }
  async function go(d) {
    const k = hi + d
    if (k < 0 || k >= hist.length) return
    const prev = hi
    hi = k
    renderHeader()
    await open(hist[k], { push: false })
    if (seq && S.dirty && hist[k].path !== S.path) { hi = prev; renderHeader() } // the leave prompt was cancelled
  }

  function timersClear() {
    for (const k of Object.keys(timers)) { clearTimeout(timers[k]); timers[k] = 0 }
  }

  async function confirmLeave() {
    if (prefs.autoSave && prefs.autoSave !== 'off') { await save({ silent: true }); if (!S.dirty) return 'save' }
    const c = await dialog({
      title: 'Save changes?', text: `${S.name} has unsaved changes.`,
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'discard', label: "Don't Save", danger: true }, { id: 'save', label: 'Save', primary: true }],
    })
    if (c === 'save') { await save(); return S.dirty ? 'cancel' : 'save' }
    if (c === 'discard') { setDirty(false); S.eolForced = false }
    return c
  }

  function openLink(href) {
    if (U.isExternalUrl(href)) {
      if (ctx.openUrl) ctx.openUrl(href)
      else if (ctx.openBlock) ctx.openBlock('browser', { url: href })
      return
    }
    const hash = href.includes('#') ? href.slice(href.indexOf('#')) : ''
    const abs = U.resolveLink(S.path, href)
    if (!abs) return
    if (abs.toLowerCase() === S.path.replace(/\\/g, '/').toLowerCase()) return
    open({ path: abs }).then(() => { if (hash && view && view.el) { const t = view.el.querySelector('[id="' + CSS.escape(decodeURIComponent(hash.slice(1))) + '"]'); if (t) t.scrollIntoView() } })
  }

  function openGit() {
    if (ctx.openBlock) ctx.openBlock('git', { path: S.path, root: S.repo || S.root })
  }

  // ---------------------------------------------------------------- mode, text, focus
  async function setMode(m) {
    if (S.svg && (S.kind === 'image' || S.kind === 'text')) {
      await open({ path: S.path }, { as: m === 'source' ? 'text' : undefined, force: true, push: false })
      return
    }
    if (S.kind !== 'text' || !U.hasRendered(S.path) || S.mode === m) return
    const text = currentText()
    const line = cursor.line
    S.mode = m
    OPEN_MD_RENDERED.set(S.path, m === 'rendered')
    const my = ++seq
    let ok
    if (m === 'rendered') {
      ok = await buildMarkdown(text)
      if (ok === null) {
        showBanner({ text: 'This Markdown cannot be shown as blocks without changing it, so the source stays.', actions: [{ label: 'Dismiss', run: hideBanner }] })
        S.mode = 'source'
        await buildCode(text)
      }
    } else ok = await buildCode(text)
    if (my !== seq) return
    if (viewKind === 'code') view.goto(line, 1)
    else view.scrollToLine && view.scrollToLine(line)
    noteChange()
    renderHeader()
    view.focus && view.focus(line)
  }

  function replaceText(text) {
    if (viewKind === 'code') view.setText(text)
    else if (viewKind === 'md') view.setText(text)
    S.text = text
  }

  function focus(line) {
    if (!view) { root.focus(); return }
    if (viewKind === 'md') view.focus(line || 0)
    else if (view.focus) view.focus()
  }

  // ---------------------------------------------------------------- save
  const CP1252_OK = /^[\u0000-\u00ff\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178]*$/

  function normalise(text) {
    let t = text
    if (S.ec.trimTrailing && !U.isMarkdownPath(S.path)) t = t.replace(/[ \t]+$/gm, '')
    else if (S.ec.trimTrailing) t = t.replace(/[ \t]+$/gm, (m, off, all) => (m.length === 2 && all[off + 2] === '\n' && m === '  ' ? m : ''))
    if (S.ec.finalNewline && t !== '' && !t.endsWith('\n')) t += '\n'
    return t
  }

  let saving = false
  async function save(o = {}) {
    if (S.kind !== 'text' || saving) return
    saving = true
    try {
      if (viewKind === 'md' && view.commit) view.commit()
      let text = normalise(currentText())
      if (text !== currentText()) replaceText(text)
      if (S.lossy && S.encoding === 'utf8' && text.includes('\ufffd')) {
        const c = await dialog({
          title: 'This file is not valid UTF-8', text: 'It was read as UTF-8, so some bytes became "\ufffd". Saving writes those replacement characters over the original bytes.',
          buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'go', label: 'Save Anyway', danger: true, primary: true }],
        })
        if (c === 'cancel') return
        S.lossy = false
      }
      if (S.encoding === 'latin1' && !CP1252_OK.test(text)) {
        const c = await dialog({
          title: "Some characters can't be saved", text: 'This file is Windows-1252, which has no room for some characters you typed; they would be replaced by "?".',
          buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'utf8', label: 'Save as UTF-8', primary: true }, { id: 'go', label: 'Save Anyway', danger: true }],
        })
        if (c === 'cancel') return
        if (c === 'utf8') { S.encoding = 'utf8'; S.bom = false }
      }
      let target = S.path
      let expect = S.mtimeMs
      if (o.as) {
        const r = await rpc('pickSave', { defaultPath: S.path, root: S.root })
        if (!r.path) return
        target = r.path
        expect = undefined
      }
      const w = await rpc('write', { path: target, root: S.root, content: text, eol: S.eol, encoding: S.encoding, bom: S.bom, expectMtimeMs: expect, force: !!o.force })
      if (w.conflict) {
        showConflict(w.deleted ? 'deleted' : 'save')
        return
      }
      S.mtimeMs = w.mtimeMs
      S.size = w.size
      S.saved = text
      S.text = text
      S.eolForced = false
      if (viewKind === 'code') view.markSaved()
      hideBanner()
      if (o.as && target !== S.path) {
        S.path = target
        S.name = U.baseOf(target)
        try { S.repo = (await rpc('info', { path: target, root: S.root })).repo || null } catch { S.repo = null }
        watch(target)
        pushHistory({ path: target })
        S.noRepo = false
      }
      setDirty(false)
      renderHeader()
      scheduleGutter(60)
      if (!o.silent && o.as) toast('info', 'Saved as ' + S.name)
    } catch (e) {
      fail(e)
    } finally {
      saving = false
    }
  }

  async function revert() {
    if (!S.dirty) return
    const c = await dialog({ title: 'Revert to saved?', text: 'Your unsaved changes will be lost.', buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'revert', label: 'Revert', danger: true, primary: true }] })
    if (c !== 'revert') return
    replaceText(S.saved)
    S.eolForced = false
    if (viewKind === 'code') view.markSaved()
    setDirty(false)
    renderHeader()
  }

  async function reopenWith(encoding) {
    if (S.kind !== 'text' && S.kind !== 'binary') return
    if (S.dirty) {
      const c = await dialog({ title: 'Discard changes?', text: `Reopening ${S.name} as ${U.encodingLabel(encoding)} drops your unsaved changes.`, buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Reopen', danger: true, primary: true }] })
      if (c !== 'ok') return
    }
    await open({ path: S.path }, { encoding, as: 'text', force: true, push: false })
  }

  function setEol(eol) {
    if (S.kind !== 'text' || S.eol === eol) return
    S.eol = eol
    S.eolForced = true
    setDirty(true)
    renderHeader()
    scheduleAutoSave()
  }

  function toggleWrap() {
    if (S.kind !== 'text') return
    const on = !wrapOn()
    S.wrap = on
    if (viewKind === 'code') view.setWrap(on)
    renderHeader()
  }

  // ---------------------------------------------------------------- disk changes
  function watch(path) {
    rpc('watch', { path, root: S.root, id: wid }).catch(() => {})
  }
  const unsub = ctx.onEvent ? ctx.onEvent((a, b) => {
    const ev = typeof a === 'string' ? a : (a && (a.event || a.type))
    const p = typeof a === 'string' ? b : (a && (a.payload || a))
    if ((ev === 'changed' || ev === undefined) && p && p.id === wid) checkDisk()
  }) : null

  let checking = false
  async function checkDisk() {
    if (checking || S.kind === 'empty' || S.kind === 'error' || !S.path || disposed) return
    checking = true
    try {
      let info = null
      try { info = await rpc('info', { path: S.path, root: S.root }) } catch { info = null }
      if (disposed) return
      if (!info) {
        if (S.kind === 'text' && !S.deleted) { S.deleted = true; showConflict('deleted') }
        return
      }
      S.deleted = false
      if (Math.abs(info.mtimeMs - S.mtimeMs) <= 0.5) return
      if (S.kind === 'text') {
        if (!S.dirty) await reloadFromDisk(true)
        else showConflict('changed')
      } else await open({ path: S.path }, { force: true, push: false })
    } finally { checking = false }
  }

  async function reloadFromDisk(quiet) {
    const my = seq
    try {
      const r = await rpc('read', { path: S.path, root: S.root, encoding: S.encoding === 'utf8' ? undefined : S.encoding, as: 'text' })
      if (my !== seq || r.kind !== 'text') return
      S.mtimeMs = r.mtimeMs
      S.size = r.size
      S.saved = r.content
      S.eol = r.eol
      S.eolForced = false
      replaceText(r.content)
      if (viewKind === 'code') view.markSaved()
      setDirty(false)
      hideBanner()
      renderHeader()
      scheduleGutter(60)
      if (!quiet) toast('info', 'Reloaded ' + S.name)
    } catch (e) { fail(e) }
  }

  function showConflict(kind) {
    const msg = {
      save: 'This file changed on disk after you opened it. Saving now would overwrite those changes.',
      changed: 'This file changed on disk while you have unsaved edits.',
      deleted: 'This file was deleted or moved on disk.',
    }[kind]
    const actions = []
    if (kind !== 'deleted') actions.push({ label: 'Reload from Disk', run: () => reloadFromDisk(false) })
    actions.push({ label: kind === 'deleted' ? 'Save Again' : 'Overwrite', primary: true, run: () => { hideBanner(); S.deleted = false; save({ force: true }) } })
    actions.push({ label: 'Keep Editing', run: () => { hideBanner(); if (kind === 'changed') S.mtimeMs = -1 } })
    showBanner({ text: msg, warn: true, actions })
  }

  function showBanner({ text, actions = [], warn = false }) {
    banner.textContent = ''
    banner.className = 'fb-banner' + (warn ? ' warn' : '')
    banner.append(h('span', { class: 'fb-banner-i', html: warn ? I.warn : I.file }), h('span', { class: 'fb-banner-t' }, text),
      h('span', { class: 'fb-banner-a' }, actions.map((a) => h('button', { class: 'fb-btn sm' + (a.primary ? ' primary' : ''), onClick: a.run }, a.label))))
    banner.hidden = false
  }
  function hideBanner() { banner.hidden = true; banner.textContent = '' }

  const onWinFocus = () => { checkDisk() }
  window.addEventListener('focus', onWinFocus)
  cleanups.push(() => window.removeEventListener('focus', onWinFocus))
  const onWinBlur = () => { if (prefs.autoSave === 'on_focus_change' && S.dirty) save({ silent: true }) }
  window.addEventListener('blur', onWinBlur)
  cleanups.push(() => window.removeEventListener('blur', onWinBlur))
  root.addEventListener('focusout', onFocusOut)

  // ---------------------------------------------------------------- dialog
  function dialog({ title, text, buttons }) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement
      const done = (id) => { layer.remove(); document.removeEventListener('keydown', onKey, true); if (prevFocus && prevFocus.focus) prevFocus.focus(); resolve(id) }
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('cancel') }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done((buttons.find((b) => b.primary) || buttons[buttons.length - 1]).id) }
      }
      const layer = h('div', { class: 'fb-dlg-layer', onMousedown: (e) => { if (e.target === layer) done('cancel') } },
        h('div', { class: 'fb-dlg', role: 'dialog', 'aria-label': title },
          h('div', { class: 'fb-dlg-t' }, title), h('div', { class: 'fb-dlg-s' }, text),
          h('div', { class: 'fb-dlg-a' }, buttons.map((b) => h('button', { class: 'fb-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), onClick: () => done(b.id) }, b.label)))))
      root.append(layer)
      document.addEventListener('keydown', onKey, true)
      const pb = layer.querySelector('.primary') || layer.querySelector('button:last-child')
      if (pb) pb.focus()
    })
  }

  // ---------------------------------------------------------------- "…" menu
  const closePopovers = () => {
    while (popovers.length) popovers.pop().remove()
    btnMore.classList.remove('on')
    document.removeEventListener('mousedown', onDocDown, true)
  }
  const onDocDown = (e) => { if (!popovers.some((p) => p.contains(e.target)) && !btnMore.contains(e.target)) closePopovers() }

  function menuItems() {
    const text = S.kind === 'text'
    const items = []
    if (text && U.hasRendered(S.path)) {
      items.push({ label: 'Rendered', radio: true, on: S.mode === 'rendered', run: () => setMode('rendered') })
      items.push({ label: 'Source', radio: true, on: S.mode === 'source', run: () => setMode('source') })
      items.push('-')
    } else if (S.kind === 'image' && S.svg) {
      items.push({ label: 'Rendered', radio: true, on: true, run: () => setMode('rendered') }, { label: 'Source', radio: true, on: false, run: () => setMode('source') }, '-')
    }
    items.push({ label: 'Save', kbd: 'Ctrl+S', disabled: !text, run: () => save() })
    items.push({ label: 'Save As…', kbd: 'Ctrl+Alt+Shift+S', disabled: !text, run: () => save({ as: true }) })
    items.push({ label: 'Revert to Saved', disabled: !text || !S.dirty, run: revert })
    items.push('-')
    items.push({ label: 'Reopen with Encoding', sub: U.ENCODINGS.map((e) => ({ label: e.label, radio: true, on: e.id === S.encoding && !(e.id === 'utf8' && S.bom && false), run: () => reopenWith(e.id) })), disabled: !(text || S.kind === 'binary') })
    items.push({ label: 'Line Endings', sub: [{ label: 'LF', radio: true, on: S.eol === 'lf', run: () => setEol('lf') }, { label: 'CRLF', radio: true, on: S.eol === 'crlf', run: () => setEol('crlf') }], disabled: !text })
    items.push({ label: 'Wrap Lines', kbd: 'Alt+Z', check: true, on: wrapOn(), disabled: !text, run: toggleWrap })
    items.push(S.kind === 'binary'
      ? { label: 'View as Text', run: () => open({ path: S.path }, { as: 'text', force: true, push: false }) }
      : { label: 'View as Hex', disabled: !S.path || S.kind === 'error' || S.kind === 'empty', run: () => open({ path: S.path }, { as: 'hex', force: true, push: false }) })
    items.push('-')
    items.push({ label: MAC ? 'Reveal in Finder' : WINDOWS ? 'Show in Explorer' : 'Show in File Manager', disabled: !S.path, run: () => rpc('reveal', { path: S.path, root: S.root }).catch(fail) })
    items.push({ label: 'Open in Default App', disabled: !S.path, run: () => rpc('openDefault', { path: S.path, root: S.root }).catch(fail) })
    items.push({ label: 'Copy Path', disabled: !S.path, run: () => copy(S.path) })
    items.push({ label: 'Copy Relative Path', disabled: !S.path, run: () => copy(U.relPath(S.path, bcRoot())) })
    return items
  }

  function copy(t) {
    navigator.clipboard.writeText(t).then(() => toast('info', 'Copied'), () => toast('error', 'Could not copy'))
  }

  function buildPop(items, anchor, { side = 'below', depth = 0 } = {}) {
    const pop = h('div', { class: 'fb-pop', role: 'menu' })
    let activeIdx = -1
    const rows = []
    const sub = { el: null, owner: null }
    const closeSub = () => { if (sub.el) { const i = popovers.indexOf(sub.el); if (i >= 0) popovers.splice(i, 1); sub.el.remove(); sub.el = null; sub.owner = null } }
    items.forEach((it) => {
      if (it === '-') { pop.append(h('div', { class: 'fb-pop-sep' })); return }
      const row = h('button', { class: 'fb-pop-i' + (it.disabled ? ' off' : ''), role: it.radio ? 'menuitemradio' : it.check ? 'menuitemcheckbox' : 'menuitem', tabIndex: -1, 'aria-checked': it.on ? 'true' : undefined },
        h('span', { class: 'fb-pop-k' }, it.radio ? (it.on ? h('i', { class: 'dotr' }) : null) : it.check && it.on ? h('span', { html: I.check }) : null),
        h('span', { class: 'fb-pop-l' }, it.label),
        it.kbd ? h('span', { class: 'fb-pop-kbd' }, kbd(it.kbd)) : null,
        it.sub ? h('span', { class: 'fb-pop-a', html: I.sub }) : null)
      row.dataset.idx = rows.length
      rows.push({ row, it })
      const openSub = () => {
        if (it.disabled || !it.sub) { closeSub(); return }
        if (sub.owner === row) return
        closeSub()
        const p = buildPop(it.sub, row, { side: 'right', depth: depth + 1 })
        sub.el = p
        sub.owner = row
      }
      row.addEventListener('mouseenter', () => { setActive(+row.dataset.idx); openSub() })
      row.addEventListener('click', () => {
        if (it.disabled) return
        if (it.sub) { openSub(); return }
        closePopovers()
        it.run && it.run()
        // the menu held focus: hand it back so Ctrl+S & co. keep working
        setTimeout(() => { if (!disposed && !root.contains(document.activeElement)) { if (viewKind === 'code') view.focus(); else root.focus({ preventScroll: true }) } }, 0)
      })
      pop.append(row)
    })
    const setActive = (i) => {
      activeIdx = i
      rows.forEach((r, k) => r.row.classList.toggle('act', k === i))
    }
    pop.addEventListener('keydown', (e) => {
      const step = (d) => {
        for (let n = 1; n <= rows.length; n++) {
          const k = (activeIdx + d * n + rows.length * 4) % rows.length
          if (!rows[k].it.disabled) { setActive(k); rows[k].row.scrollIntoView({ block: 'nearest' }); return }
        }
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
      else if (e.key === 'ArrowRight' && rows[activeIdx] && rows[activeIdx].it.sub) { e.preventDefault(); rows[activeIdx].row.click(); const f = sub.el && sub.el.querySelector('.fb-pop-i'); if (f) { sub.el.focus() } }
      else if (e.key === 'ArrowLeft' && depth > 0) { e.preventDefault(); closeSubSelf() }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (rows[activeIdx]) rows[activeIdx].row.click() }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (depth > 0) closeSubSelf(); else { closePopovers(); btnMore.focus() } }
    })
    const closeSubSelf = () => { const i = popovers.indexOf(pop); if (i >= 0) popovers.splice(i, 1); pop.remove(); if (popovers[0]) popovers[0].focus() }
    pop.tabIndex = -1
    document.body.append(pop)
    popovers.push(pop)
    // position
    const r = anchor.getBoundingClientRect()
    const pw = pop.offsetWidth
    const ph = pop.offsetHeight
    let x
    let y
    if (side === 'below') { x = r.right - pw; y = r.bottom + 6 } else { x = r.right + 2; y = r.top - 6; if (x + pw > innerWidth - 6) x = r.left - pw - 2 }
    x = Math.max(6, Math.min(x, innerWidth - pw - 6))
    y = Math.max(6, Math.min(y, innerHeight - ph - 6))
    pop.style.left = x + 'px'
    pop.style.top = y + 'px'
    pop.focus()
    return pop
  }

  function toggleMenu() {
    if (popovers.length) { closePopovers(); return }
    btnMore.classList.add('on')
    buildPop(menuItems(), btnMore)
    document.addEventListener('mousedown', onDocDown, true)
  }

  // ---------------------------------------------------------------- keys
  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && !e.altKey && !e.shiftKey && k === 's') { e.preventDefault(); e.stopPropagation(); save() }
    else if (mod && e.altKey && e.shiftKey && k === 's') { e.preventDefault(); e.stopPropagation(); save({ as: true }) }
    else if (e.altKey && !mod && !e.shiftKey && k === 'z') { e.preventDefault(); e.stopPropagation(); toggleWrap() }
    else if (e.altKey && !mod && k === 'arrowleft' && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) { e.preventDefault(); go(-1) }
    else if (e.altKey && !mod && k === 'arrowright' && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) { e.preventDefault(); go(1) }
    else if (mod && e.shiftKey && !e.altKey && k === 'm') { e.preventDefault(); e.stopPropagation(); if (S.kind === 'text' && U.hasRendered(S.path)) setMode(S.mode === 'rendered' ? 'source' : 'rendered') }
    else if (mod && !e.altKey && !e.shiftKey && k === 'f' && viewKind === 'md') {
      e.preventDefault(); e.stopPropagation()
      setMode('source').then(() => view && view.search && view.search())
    } else if (mod && !e.altKey && !e.shiftKey && k === 'g' && viewKind === 'code') { e.preventDefault(); e.stopPropagation(); view.search() }
  }
  root.addEventListener('keydown', onKey, true)

  const themeObserver = new MutationObserver(() => { if (viewKind === 'md') view.retheme() })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
  cleanups.push(() => themeObserver.disconnect())

  // ---------------------------------------------------------------- boot
  renderHeader()
  empty(I.file, 'Loading…', '')
  ;(async () => {
    try { prefs = await readPrefs(ctx) } catch { /* defaults */ }
    if (prefs.fontSize) root.style.setProperty('--fb-fs', prefs.fontSize + 'px')
    if (args.path) await open({ path: args.path, line: args.line, col: args.col }, { mode: args.mode })
    else {
      empty(I.file, 'No file open', 'Open a file from the sidebar or the command palette.', [])
      renderHeader()
    }
  })()

  return {
    dispose() {
      disposed = true
      seq++
      if (S.dirty) writeJournal()
      timersClear()
      closePopovers()
      rpc('unwatch', { id: wid }).catch(() => {})
      if (unsub) unsub()
      for (const c of cleanups) c()
      clearView()
      root.remove()
    },
    focus: () => focus(),
    resize() { /* CodeMirror, the hex and image views follow their container */ },
    open: (spec, o) => open(spec, o),
    isDirty: () => S.dirty,
    save: () => save(),
    /** Resolves true when the pane may close (saved, discarded or clean). */
    async canClose() {
      if (!S.dirty) return true
      const c = await confirmLeave()
      return c !== 'cancel'
    },
  }
}
