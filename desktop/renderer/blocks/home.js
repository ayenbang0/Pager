// Home block: Pager's front door. The first pane of every session, pinned (it has no close button and the daemon refuses
// to close it). A greeting, quick actions that open in new tabs, the panes running right now (live from the daemon),
// recent folders and what's new in the newest release.
import { h, reconcile, rafThrottle } from '../ui/dom.js'
import { app, isBlock } from '../ui/store.js'
import { icon } from '../ui/icons.js'
import { runCommand, getCommand, splitChord } from '../ui/commands.js'
import { paneLabel, paneGlyph, shortPath, folderLabel, AGENT_KINDS } from '../ui/labels.js'
import { RECENT_KEY, livePanes, mergeRecent, packRecent, dayPart, displayName, parseChangelog } from './home-model.js'

const CSS = new URL('./home.css', import.meta.url).href
if (!document.querySelector(`link[href="${CSS}"]`)) document.head.append(h('link', { rel: 'stylesheet', href: CSS }))

const block = (name) => ({ cmd: 'tab.new.block', arg: { name }, keys: `block.${name}` })
const TILES = [
  { id: 'terminal', title: 'New terminal', sub: 'A shell in a new tab', icon: 'terminal', cmd: 'tab.new', keys: 'tab.new' },
  { id: 'agent', title: 'New agent', sub: 'Start omp in a new tab', icon: 'sparkle', cmd: 'tab.new.agent' },
  { id: 'chats', title: 'Chats', sub: 'Messages, shared agents and blocks', icon: 'chat', ...block('chats') },
  { id: 'files', title: 'Files', sub: 'Browse, search and edit', icon: 'files', ...block('files') },
  { id: 'git', title: 'Git', sub: 'Changes, history, branches', icon: 'branch', ...block('git') },
  { id: 'database', title: 'Database', sub: 'SQLite tables and queries', icon: 'database', ...block('database') },
  { id: 'notebook', title: 'Notebook', sub: 'Python cells and notes', icon: 'notebook', ...block('notebook') },
  { id: 'canvas', title: 'Canvas', sub: 'An infinite whiteboard', icon: 'grid', ...block('canvas') },
  { id: 'board', title: 'Board', sub: 'Your TODO.md as a kanban', icon: 'board', ...block('board') },
  { id: 'tasks', title: 'Tasks', sub: 'Processes, CPU and memory', icon: 'tasks', ...block('tasks') },
  { id: 'screen', title: 'Screen', sub: 'View and drive a display', icon: 'screen', ...block('screen') },
  { id: 'browser', title: 'Browser pane', sub: 'Web pages beside your work', icon: 'globe', cmd: 'view.browser', keys: 'view.browser' },
  { id: 'docs', title: 'Docs', sub: 'Guides and usage stats', icon: 'book', cmd: 'view.docs', keys: 'view.docs' },
  { id: 'settings', title: 'Settings', sub: 'Themes, layout, keys', icon: 'sliders', cmd: 'settings.open', keys: 'settings.open' },
  { id: 'palette', title: 'Command palette', sub: 'Everything, by name', icon: 'slash', cmd: 'palette.open', keys: 'palette.open' },
]

const keycaps = (commandId) => {
  const c = commandId ? getCommand(commandId) : null
  const parts = c ? splitChord(c.keys) : []
  return h('span', { class: 'kbds' }, parts.map((k) => h('kbd', { class: 'kbd' }, k)))
}

function readRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function writeRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    // storage unavailable: the list just starts from the open panes next time
  }
}

function mount(el, ctx) {
  let disposed = false

  // ------------------------------------------------------------ hero
  const nameEl = h('span', { class: 'hm-name' })
  const hello = h('h1', null, dayPart(new Date()), nameEl)
  const hero = h('header', { class: 'hm-hero' }, h('div', { class: 'hm-hello' }, hello, h('p', null, 'Everything you start here keeps running when you close the window.')))
  const setUser = (user) => {
    const nm = displayName(user)
    nameEl.textContent = nm ? `, ${nm}` : ''
  }

  // ------------------------------------------------------------ quick actions
  const tilesEl = h('div', { class: 'hm-tiles' })
  const fillTiles = () => {
    tilesEl.replaceChildren(
      ...TILES.map((t) =>
        h(
          'button',
          { class: 'hm-tile', type: 'button', dataset: { tile: t.id }, title: t.title, onClick: () => runCommand(t.cmd, t.arg) },
          h('span', { class: 'hm-top' }, icon(t.icon), keycaps(t.keys)),
          h('span', { class: 'hm-t' }, t.title),
          h('span', { class: 'hm-s' }, t.sub),
        ),
      ),
    )
  }
  const tilesSec = h('section', null, h('div', { class: 'hm-h' }, 'Start'), tilesEl)

  // ------------------------------------------------------------ running now
  const liveList = h('div', { class: 'hm-list' })
  const liveCount = h('small')
  const liveCard = h('section', { class: 'hm-card' }, h('div', { class: 'hm-h' }, 'Running now', liveCount), liveList)
  const SHOWN = 7

  const goTo = (row) => {
    app.call('tab.activate', { tabId: row.tabId }).catch(() => {})
    app.call('pane.focus', { paneId: row.paneId }).catch(() => {})
  }

  function liveRow(row) {
    const d = h('i', { class: 'hm-dot' })
    const g = h('span', { class: 'hm-g' })
    const t = h('b')
    const s = h('small')
    const tag = h('span', { class: 'hm-tag' })
    const b = h('button', { class: 'hm-row', type: 'button' }, d, g, h('span', { class: 'hm-row-t' }, t, s), tag)
    b.addEventListener('click', () => b.__row && goTo(b.__row))
    b.__ref = { d, g, t, s, tag }
    return b
  }

  function paintLive() {
    if (disposed) return
    const rows = livePanes(app.state)
    const multi = app.state.sessions.length > 1
    liveCount.textContent = rows.length ? String(rows.length) : ''
    liveCard.classList.toggle('empty', rows.length === 0)
    const shown = rows.slice(0, SHOWN)
    const items = shown.map((r) => r)
    reconcile(
      liveList,
      items,
      (r) => r.paneId,
      liveRow,
      (b, r) => {
        b.__row = r
        const { d, g, t, s, tag } = b.__ref
        const glyph = paneGlyph(r.pane)
        if (g.dataset.g !== glyph) {
          g.dataset.g = glyph
          g.replaceChildren(icon(glyph))
        }
        d.className = `hm-dot${r.pane.state === 'running' ? '' : ' restored'}`
        d.title = r.pane.state === 'running' ? 'Running' : 'Restored: starts again when you type'
        const label = paneLabel(r.pane)
        t.textContent = label === '~' || label === '' ? (r.pane.kind === 'pager' ? 'Pager' : 'Terminal') : label
        s.textContent = isBlock(r.pane) ? '' : shortPath(r.pane.cwd)
        s.hidden = !s.textContent
        tag.hidden = !(multi || AGENT_KINDS.includes(r.pane.kind))
        tag.textContent = AGENT_KINDS.includes(r.pane.kind) ? r.pane.kind : r.sessionName
      },
    )
    for (const x of liveList.querySelectorAll('.hm-more, .hm-empty')) x.remove()
    if (!rows.length) liveList.append(h('div', { class: 'hm-empty' }, 'Nothing else is running. Start something above.'))
    else if (rows.length > shown.length) liveList.append(h('div', { class: 'hm-more' }, `and ${rows.length - shown.length} more in the tab bar`))
  }

  // ------------------------------------------------------------ recent folders
  const recentList = h('div', { class: 'hm-list' })
  const recentCard = h('section', { class: 'hm-card' }, h('div', { class: 'hm-h' }, 'Recent folders'), recentList)
  let recent = readRecent()
  const RECENT_SHOWN = 5

  const inFolder = (cwd, kind) => app.call('tab.new', { sessionId: (app.activeSession() || {}).id, kind, cwd }).catch(() => {})

  function recentRow(cwd) {
    const name = h('b')
    const sub = h('small')
    const b = h(
      'div',
      { class: 'hm-row', role: 'button', tabIndex: 0 },
      h('span', { class: 'hm-g' }, icon('folder')),
      h('span', { class: 'hm-row-t' }, name, sub),
      h(
        'span',
        { class: 'hm-acts' },
        h('button', { class: 'hm-act', type: 'button', title: 'Open in Files', onClick: (e) => (e.stopPropagation(), b.__cwd && inFolder(b.__cwd, 'block:files')) }, icon('files')),
        h('button', { class: 'hm-act', type: 'button', title: 'New terminal here', onClick: (e) => (e.stopPropagation(), b.__cwd && inFolder(b.__cwd, 'shell')) }, icon('terminal')),
      ),
    )
    b.addEventListener('click', () => b.__cwd && inFolder(b.__cwd, 'shell'))
    b.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && e.target === b && (e.preventDefault(), b.__cwd && inFolder(b.__cwd, 'shell')))
    b.__ref = { name, sub }
    return b
  }

  function paintRecent() {
    if (disposed) return
    const merged = mergeRecent(recent, app.state, app.home, 12)
    if (JSON.stringify(merged) !== JSON.stringify(recent)) {
      recent = packRecent(merged)
      writeRecent(recent)
    }
    const shown = merged.slice(0, RECENT_SHOWN)
    reconcile(
      recentList,
      shown,
      (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(),
      recentRow,
      (b, p) => {
        b.__cwd = p
        b.__ref.name.textContent = folderLabel(p)
        b.__ref.sub.textContent = shortPath(p)
        b.title = p
      },
    )
    for (const x of recentList.querySelectorAll('.hm-empty')) x.remove()
    if (!shown.length) recentList.append(h('div', { class: 'hm-empty' }, 'Folders you work in show up here.'))
  }

  // ------------------------------------------------------------ what's new
  const newCard = h('section', { class: 'hm-card', hidden: true })
  function paintNew(md) {
    const log = parseChangelog(md, 5)
    if (!log) return
    newCard.replaceChildren(
      h('div', { class: 'hm-h' }, "What's new", h('span', { class: 'chip mono' }, `v${log.version}`), h('span', { class: 'hm-grow' }), log.date ? h('small', null, log.date) : null),
      h('ul', { class: 'hm-new' }, log.items.map((it) => h('li', null, it.lead ? h('b', null, it.lead) : null, it.lead && it.text ? ': ' : null, it.text))),
    )
    newCard.hidden = false
  }

  // ------------------------------------------------------------ assemble
  fillTiles()
  const root = h('div', { class: 'hm' }, h('div', { class: 'hm-scroll', tabIndex: -1 }, h('div', { class: 'hm-in' }, hero, tilesSec, h('div', { class: 'hm-cols' }, liveCard, recentCard), newCard)))
  el.append(root)
  const scroller = root.firstChild

  const repaint = rafThrottle(() => {
    paintLive()
    paintRecent()
  })
  paintLive()
  paintRecent()
  const offs = [
    app.on('state', repaint),
    app.on('titles', repaint),
    app.on('settings', (patch) => patch && patch.keybinds !== undefined && fillTiles()),
  ]

  ctx.rpc('info', {}).then(
    (info) => {
      if (disposed || !info) return
      if (info.home && !app.home) app.home = info.home
      setUser(info.user)
      if (info.changelog) paintNew(info.changelog)
      paintRecent()
      paintLive()
    },
    () => {},
  )

  return {
    dispose() {
      disposed = true
      for (const off of offs) off()
    },
    focus() {
      scroller.focus({ preventScroll: true })
    },
  }
}

export default { id: 'home', title: 'Home', icon: icon('pager').outerHTML, mount }
