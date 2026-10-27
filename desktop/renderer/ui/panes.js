// The pane host (#panes): lays the active tab's split tree out as cards, runs terminals and blocks inside them,
// and owns pane focus, dividers (pane.ratio) and the pane context menus.
import { h, clamp } from './dom.js'
import { app, layoutTree, tabPaneIds, isBlock, blockName, isHome } from './store.js'
import { TerminalView } from './terminal.js'
import { icon } from './icons.js'
import { BLOCKS } from '../blocks/index.js'
import { runCommand } from './commands.js'
import { showMenu } from './popover.js'
import { paneLabel, paneGlyph, shortPath } from './labels.js'

const seenFocus = new Map() // tabId -> the focus the daemon last reported
const views = new Map() // paneId -> PaneView
let host = null
const dividers = new Map() // path -> element
let dragging = false

class PaneView {
  constructor(pane) {
    this.id = pane.id
    this.kind = pane.kind
    this.visible = false
    this.term = null
    this.block = null
    this.exitShown = false
    this.focusEl = h('i', { class: 'tn-focus' })
    this.grip = h('button', { class: 'tn-grip', type: 'button', attrs: { 'data-tip': 'Pane menu' }, onClick: (e) => this.menu(e.currentTarget) }, icon('drag-grip'))
    this.titleEl = h('span', { class: 'ttl' })
    this.cwdEl = h('span', { class: 'cwd' })
    this.szEl = h('span', { class: 'sz' })
    this.head = h(
      'div',
      { class: 'tn-head', onContextmenu: (e) => (e.preventDefault(), this.menu({ x: e.clientX, y: e.clientY })) },
      h('span', { class: 'hd-ico' }),
      this.titleEl,
      this.cwdEl,
      this.szEl,
      h(
        'div',
        { class: 'hbtns' },
        h('button', { type: 'button', attrs: { 'data-tip': 'Split right', 'data-tip-keys': 'Ctrl+Shift+Enter' }, onClick: () => runCommand('pane.split.right', { paneId: this.id }) }, icon('split-right')),
        h('button', { type: 'button', attrs: { 'data-tip': 'Split down', 'data-tip-keys': 'Ctrl+Alt+Shift+Enter' }, onClick: () => runCommand('pane.split.down', { paneId: this.id }) }, icon('split-down')),
        isHome(pane) ? null : h('button', { type: 'button', attrs: { 'data-tip': 'Close pane', 'data-tip-keys': 'Ctrl+Shift+W' }, onClick: () => runCommand('pane.close', { paneId: this.id }) }, icon('close')),
      ),
    )
    this.content = h('div', { class: isBlock(pane) ? 'tn-block' : 'tn-term' })
    this.body = h('div', { class: 'tn-body' }, this.focusEl, this.grip, this.head, this.content)
    this.el = h('div', { class: 'tn-pane rise', dataset: { pane: pane.id } }, this.body)
    this.el.addEventListener('pointerdown', () => setFocus(this.id), true)
    this.el.addEventListener('animationend', (e) => e.target === this.body && this.el.classList.remove('rise'))
    if (!isBlock(pane)) {
      this.body.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        this.menu({ x: e.clientX, y: e.clientY }, true)
      })
    } else {
      // Right-click anywhere on a block offers the pane menu (with Close), unless the block handled the click itself or it landed in a text field.
      this.body.addEventListener('contextmenu', (e) => {
        if (e.defaultPrevented || (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"], .cm-editor'))) return
        e.preventDefault()
        this.menu({ x: e.clientX, y: e.clientY }, false)
      })
    }
  }

  get pane() {
    return app.paneById(this.id)
  }

  menu(anchor, terminal) {
    const pane = this.pane
    if (!pane) return
    const sel = this.term ? this.term.selection() : ''
    const items = []
    if (terminal) {
      items.push(
        { label: 'Copy', icon: 'copy', keys: 'Ctrl+Shift+C', disabled: !sel, onClick: () => navigator.clipboard.writeText(sel).catch(() => {}) },
        { label: 'Paste', icon: 'clipboard', keys: 'Ctrl+Shift+V', onClick: () => runCommand('term.paste') },
        { label: 'Clear', icon: 'trash', onClick: () => this.term && this.term.clear() },
        { sep: true },
      )
    }
    items.push(
      { label: 'Split right', icon: 'split-right', keys: 'Ctrl+Shift+Enter', onClick: () => runCommand('pane.split.right', { paneId: this.id }) },
      { label: 'Split down', icon: 'split-down', keys: 'Ctrl+Alt+Shift+Enter', onClick: () => runCommand('pane.split.down', { paneId: this.id }) },
    )
    const tab = app.activeTab()
    const others = (app.activeSession() ? app.activeSession().tabs : []).filter((t) => !tab || t.id !== tab.id)
    if (others.length) items.push({ label: 'Move to tab', icon: 'arrow-right', children: others.map((t) => ({ label: t.title || t.id, onClick: () => app.call('pane.move', { paneId: this.id, toTab: t.id }) })) })
    items.push({ sep: true }, { label: 'Copy folder path', icon: 'copy', disabled: !pane.cwd, onClick: () => navigator.clipboard.writeText(pane.cwd).catch(() => {}) }, { label: isBlock(pane) ? 'Close block' : 'Close pane', icon: 'close', keys: 'Ctrl+Shift+W', danger: true, disabled: isHome(pane), onClick: () => runCommand('pane.close', { paneId: this.id }) })
    showMenu({ anchor, items, align: 'start' })
  }

  /** Called whenever state changes: headers, exit card, lazy start. */
  update(pane) {
    this.titleEl.textContent = paneLabel(pane)
    this.cwdEl.textContent = shortPath(pane.cwd)
    const g = this.head.firstChild
    if (!g.firstChild || g.dataset.g !== paneGlyph(pane)) {
      g.replaceChildren(icon(paneGlyph(pane)))
      g.dataset.g = paneGlyph(pane)
    }
    const ended = pane.state === 'exited' && !isBlock(pane)
    if (ended !== this.exitShown) {
      this.exitShown = ended
      if (ended) this.showEnded(pane)
      else if (this.endedEl) (this.endedEl.remove(), (this.endedEl = null))
    }
  }

  showEnded(pane) {
    const code = pane.exitCode
    this.endedEl = h(
      'div',
      { class: 'tn-ended' },
      h('h4', {}, code ? 'Process ended with an error' : 'Process ended'),
      h('p', {}, code === undefined ? paneLabel(pane) : `${paneLabel(pane)} · exit code ${code}`),
      h(
        'div',
        { class: 'acts' },
        h('button', { class: 'btn sm accent', type: 'button', onClick: () => runCommand('pane.split.right', { paneId: this.id, kind: 'shell' }) }, 'New shell beside'),
        pane.kind === 'pager'
          ? h('button', { class: 'btn sm', type: 'button', onClick: () => app.call('pane.restart', { paneId: this.id }) }, 'Restart Pager')
          : h('button', { class: 'btn sm', type: 'button', onClick: () => runCommand('pane.close', { paneId: this.id }) }, 'Close pane'),
      ),
    )
    this.body.append(this.endedEl)
  }

  setVisible(v, pane) {
    if (this.visible === v) return
    this.visible = v
    this.el.hidden = !v
    if (this.term) this.term.setVisible(v)
    if (v) this.ensureContent(pane)
  }

  ensureContent(pane) {
    if (this.started) return
    this.started = true
    if (isBlock(pane)) this.mountBlock(pane)
    else this.mountTerminal(pane)
  }

  mountTerminal(pane) {
    this.term = new TerminalView(this.id, this.content, {
      onFocus: () => setFocus(this.id, true),
      onTitle: (t) => {
        const info = app.paneInfo.get(this.id) || {}
        app.paneInfo.set(this.id, { ...info, osTitle: t })
        app.emit('titles')
      },
      onBell: () => {
        this.el.classList.add('bell')
        setTimeout(() => this.el.classList.remove('bell'), 600)
      },
      onSize: (c, r) => {
        this.szEl.textContent = `${c}×${r}`
        app.paneInfo.set(this.id, { ...(app.paneInfo.get(this.id) || {}), cols: c, rows: r })
      },
    })
    this.term.setVisible(this.visible)
    this.term.start().catch((e) => {
      this.content.append(h('div', { class: 'tn-nope' }, `Terminal failed to start: ${e && e.message ? e.message : e}`))
    })
  }

  async mountBlock(pane) {
    const name = blockName(pane)
    const def = BLOCKS.find((b) => b.id === name)
    const nope = (msg) => this.content.replaceChildren(h('div', { class: 'tn-nope' }, msg))
    if (!def) return nope(`Unknown block “${name}”.`)
    let mod
    try {
      mod = (await def.load()).default
    } catch (e) {
      return nope(`The ${name} block is not available (${e && e.message ? e.message : e}).`)
    }
    if (!this.pane || this.disposed) return
    let args = {}
    try {
      args = pane.command ? JSON.parse(pane.command) : {}
    } catch {
      args = {}
    }
    const view = this
    const ctx = {
      args,
      paneId: view.id, // blocks/share.js keys mounted block instances by pane (registerInstance on mount, unregister on dispose)
      get cwd() {
        const p = view.pane
        return (p && p.cwd) || pane.cwd || ''
      },
      theme: document.documentElement,
      rpc: (method, a) => app.d.block(name, method, a),
      onEvent: (fn) => app.d.onBlock(name, fn),
      setTitle: (s) => {
        app.paneInfo.set(view.id, { ...(app.paneInfo.get(view.id) || {}), title: s })
        app.emit('titles')
      },
      close: () => runCommand('pane.close', { paneId: view.id }),
      openBlock: (n, a) => runCommand('block.open', { name: n, args: a, from: view.id }),
      openPath: (p) => runCommand('file.open', { path: p, from: view.id }),
      toast: (level, text) => runCommand('toast', { level, text }),
    }
    try {
      this.block = mod.mount(this.content, ctx)
    } catch (e) {
      return nope(`The ${name} block failed to start: ${e && e.message ? e.message : e}`)
    }
    this.ro = new ResizeObserver(() => this.block && this.block.resize && this.block.resize())
    this.ro.observe(this.content)
    if (app.focusedPaneId === this.id && this.block && this.block.focus) this.block.focus()
  }

  focus() {
    if (this.term) this.term.focus()
    else if (this.block && this.block.focus) this.block.focus()
  }

  dispose() {
    this.disposed = true
    if (this.term) this.term.dispose()
    if (this.ro) this.ro.disconnect()
    if (this.block && this.block.dispose) {
      try { this.block.dispose() } catch { /* a block must not break the shell */ }
    }
    this.el.remove()
  }
}

export const viewOf = (id) => views.get(id) || null
export const focusedView = () => views.get(app.focusedPaneId) || null

/** Focus a pane: instantly in the UI, then tell the daemon. `fromDom` = the DOM already focused it. */
export function setFocus(id, fromDom) {
  const tab = app.activeTab()
  if (!tab || !tabPaneIds(tab).includes(id)) return
  const changed = app.focusedPaneId !== id
  app.focusedPaneId = id
  for (const [pid, v] of views) v.el.classList.toggle('on', pid === id)
  if (!fromDom) {
    const v = views.get(id)
    if (v) v.focus()
  }
  if (changed) {
    app.emit('focus', id)
    if (tab.focus !== id) {
      tab.focus = id
      app.call('pane.focus', { paneId: id }).catch(() => {})
    }
  }
}

/** Move focus to the neighbour in a direction ('left'|'right'|'up'|'down'), by pane geometry. */
export function focusDirection(dir) {
  const tab = app.activeTab()
  if (!tab) return
  const { panes } = layoutTree(tab.root)
  const cur = panes.get(app.focusedPaneId || tab.focus)
  if (!cur) return
  const cx = cur.x + cur.w / 2
  const cy = cur.y + cur.h / 2
  let best = null
  for (const [id, r] of panes) {
    if (r === cur) continue
    const x = r.x + r.w / 2
    const y = r.y + r.h / 2
    const dx = x - cx
    const dy = y - cy
    const ok = dir === 'left' ? dx < -1e-6 : dir === 'right' ? dx > 1e-6 : dir === 'up' ? dy < -1e-6 : dy > 1e-6
    if (!ok) continue
    const score = dir === 'left' || dir === 'right' ? Math.abs(dx) + Math.abs(dy) * 2 : Math.abs(dy) + Math.abs(dx) * 2
    if (!best || score < best.score) best = { id, score }
  }
  if (best) setFocus(best.id)
}

function place(el, r) {
  const s = el.style
  s.left = `${r.x * 100}%`
  s.top = `${r.y * 100}%`
  s.width = `${r.w * 100}%`
  s.height = `${r.h * 100}%`
}

function placeDivider(el, d) {
  const s = el.style
  if (d.dir === 'row') {
    s.left = `${d.at * 100}%`
    s.top = `${d.rect.y * 100}%`
    s.height = `${d.rect.h * 100}%`
    s.width = ''
    s.topMargin = ''
  } else {
    s.top = `${d.at * 100}%`
    s.left = `${d.rect.x * 100}%`
    s.width = `${d.rect.w * 100}%`
    s.height = ''
  }
}

function dividerDrag(e, el, d) {
  if (e.button !== 0) return
  e.preventDefault()
  const box = host.getBoundingClientRect()
  const row = d.dir === 'row'
  const node = d.node
  el.setPointerCapture(e.pointerId)
  el.classList.add('drag')
  host.classList.add('dragging')
  dragging = true
  const move = (m) => {
    const size = row ? box.width * d.rect.w : box.height * d.rect.h
    const from = row ? box.left + box.width * d.rect.x : box.top + box.height * d.rect.y
    node.ratio = clamp(((row ? m.clientX : m.clientY) - from) / size, 0.1, 0.9)
    relayout()
  }
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    el.classList.remove('drag')
    host.classList.remove('dragging')
    dragging = false
    const pid = d.a
    app.call('pane.ratio', { paneId: pid, ratio: node.ratio, path: d.path }).catch(() => {})
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}

function relayout() {
  const tab = app.activeTab()
  if (!tab) return
  const lay = layoutTree(tab.root)
  for (const [id, r] of lay.panes) {
    const v = views.get(id)
    if (v) place(v.el, r)
  }
  const live = new Set()
  for (const d of lay.dividers) {
    live.add(d.path)
    let el = dividers.get(d.path)
    if (!el) {
      el = h('div', { class: `tn-div ${d.dir}` })
      el.addEventListener('pointerdown', (e) => dividerDrag(e, el, el.__d))
      el.addEventListener('dblclick', () => {
        el.__d.node.ratio = 0.5
        relayout()
        app.call('pane.ratio', { paneId: el.__d.a, ratio: 0.5, path: el.__d.path }).catch(() => {})
      })
      dividers.set(d.path, el)
      host.append(el)
    }
    el.className = `tn-div ${d.dir}${el.classList.contains('drag') ? ' drag' : ''}`
    el.__d = d
    placeDivider(el, d)
  }
  for (const [k, el] of dividers) if (!live.has(k)) (el.remove(), dividers.delete(k))
}

/** Reconcile views with the daemon state and the active tab. */
export function renderPanes() {
  if (!host || dragging) return
  const tab = app.activeTab()
  const ids = new Set(tabPaneIds(tab))
  const known = new Set(app.state.panes.map((p) => p.id))
  const first = host.querySelector('.skel-pane')
  if (first) first.remove()
  for (const [id, v] of views) {
    if (!known.has(id)) {
      v.dispose()
      views.delete(id)
      app.paneInfo.delete(id)
    }
  }
  for (const id of ids) {
    const pane = app.paneById(id)
    if (!pane) continue
    let v = views.get(id)
    if (!v) {
      v = new PaneView(pane)
      views.set(id, v)
      v.el.hidden = true
      host.append(v.el)
    }
  }
  const multi = ids.size > 1
  for (const [id, v] of views) {
    const pane = app.paneById(id)
    const show = ids.has(id)
    if (pane) v.update(pane)
    v.el.classList.toggle('multi', multi)
    v.setVisible(show, pane)
  }
  relayout()
  if (tab) {
    const daemonMoved = seenFocus.get(tab.id) !== tab.focus
    seenFocus.set(tab.id, tab.focus)
    const want = !daemonMoved && app.focusedPaneId && ids.has(app.focusedPaneId) ? app.focusedPaneId : tab.focus
    if (want && ids.has(want)) {
      const was = app.focusedPaneId
      app.focusedPaneId = want
      for (const [pid, v] of views) v.el.classList.toggle('on', pid === want)
      if (was !== want) {
        app.emit('focus', want)
        const v = views.get(want)
        if (v && document.hasFocus() && !document.querySelector('#overlay > *')) requestAnimationFrame(() => v.focus())
      }
    }
  }
  app.emit('panes')
}

export function initPanes() {
  host = document.getElementById('panes')
  app.d.onData((id, data) => {
    const v = views.get(id)
    if (v && v.term) v.term.write(data)
  })
  if (app.d.onResync) app.d.onResync((id, r) => views.get(id) && views.get(id).term && views.get(id).term.resync(r))
  app.on('state', renderPanes)
  app.on('titles', () => {
    for (const [id, v] of views) {
      const p = app.paneById(id)
      if (p) v.update(p)
    }
  })
  let t = 0
  app.on('settings', () => {
    clearTimeout(t)
    t = setTimeout(() => views.forEach((v) => v.term && v.term.applySettings()), 30)
  })
  app.on('theme', () => views.forEach((v) => v.term && v.term.applySettings()))
  if (app.mock) window.__pager = { app, views }
  renderPanes()
}

/** All views (for hotkeys that act on the focused terminal). */
export const allViews = () => Array.from(views.values())
