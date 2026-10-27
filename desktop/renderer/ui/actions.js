// Every user-facing action: registered as a command (so the palette lists it) and bound to a hotkey where it has one.
import { app, isHome, tabPaneIds } from './store.js'
import { registerCommands, commandForChord, chordFromEvent, runCommand } from './commands.js'
import { BLOCKS } from '../blocks/index.js'
import { BLOCK_TITLES, BLOCK_ICONS, shortPath } from './labels.js'
import { focusDirection, focusedView } from './panes.js'
import { openPalette, closePalette, paletteOpen, openPicker, openThemePicker } from './palette.js'
import { openSettings, toggleSettings } from './settings.js'
import { confirmDialog, promptDialog } from './dialog.js'
import { toast } from './toast.js'
import { clamp } from './dom.js'

const hk = (name) => window.pager && window.pager.hotkey && window.pager.hotkey(name)
const set = (patch) => app.set(patch)
// The native caption buttons float over the glass top bar, so their symbols switch with the theme: light grey on pitch black, dark grey on the off-white light theme.
app.on('theme', () => {
  if (window.pager && window.pager.chrome) window.pager.chrome('titlebar', document.documentElement.dataset.theme === 'light' ? '#4b4f57' : '#b4b8c4')
})

/** Window material, opacity and font size belong to the host window when it offers a hotkey for them (it also repaints the native backdrop); otherwise they are plain settings. */
function viaMain(name, patch) {
  if (window.pager && window.pager.hotkey && window.pager.onConfig) hk(name)
  else set(patch)
}
const LAYOUTS = ['rail', 'float', 'tiles', 'studio']
const LAYOUT_NAMES = { rail: 'Rail', float: 'Float', tiles: 'Tiles', studio: 'Studio' }
const LAYOUT_DOC = {
  rail: 'Arc: two-line tabs down the left edge, no top bar.',
  float: 'Zen: the terminal fills the window; a glass pill holds the tabs.',
  tiles: 'Tiling: every pane its own card on the glass.',
  studio: 'Tabs as pills in a titlebar, every pane headed.',
}
const BLOCK_KEYS = { files: 'Ctrl+Shift+O', git: 'Ctrl+Alt+G', board: 'Ctrl+Alt+K', chats: 'Ctrl+Alt+C' }

const session = () => app.activeSession()
const focusedId = () => {
  const t = app.activeTab()
  return app.focusedPaneId && tabPaneIds(t).includes(app.focusedPaneId) ? app.focusedPaneId : t ? t.focus : null
}
const newCwd = () => (app.settings.new_tabs_start === 'home' ? undefined : app.focusedCwd() || undefined)

/** Confirm closing panes according to settings.confirm_close. Resolves true when it may go ahead. */
export async function confirmClose(panes, what) {
  const mode = app.settings.confirm_close
  if (mode === 'never' || !panes.length) return true
  const busy = panes.filter((p) => p.state === 'running' && (mode === 'always' || (p.cpu || 0) > 2))
  if (!busy.length) return true
  return confirmDialog({ title: `Close ${what}?`, body: busy.length === 1 ? 'A program is still running in it.' : `${busy.length} programs are still running in it.`, confirm: 'Close', danger: true })
}

export async function newTab(opts = {}) {
  const s = session()
  const kind = opts.kind || 'shell'
  return app.call('tab.new', { sessionId: s && s.id, kind, cwd: opts.cwd !== undefined ? opts.cwd : newCwd(), command: opts.command })
}

export async function splitPane(dir, opts = {}) {
  const id = opts.paneId || focusedId()
  if (!id) return newTab(opts)
  const src = app.paneById(id)
  return app.call('pane.split', { paneId: id, dir, kind: opts.kind || 'shell', cwd: opts.cwd !== undefined ? opts.cwd : (src && src.cwd) || undefined, command: opts.command })
}

export async function closePane(paneId) {
  const id = paneId || focusedId()
  const p = app.paneById(id)
  if (!p) return
  if (isHome(p)) return toast('info', 'Pager home stays open')
  if (!(await confirmClose([p], 'this pane'))) return
  return app.call('pane.close', { paneId: id })
}

export async function closeTab(tabId) {
  const s = session()
  const tab = (s ? s.tabs : []).find((t) => t.id === (tabId || (app.activeTab() && app.activeTab().id)))
  if (!tab) return
  const panes = tabPaneIds(tab).map((id) => app.paneById(id)).filter(Boolean)
  if (panes.some(isHome)) return toast('info', 'Pager home stays open')
  if (!(await confirmClose(panes, 'this tab'))) return
  return app.call('tab.close', { tabId: tab.id })
}

export async function renameTab(tabId) {
  const s = session()
  const tab = (s ? s.tabs : []).find((t) => t.id === tabId) || app.activeTab()
  if (!tab) return
  const v = await promptDialog({ title: 'Rename tab', label: 'Name', value: tab.title || '', confirm: 'Rename' })
  if (v) return app.call('tab.rename', { tabId: tab.id, title: v })
}

export async function openBlock(name, args, from) {
  const cwd = app.focusedCwd() || undefined
  const kind = `block:${name}`
  const command = args && Object.keys(args).length ? JSON.stringify(args) : undefined
  const id = from || focusedId()
  if (!id) return app.call('tab.new', { sessionId: session() && session().id, kind, cwd, command })
  return app.call('pane.split', { paneId: id, dir: 'row', kind, cwd, command })
}

/** A block (canvas, notebook, database, …) in a tab of its own. */
export async function newBlockTab(name, args) {
  const command = args && Object.keys(args).length ? JSON.stringify(args) : undefined
  return app.call('tab.new', { sessionId: session() && session().id, kind: `block:${name}`, cwd: app.focusedCwd() || undefined, command })
}

/** Show the tab that holds the Home pane. */
export function goHome() {
  const home = app.state.panes.find(isHome)
  for (const s of app.state.sessions) {
    const tab = s.tabs.find((t) => tabPaneIds(t).includes(home && home.id))
    if (tab) return app.call('tab.activate', { tabId: tab.id })
  }
}

/** What hovering the + button offers: a terminal, then every block as a new tab. */
export function newTabMenuItems() {
  const blocks = BLOCKS.filter((b) => b.id !== 'surface' && b.id !== 'home')
  return [
    { label: 'Terminal', icon: 'terminal', keys: 'Ctrl+Shift+T', onClick: () => runCommand('tab.new') },
    ...blocks.map((b, i) => ({ ...(i === 0 ? { section: 'Blocks' } : {}), label: BLOCK_TITLES[b.id] || b.id, icon: BLOCK_ICONS[b.id] || 'box', onClick: () => runCommand('tab.new.block', { name: b.id }) })),
  ]
}

async function runInSplit(command, label) {
  const id = focusedId()
  const cwd = app.focusedCwd() || undefined
  toast('info', label)
  if (id) return app.call('pane.split', { paneId: id, dir: 'col', kind: 'shell', cwd, command })
  return newTab({ kind: 'shell', cwd, command })
}

function cycle(list, cur, step = 1) {
  const i = list.indexOf(cur)
  return list[(i + step + list.length) % list.length]
}

function layoutPicker() {
  openPicker({
    placeholder: 'Change interface style…',
    current: app.settings.layout,
    items: LAYOUTS.map((l) => ({ id: l, label: LAYOUT_NAMES[l], sub: LAYOUT_DOC[l], icon: `layout-${l}` })),
    onPick: (it) => set({ layout: it.id }),
  })
}

export function initActions() {
  const cmds = [
    // tabs and panes
    { id: 'tab.new', title: 'New tab', group: 'Commands', icon: 'plus', keys: 'Ctrl+Shift+T', run: () => newTab() },
    { id: 'tab.new.shell', title: 'New shell tab', group: 'Commands', icon: 'terminal', run: () => newTab({ kind: 'shell' }) },
    { id: 'tab.new.block', title: 'New block tab', group: 'Commands', icon: 'box', hidden: true, run: (a) => a && a.name && newBlockTab(a.name, a.args) },
    { id: 'tab.new.agent', title: 'New agent tab', group: 'Commands', icon: 'sparkle', run: () => newTab({ kind: 'omp' }) },
    { id: 'home.show', title: 'Go to Home', group: 'Commands', icon: 'home', run: () => goHome() },
    { id: 'tab.close', title: 'Close tab', group: 'Commands', icon: 'close', keys: 'Ctrl+Alt+W', run: (a) => closeTab(a && a.tabId) },
    { id: 'tab.rename', title: 'Rename tab…', group: 'Commands', icon: 'edit', run: (a) => renameTab(a && a.tabId) },
    { id: 'tab.next', title: 'Next tab', group: 'Commands', icon: 'arrow-right', keys: 'Ctrl+Tab', run: () => stepTab(1) },
    { id: 'tab.prev', title: 'Previous tab', group: 'Commands', icon: 'arrow-left', keys: 'Ctrl+Shift+Tab', run: () => stepTab(-1) },
    { id: 'pane.split.right', title: 'Split right', group: 'Commands', icon: 'split-right', keys: 'Ctrl+Shift+Enter', run: (a) => splitPane('row', a || {}) },
    { id: 'pane.split.down', title: 'Split down', group: 'Commands', icon: 'split-down', keys: 'Ctrl+Alt+Shift+Enter', run: (a) => splitPane('col', a || {}) },
    { id: 'pane.close', title: 'Close pane', group: 'Commands', icon: 'close', keys: 'Ctrl+Shift+W', run: (a) => closePane(a && a.paneId) },
    { id: 'pane.focus.left', title: 'Focus pane to the left', group: 'Commands', icon: 'arrow-left', keys: 'Ctrl+Alt+ArrowLeft', run: () => focusDirection('left') },
    { id: 'pane.focus.right', title: 'Focus pane to the right', group: 'Commands', icon: 'arrow-right', keys: 'Ctrl+Alt+ArrowRight', run: () => focusDirection('right') },
    { id: 'pane.focus.up', title: 'Focus pane above', group: 'Commands', icon: 'arrow-up', keys: 'Ctrl+Alt+ArrowUp', run: () => focusDirection('up') },
    { id: 'pane.focus.down', title: 'Focus pane below', group: 'Commands', icon: 'arrow-down', keys: 'Ctrl+Alt+ArrowDown', run: () => focusDirection('down') },
    { id: 'term.copy', title: 'Copy selection', group: 'Commands', icon: 'copy', keys: 'Ctrl+Shift+C', run: () => { const v = focusedView(); const s = v && v.term ? v.term.selection() : ''; if (s) navigator.clipboard.writeText(s).catch(() => {}) } },
    { id: 'term.paste', title: 'Paste', group: 'Commands', icon: 'clipboard', keys: 'Ctrl+Shift+V', run: () => navigator.clipboard.readText().then((t) => { const v = focusedView(); if (v && v.term && t) v.term.paste(t) }).catch(() => {}) },
    { id: 'term.clear', title: 'Clear terminal', group: 'Commands', icon: 'trash', run: () => { const v = focusedView(); if (v && v.term) v.term.clear() } },
    // sessions
    { id: 'session.new', title: 'New session…', group: 'Commands', icon: 'layers', run: async () => { const n = await promptDialog({ title: 'New session', label: 'Name', placeholder: 'Work', confirm: 'Create' }); if (n) return app.call('session.new', { name: n, cwd: newCwd() }) } },
    { id: 'session.rename', title: 'Rename session…', group: 'Commands', icon: 'edit', run: async () => { const s = session(); if (!s) return; const n = await promptDialog({ title: 'Rename session', label: 'Name', value: s.name, confirm: 'Rename' }); if (n) return app.call('session.rename', { sessionId: s.id, name: n }) } },
    { id: 'session.close', title: 'Close session', group: 'Commands', icon: 'close', run: async () => { const s = session(); if (!s) return; const panes = s.tabs.flatMap((t) => tabPaneIds(t)).map((id) => app.paneById(id)).filter(Boolean); if (await confirmClose(panes, `session “${s.name}”`)) return app.call('session.close', { sessionId: s.id }) } },
    { id: 'session.switch', title: 'Go to session…', group: 'Commands', icon: 'layers', keys: 'Ctrl+Alt+J', run: (a) => (a && (a.tabId || a.sessionId) ? switchTo(a) : openPalette({ scope: 'sessions' })) },
    // blocks
    ...BLOCKS.map((b) => ({ id: `block.${b.id}`, title: `Open ${BLOCK_TITLES[b.id] || b.id}`, group: 'Blocks', hidden: b.id === 'surface' || b.id === 'home', icon: BLOCK_ICONS[b.id] || 'box', keys: BLOCK_KEYS[b.id] || '', run: () => openBlock(b.id) })),
    { id: 'block.open', title: 'Open block', group: 'Blocks', icon: 'box', hidden: true, run: (a) => a && openBlock(a.name, a.args, a.from) },
    { id: 'file.open', title: 'Open file', group: 'Files', icon: 'file', hidden: true, run: (a) => a && a.path && openBlock('files', { path: a.path }, a.from) },
    // git
    { id: 'git.clone', title: 'Clone repository…', group: 'Git', icon: 'download', run: async () => { const u = await promptDialog({ title: 'Clone repository', label: 'Repository URL', placeholder: 'https://github.com/user/repo.git', confirm: 'Clone' }); if (u) return runInSplit(`git clone ${/\s/.test(u) ? JSON.stringify(u) : u}`, 'Cloning…') } },
    { id: 'git.init', title: 'Create repository…', group: 'Git', icon: 'plus', run: async () => { const ok = await confirmDialog({ title: 'Create a repository here?', body: shortPath(app.focusedCwd()) || 'the current folder', confirm: 'git init' }); if (ok) return runInSplit('git init', 'Creating repository…') } },
    // layout, theme, view
    { id: 'layout.pick', title: 'Change interface style…', group: 'Layout', icon: 'layout-tiles', run: layoutPicker },
    { id: 'layout.cycle', title: 'Next interface style', group: 'Layout', icon: 'layout-tiles', keys: 'Ctrl+Alt+L', run: () => set({ layout: cycle(LAYOUTS, app.settings.layout) }) },
    ...LAYOUTS.map((l) => ({ id: `layout.${l}`, title: `Layout: ${LAYOUT_NAMES[l]}`, group: 'Layout', icon: `layout-${l}`, sub: LAYOUT_DOC[l], run: () => set({ layout: l }) })),
    { id: 'theme.pick', title: 'Theme…', group: 'Theme', icon: 'palette', run: () => openThemePicker() },
    { id: 'theme.system', title: 'Appearance: System', group: 'Theme', icon: 'monitor', run: () => set({ theme: 'system' }) },
    { id: 'theme.light', title: 'Appearance: Light', group: 'Theme', icon: 'sun', run: () => set({ theme: 'light' }) },
    { id: 'theme.dark', title: 'Appearance: Dark', group: 'Theme', icon: 'moon', run: () => set({ theme: 'dark' }) },
    { id: 'theme.cycle', title: 'Cycle appearance (system, light, dark)', group: 'Theme', icon: 'sun', run: () => set({ theme: cycle(['system', 'light', 'dark'], app.settings.theme) }) },
    { id: 'view.material', title: 'Cycle material (glass, clear, solid)', group: 'View', icon: 'layers', keys: 'Ctrl+Shift+M', run: () => viaMain('material', { material: cycle(['glass', 'clear', 'solid'], app.settings.material) }) },
    { id: 'view.opacity.up', title: 'More opaque', group: 'View', icon: 'plus', keys: 'Ctrl+Shift+ArrowUp', run: () => viaMain('opacity+', { opacity: clamp((app.settings.opacity || 80) + 5, 20, 100) }) },
    { id: 'view.opacity.down', title: 'More transparent', group: 'View', icon: 'minus', keys: 'Ctrl+Shift+ArrowDown', run: () => viaMain('opacity-', { opacity: clamp((app.settings.opacity || 80) - 5, 20, 100) }) },
    { id: 'view.font.up', title: 'Larger text', group: 'View', icon: 'plus', keys: 'Ctrl+=', run: () => viaMain('font+', { font_size: clamp((app.settings.font_size || 13) + 1, 9, 28) }) },
    { id: 'view.font.down', title: 'Smaller text', group: 'View', icon: 'minus', keys: 'Ctrl+-', run: () => viaMain('font-', { font_size: clamp((app.settings.font_size || 13) - 1, 9, 28) }) },
    { id: 'view.font.reset', title: 'Reset text size', group: 'View', icon: 'refresh', keys: 'Ctrl+0', run: () => viaMain('font0', { font_size: 13 }) },
    { id: 'view.status', title: 'Toggle status bar', group: 'View', icon: 'list', run: () => set({ status_bar: !app.settings.status_bar }) },
    { id: 'view.sidebar', title: 'Toggle files sidebar', group: 'View', icon: 'sidebar', keys: 'Ctrl+Shift+E', run: () => set({ files_sidebar: !app.settings.files_sidebar }) },
    { id: 'view.sidebar.files', title: 'Sidebar: Files', group: 'View', icon: 'files', run: () => set({ files_sidebar: true, sidebar_tab: 'files' }) },
    { id: 'view.sidebar.changes', title: 'Sidebar: Changes', group: 'View', icon: 'changes', run: () => set({ files_sidebar: true, sidebar_tab: 'changes' }) },
    { id: 'view.sidebar.git', title: 'Sidebar: Git', group: 'View', icon: 'branch', run: () => set({ files_sidebar: true, sidebar_tab: 'git' }) },
    { id: 'view.tabs', title: 'Toggle vertical tabs', group: 'View', icon: 'layers', run: () => set({ tabs: app.settings.tabs === 'vertical' ? 'horizontal' : 'vertical' }) },
    { id: 'view.browser', title: 'Toggle browser pane', group: 'View', icon: 'globe', keys: 'Ctrl+Shift+B', run: () => (window.pager && window.pager.hotkey ? hk('browser') : toast('info', 'The browser pane is part of the desktop app.')) },
    { id: 'view.docs', title: 'Open docs and usage stats', group: 'View', icon: 'book', keys: 'F1', run: () => (window.pager && window.pager.hotkey ? hk('docs') : toast('info', 'Docs open in the desktop app.')) },
    { id: 'view.studio', title: 'Open bot studio', group: 'View', icon: 'bolt', keys: 'F2', run: () => (window.pager && window.pager.hotkey ? hk('studio') : toast('info', 'The bot studio opens in the desktop app.')) },
    // palette and settings
    { id: 'palette.open', title: 'Command palette', group: 'Commands', icon: 'slash', keys: 'Ctrl+Shift+P', hidden: true, run: () => (paletteOpen() ? closePalette() : openPalette({})) },
    { id: 'palette.files', title: 'Search files…', group: 'Files', icon: 'search', keys: 'Ctrl+Shift+F', run: () => openPalette({ scope: 'files' }) },
    { id: 'settings.open', title: 'Settings', group: 'Settings', icon: 'sliders', keys: 'Ctrl+,', run: () => toggleSettings() },
    ...['general', 'agents', 'appearance', 'terminal', 'databases', 'notebooks', 'keyboard', 'git', 'sessions', 'hosts', 'files'].map((p) => ({ id: `settings.${p}`, title: `Settings: ${p[0].toUpperCase()}${p.slice(1)}`, group: 'Settings', icon: 'sliders', run: () => openSettings(p) })),
    // hosts, daemon, misc
    { id: 'host.add', title: 'Add host…', group: 'Hosts', icon: 'server', run: async () => { const a = await promptDialog({ title: 'Add host', label: 'user@address', placeholder: 'me@example.com', confirm: 'Add' }); if (a) app.set({ hosts: [...(app.settings.hosts || []), { id: `h${Date.now().toString(36)}`, name: a, address: a }] }) } },
    { id: 'host.connect', title: 'Connect to host', group: 'Hosts', icon: 'server', hidden: true, run: (a) => a && a.address && newTab({ kind: 'shell', command: `ssh ${a.address}` }) },
    { id: 'daemon.restart', title: 'Restart the session daemon', group: 'Commands', icon: 'refresh', run: () => (app.d.restart ? app.d.restart() : app.call('daemon.restart', {})) },
    { id: 'daemon.quit', title: 'Quit Pager and stop the daemon', group: 'Commands', icon: 'stop', run: async () => { if (await confirmDialog({ title: 'Quit and stop every program?', body: 'Quitting stops the session daemon and all panes.', confirm: 'Quit', danger: true })) return app.d.quit ? app.d.quit() : app.call('daemon.stop', {}) } },
    { id: 'toast', title: 'Toast', group: 'Commands', hidden: true, run: (a) => a && toast(a.level || 'info', a.text || '') },
  ]
  registerCommands(cmds)
  window.addEventListener('keydown', onKey, true)
}

async function switchTo({ sessionId, tabId }) {
  let id = tabId
  if (!id) {
    const s = app.state.sessions.find((x) => x.id === sessionId)
    id = s && (s.activeTab || (s.tabs[0] && s.tabs[0].id))
  }
  if (id) return app.call('tab.activate', { tabId: id })
}

function stepTab(step) {
  const s = session()
  if (!s || s.tabs.length < 2) return
  const i = s.tabs.findIndex((t) => t.id === s.activeTab)
  const t = s.tabs[(i + step + s.tabs.length) % s.tabs.length]
  return app.call('tab.activate', { tabId: t.id })
}

const FIELD = 'input, textarea, select, [contenteditable="true"]'
function onKey(e) {
  if (e.defaultPrevented || e.isComposing) return
  const chord = chordFromEvent(e)
  if (!chord) return
  const t = e.target
  const inField = t instanceof Element && t.matches(FIELD) && !t.classList.contains('xterm-helper-textarea')
  if (inField && !e.ctrlKey && !e.metaKey && !e.altKey) return
  // Ctrl+Shift+1..9 jump to tab N
  const m = /^Ctrl\+Shift\+([1-9])$/.exec(chord)
  if (m) {
    const s = session()
    const tab = s && s.tabs[+m[1] - 1]
    e.preventDefault()
    e.stopPropagation()
    if (tab) app.call('tab.activate', { tabId: tab.id })
    return
  }
  if (chord === 'Ctrl+Shift+P' || chord === 'Ctrl+Shift+K') {
    e.preventDefault()
    e.stopPropagation()
    runCommand('palette.open')
    return
  }
  if (chord === 'Ctrl+Shift+=' || chord === 'Ctrl+=') {
    e.preventDefault()
    e.stopPropagation()
    runCommand('view.font.up')
    return
  }
  const c = commandForChord(chord)
  if (!c) return
  if (inField && c.id.startsWith('term.')) return
  e.preventDefault()
  e.stopPropagation()
  runCommand(c.id)
}
