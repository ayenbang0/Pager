// The status line (settings.status_bar): folder, git, run state and terminal size of the focused pane.
import { h } from './dom.js'
import { app } from './store.js'
import { icon } from './icons.js'
import { shortPath, paneLabel } from './labels.js'

let el
let gitFor = ''
let git = null
let timer = 0

function paint() {
  if (!el || el.hidden) return
  const p = app.focusedPane()
  if (!p) return el.replaceChildren()
  const info = app.paneInfo.get(p.id) || {}
  const n = git ? (git.changed ?? (git.modified || 0) + (git.staged || 0)) : 0
  const st = p.state === 'exited' ? h('span', { class: p.exitCode ? 'bad' : 'ok' }, p.exitCode ? `exit ${p.exitCode}` : 'exited') : p.state === 'restored' ? h('span', {}, 'restored') : h('span', {}, h('i', { class: 'live' }), 'running')
  el.replaceChildren(
    h('span', { class: 'cwd', title: p.cwd }, shortPath(p.cwd) || paneLabel(p)),
    git ? h('span', { class: 'sl-git' }, icon('branch', 12), ' ', git.branch || 'HEAD', n ? h('span', { class: 'm' }, ` ●${n}`) : '', git.untracked ? ` ?${git.untracked}` : '', git.ahead ? ` ↑${git.ahead}` : '', git.behind ? ` ↓${git.behind}` : '') : '',
    h('span', { class: 'sp' }),
    st,
    p.pid ? h('span', {}, `pid ${p.pid}`) : '',
    info.cols ? h('span', {}, `${info.cols}×${info.rows}`) : '',
  )
}

function loadGit() {
  const p = app.focusedPane()
  const cwd = p && p.cwd
  if (!cwd || !app.d.block) return
  Promise.resolve(app.d.block('git', 'summary', { cwd }))
    .then((g) => {
      if (app.focusedCwd() !== cwd) return
      git = g || null
      gitFor = cwd
      paint()
    })
    .catch(() => {
      git = null
      paint()
    })
}

function sync() {
  const p = app.focusedPane()
  const cwd = (p && p.cwd) || ''
  if (cwd !== gitFor) {
    gitFor = cwd
    git = null
    clearTimeout(timer)
    timer = setTimeout(loadGit, 120)
  }
  paint()
}

export function initStatusbar() {
  el = document.getElementById('statusline')
  const apply = () => {
    el.hidden = !app.settings.status_bar
    if (!el.hidden) {
      gitFor = ''
      sync()
      loadGit()
    }
  }
  apply()
  app.on('settings', (p) => 'status_bar' in p && apply())
  app.on('state', sync)
  app.on('focus', sync)
  app.on('titles', paint)
  setInterval(() => !el.hidden && loadGit(), 8000)
}
