// How panes and tabs are named and drawn in the chrome (tab pills, headers, status line, palette).
import { app, isBlock, blockName } from './store.js'
import { baseName } from './dom.js'

export const AGENT_KINDS = ['omp', 'claude', 'opencode', 'hermes', 'custom']
export const isAgent = (pane) => !!pane && AGENT_KINDS.includes(pane.kind)

const HOME_RE = /^([A-Za-z]:[\\/]Users[\\/][^\\/]+|\/home\/[^/]+|\/Users\/[^/]+)(?=[\\/]|$)/

/** The user's home folder as far as a path reveals it ('' if it is not under one). */
export const homeOf = (p) => (app.home || (HOME_RE.exec(p || '') || [''])[0] || '').replace(/[\\/]+$/, '')

/** `C:\Users\me\code\x` -> `~/code/x` (forward slashes, display only). */
export function shortPath(p) {
  if (!p) return ''
  const n = p.replace(/\\/g, '/')
  const hm = homeOf(p).replace(/\\/g, '/')
  if (hm && (n === hm || n.startsWith(hm + '/'))) return '~' + n.slice(hm.length)
  return n
}

export const folderLabel = (cwd) => {
  const s = shortPath(cwd)
  return s === '~' || s === '' ? s || '~' : baseName(s)
}

export const BLOCK_TITLES = { home: 'Home', files: 'Files', git: 'Git', database: 'Database', notebook: 'Notebook', board: 'Board', tasks: 'Tasks', screen: 'Screen', canvas: 'Canvas', chats: 'Chats' }
export const BLOCK_ICONS = { home: 'pager', files: 'files', git: 'branch', database: 'database', notebook: 'notebook', board: 'board', tasks: 'tasks', screen: 'screen', canvas: 'grid', chats: 'chat' }

export function paneLabel(pane) {
  if (!pane) return ''
  const info = app.paneInfo.get(pane.id)
  if (info && info.title) return info.title
  if (isBlock(pane)) return BLOCK_TITLES[blockName(pane)] || blockName(pane)
  if (pane.kind === 'shell' || pane.kind === 'custom') return folderLabel(pane.cwd) || pane.title || 'shell'
  return pane.title || pane.kind
}

/** Icon name for a pane kind (icons.js). */
export function paneGlyph(pane) {
  if (!pane) return 'terminal'
  if (isBlock(pane)) return BLOCK_ICONS[blockName(pane)] || 'box'
  return pane.kind === 'pager' ? 'pager' : 'terminal'
}

function firstLeaf(n) {
  while (n && n.type !== 'pane') n = n.a
  return n ? n.paneId : null
}

export function tabLabel(tab) {
  if (!tab) return ''
  const pane = app.paneById(tab.focus) || app.paneById(tab.root && firstLeaf(tab.root))
  // A title the user set (tab.rename) wins; the daemon's own defaults follow the focused pane instead.
  const t = tab.title || ''
  const dflt = !t || /^(tab|shell|pager|omp|claude|opencode|hermes)\s*\d*$/i.test(t) || (pane && (t === pane.title || t === pane.kind))
  if (!dflt) return t
  return pane ? paneLabel(pane) : t || 'tab'
}
