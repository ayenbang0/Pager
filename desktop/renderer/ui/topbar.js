// The top bar (and Rail's left column): avatar, session chip, tab pills with a sliding highlight, "+", tools, inbox bell.
import { h, reconcile } from './dom.js'
import { app } from './store.js'
import { icon, markEl } from './icons.js'
import { tabLabel, paneGlyph, folderLabel, shortPath } from './labels.js'
import { runCommand, getCommand, splitChord } from './commands.js'
import { showMenu } from './popover.js'
import { openSettings } from './settings.js'
import { closeTab, renameTab } from './actions.js'

let barEl, tabsEl, pillEl, sessionEl, addEl, bellEl, badgeEl, updEl, vtabsEl, sidebarBtn
let lastSig = ''

const tool = (name, tip, keys, onClick, extra = {}) =>
  h('button', { class: 'icon-btn', type: 'button', attrs: { 'data-tip': tip, ...(keys ? { 'data-tip-keys': keys } : {}) }, onClick, ...extra }, icon(name))

function tabNode(tab) {
  const ico = h('span', { class: 'gl' })
  const ttl = h('span', { class: 'ttl' })
  const sub = h('span', { class: 'tt-sub' })
  const x = h('button', { class: 'x', type: 'button', attrs: { 'data-tip': 'Close tab' }, onClick: (e) => (e.stopPropagation(), closeTab(el.__key)) }, icon('close'))
  const el = h('div', { class: 'tt', role: 'tab', attrs: { tabindex: '0' } }, ico, ttl, sub, x)
  el.addEventListener('click', () => app.call('tab.activate', { tabId: el.__key }))
  el.addEventListener('auxclick', (e) => e.button === 1 && closeTab(el.__key))
  el.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), app.call('tab.activate', { tabId: el.__key })))
  el.addEventListener('dblclick', () => inlineRename(el))
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    const id = el.__key
    const s = app.activeSession()
    showMenu({
      anchor: { x: e.clientX, y: e.clientY },
      items: [
        { label: 'Rename', icon: 'edit', onClick: () => inlineRename(el) },
        { label: 'New tab', icon: 'plus', keys: getCommand('tab.new').keys, onClick: () => runCommand('tab.new') },
        { sep: true },
        { label: 'Close tab', icon: 'close', danger: true, onClick: () => closeTab(id) },
        { label: 'Close other tabs', icon: 'close', disabled: !s || s.tabs.length < 2, onClick: async () => { for (const t of s.tabs) if (t.id !== id) await closeTab(t.id) } },
      ],
    })
  })
  return el
}

function inlineRename(el) {
  const ttl = el.querySelector('.ttl')
  const input = h('input', { class: 'tt-edit', value: ttl.textContent, spellcheck: false })
  const id = el.__key
  let done = false
  const finish = (ok) => {
    if (done) return
    done = true
    const v = input.value.trim()
    input.replaceWith(ttl)
    if (ok && v && v !== ttl.textContent) app.call('tab.rename', { tabId: id, title: v })
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') finish(true)
    else if (e.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('click', (e) => e.stopPropagation())
  ttl.replaceWith(input)
  input.focus()
  input.select()
}

function updateTab(el, tab) {
  const on = tab.id === (app.activeSession() || {}).activeTab
  el.classList.toggle('on', on)
  el.setAttribute('aria-selected', String(on))
  const pane = app.paneById(tab.focus) || app.paneById(firstLeaf(tab.root))
  const gl = el.querySelector('.gl')
  const g = pane ? paneGlyph(pane) : 'terminal'
  if (gl.dataset.g !== g) {
    gl.dataset.g = g
    gl.replaceChildren(icon(g))
  }
  const label = tabLabel(tab)
  const ttl = el.querySelector('.ttl')
  if (ttl && ttl.textContent !== label) ttl.textContent = label
  el.querySelector('.tt-sub').textContent = pane ? shortPath(pane.cwd) : ''
  el.dataset.state = pane ? pane.state : ''
  el.title = label
}

function firstLeaf(n) {
  while (n && n.type !== 'pane') n = n.a
  return n ? n.paneId : null
}

function movePill(instant) {
  const on = tabsEl.querySelector('.tt.on')
  if (!on) {
    tabsEl.classList.remove('ready')
    return
  }
  if (instant) tabsEl.classList.add('flying')
  pillEl.style.width = `${on.offsetWidth}px`
  pillEl.style.transform = `translateX(${on.offsetLeft}px)`
  if (instant) requestAnimationFrame(() => (pillEl.getBoundingClientRect(), tabsEl.classList.remove('flying'), tabsEl.classList.add('ready')))
  else tabsEl.classList.add('ready')
}

function sessionMenu() {
  const st = app.state
  const items = st.sessions.map((s) => ({ label: s.name, icon: 'layers', check: s.id === st.activeSession, hint: `${s.tabs.length}`, onClick: () => runCommand('session.switch', { sessionId: s.id }) }))
  items.push({ sep: true }, { label: 'New session…', icon: 'plus', onClick: () => runCommand('session.new') }, { label: 'Rename session…', icon: 'edit', onClick: () => runCommand('session.rename') })
  if (st.sessions.length > 1) items.push({ label: 'Close session', icon: 'close', danger: true, onClick: () => runCommand('session.close') })
  showMenu({ anchor: sessionEl, items })
}

function renderVTabs(s) {
  if (!vtabsEl) return
  const on = document.documentElement.classList.contains('tabs-v')
  if (!on) {
    vtabsEl.replaceChildren()
    return
  }
  const groups = app.state.sessions.map((sess) =>
    h(
      'div',
      { class: 'vt-group' },
      h('div', { class: 'vt-head' }, h('span', {}, sess.name), h('span', { class: 'n' }, String(sess.tabs.length))),
      sess.tabs.map((t) => {
        const pane = app.paneById(t.focus) || app.paneById(firstLeaf(t.root))
        return h('div', { class: `vt-row${t.id === sess.activeTab && sess.id === app.state.activeSession ? ' on' : ''}`, onClick: () => app.call('tab.activate', { tabId: t.id }), onContextmenu: (e) => (e.preventDefault(), showMenu({ anchor: { x: e.clientX, y: e.clientY }, items: [{ label: 'Rename', icon: 'edit', onClick: () => renameTab(t.id) }, { label: 'Close tab', icon: 'close', danger: true, onClick: () => closeTab(t.id) }] })) }, icon(pane ? paneGlyph(pane) : 'terminal'), h('span', { class: 'ttl' }, tabLabel(t)))
      }),
    ),
  )
  vtabsEl.replaceChildren(...groups, h('button', { class: 'vt-row', type: 'button', onClick: () => runCommand('tab.new') }, icon('plus'), h('span', {}, 'New tab')))
}

export function render() {
  const s = app.activeSession()
  if (!s) return
  sessionEl.querySelector('.nm').textContent = s.name
  reconcile(tabsEl, s.tabs, (t) => t.id, tabNode, updateTab)
  const sig = s.tabs.map((t) => `${t.id}:${tabLabel(t)}`).join('|') + s.activeTab + app.settings.layout
  const instant = lastSig === ''
  requestAnimationFrame(() => movePill(instant || sig !== lastSig))
  lastSig = sig
  sidebarBtn.classList.toggle('on', !!app.settings.files_sidebar)
  renderVTabs(s)
  const cls = document.documentElement.classList
  cls.toggle('tabs-auto', !!app.settings.tabs_autohide)
}

export function setBell(count) {
  badgeEl.textContent = count > 9 ? '9+' : String(count)
  badgeEl.hidden = !count
}

export function showUpdate(label, onClick) {
  if (!label) return void (updEl.hidden = true)
  updEl.hidden = false
  updEl.querySelector('span').textContent = label
  updEl.onclick = onClick
}

export function initTopbar(onBell) {
  barEl = document.getElementById('bar')
  const stage = document.getElementById('stage')
  vtabsEl = h('nav', { id: 'vtabs' })
  stage.prepend(vtabsEl)

  const avatar = h('button', { class: 'avatar', id: 'avatar', type: 'button', attrs: { 'data-tip': 'Pager', 'aria-label': 'Settings' }, onClick: () => openSettings('general') }, markEl(16))
  sessionEl = h('button', { class: 'session-chip', type: 'button', attrs: { 'data-tip': 'Sessions' }, onClick: sessionMenu }, icon('lock'), h('span', { class: 'nm' }, 'Default'))
  tabsEl = h('div', { class: 'tabs', role: 'tablist' })
  pillEl = h('i', { class: 'tb-pill' })
  tabsEl.append(pillEl)
  const kbds = h('span', { class: 'kbds' })
  addEl = h('button', { class: 'icon-btn tb-add', type: 'button', attrs: { 'data-tip': 'New tab', 'data-tip-keys': 'Ctrl+Shift+T' }, onClick: () => runCommand('tab.new') }, icon('plus'), h('span', { class: 'lbl' }, 'New tab'), kbds)
  const keys = (getCommand('tab.new') || {}).keys
  for (const k of splitChord(keys)) kbds.append(h('kbd', { class: 'kbd' }, k))
  sidebarBtn = tool('files', 'Files sidebar', (getCommand('view.sidebar') || {}).keys, () => runCommand('view.sidebar'), { dataset: { keep: '1' } })
  sidebarBtn.classList.add('keep')
  badgeEl = h('span', { class: 'badge-dot', hidden: true })
  bellEl = tool('bell', 'Inbox', '', (e) => onBell && onBell(bellEl))
  bellEl.append(badgeEl)
  updEl = h('button', { class: 'upd-pill', type: 'button', hidden: true }, icon('download'), h('span', {}))
  const tools = h(
    'div',
    { class: 'bar-tools' },
    sidebarBtn,
    tool('split-right', 'Split right', 'Ctrl+Shift+Enter', () => runCommand('pane.split.right')),
    tool('split-down', 'Split down', 'Ctrl+Alt+Shift+Enter', () => runCommand('pane.split.down')),
    tool('search', 'Search files', 'Ctrl+Shift+F', () => runCommand('palette.files')),
    tool('slash', 'Command palette', 'Ctrl+Shift+P', () => runCommand('palette.open')),
    tool('globe', 'Browser pane', 'Ctrl+Shift+B', () => runCommand('view.browser'), { dataset: { browserToggle: '' } }),
    updEl,
    bellEl,
    tool('sliders', 'Settings', 'Ctrl+,', () => runCommand('settings.open')),
  )
  barEl.replaceChildren(h('div', { class: 'bar-l' }, avatar, sessionEl, h('span', { class: 'bar-sep' })), tabsEl, addEl, h('div', { class: 'bar-fill' }), tools)

  app.on('state', render)
  app.on('titles', render)
  app.on('settings', (p) => ('files_sidebar' in p || 'tabs' in p || 'layout' in p || 'tabs_autohide' in p) && requestAnimationFrame(render))
  window.addEventListener('resize', () => movePill(true))
  new ResizeObserver(() => movePill(true)).observe(tabsEl)
  render()
}
