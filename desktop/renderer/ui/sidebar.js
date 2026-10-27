// The Files sidebar: a card that follows the focused pane's working folder. Files | Changes | Git, git-coloured tree, branch strip.
import { h, baseName, clamp } from './dom.js'
import { app } from './store.js'
import { icon } from './icons.js'
import { folderLabel, shortPath } from './labels.js'
import { runCommand } from './commands.js'
import { showMenu } from './popover.js'
import { promptDialog } from './dialog.js'
import { toast } from './toast.js'

const EXT_ICON = { md: 'markdown', mdx: 'markdown', json: 'json', jsonc: 'json', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', ico: 'image', ts: 'file-code', tsx: 'file-code', js: 'file-code', jsx: 'file-code', mjs: 'file-code', cjs: 'file-code', py: 'file-code', rs: 'file-code', go: 'file-code', c: 'file-code', cpp: 'file-code', h: 'file-code', java: 'file-code', css: 'file-code', html: 'file-code', sh: 'terminal', ps1: 'terminal', toml: 'sliders', yml: 'sliders', yaml: 'sliders' }
const fileIcon = (name) => EXT_ICON[(name.split('.').pop() || '').toLowerCase()] || 'file'

const S = {
  root: '', // folder shown
  grant: '', // root granted to the files block
  sep: '/',
  open: new Set(), // expanded absolute dirs
  kids: new Map(), // dir -> entries
  status: null, // files.status result
  gitStatus: null,
  summary: null,
  log: null,
  sel: '',
  token: 0,
}
let el, head, bodyEl, footEl, segEl, nameEl
let built = false
const ID = 'sidebar'

const rpc = (block, method, args) => (app.d.block ? Promise.resolve(app.d.block(block, method, args)) : Promise.reject(new Error('no blocks')))
const join = (dir, name) => dir.replace(/[\\/]+$/, '') + S.sep + name

function build() {
  if (built) return
  built = true
  el = document.getElementById('sidebar')
  nameEl = h('span', { class: 'nm' })
  head = h(
    'div',
    { class: 'sb-head' },
    icon('folder'),
    nameEl,
    h('button', { class: 'icon-btn', type: 'button', attrs: { 'data-tip': 'New file' }, onClick: () => create('file') }, icon('file-plus')),
    h('button', { class: 'icon-btn', type: 'button', attrs: { 'data-tip': 'New folder' }, onClick: () => create('dir') }, icon('folder-plus')),
    h('button', { class: 'icon-btn', type: 'button', attrs: { 'data-tip': 'Refresh' }, onClick: () => refresh(true) }, icon('refresh')),
    h('button', { class: 'icon-btn', type: 'button', attrs: { 'data-tip': 'Hide sidebar', 'data-tip-keys': 'Ctrl+Shift+E' }, onClick: () => runCommand('view.sidebar') }, icon('sidebar')),
  )
  segEl = h(
    'div',
    { class: 'sb-seg' },
    ...[['files', 'files', 'Files'], ['changes', 'changes', 'Changes'], ['git', 'branch', 'Git']].map(([id, ic, tip]) => h('button', { type: 'button', dataset: { tab: id }, attrs: { 'data-tip': tip }, onClick: () => app.set({ sidebar_tab: id }) }, icon(ic))),
  )
  bodyEl = h('div', { class: 'sb-body' })
  footEl = h('div', { class: 'sb-foot' })
  const grip = h('div', { class: 'sb-resize' })
  el.replaceChildren(head, segEl, bodyEl, footEl, grip)
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    grip.setPointerCapture(e.pointerId)
    const left = el.getBoundingClientRect().left
    const move = (m) => document.documentElement.style.setProperty('--sidebar-w', `${clamp(m.clientX - left, 180, 560)}px`)
    const up = (m) => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      app.set({ sidebar_width: Math.round(clamp(m.clientX - left, 180, 560)) })
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
  })
  grip.style.right = '-3px'
  bodyEl.addEventListener('contextmenu', (e) => e.target === bodyEl && e.preventDefault())
}

async function setRoot(cwd) {
  const my = ++S.token
  S.root = cwd
  S.open = new Set()
  S.kids = new Map()
  S.status = S.gitStatus = S.summary = S.log = null
  S.sel = ''
  paint()
  try {
    const g = await rpc('files', 'grant', { path: cwd })
    if (my !== S.token) return
    S.grant = g.root || cwd
    S.sep = /\\/.test(g.root || cwd) ? '\\' : '/'
    if (g.home && !app.home) app.home = g.home
    rpc('files', 'watchTree', { root: S.grant, id: ID }).catch(() => {})
    await refresh(true, my)
  } catch (e) {
    if (my !== S.token) return
    S.error = e && e.message ? e.message : String(e)
    paint()
  }
}

async function loadDir(dir, my) {
  const r = await rpc('files', 'list', { dir, root: S.grant, compact: (app.settings.file_tree || {}).compact !== false })
  if (my !== undefined && my !== S.token) return
  S.kids.set(dir, r.entries || [])
}

let refreshing = 0
async function refresh(full, my = S.token) {
  if (!S.root || !S.grant) return
  const n = ++refreshing
  try {
    const dirs = [S.grant, ...Array.from(S.open)]
    await Promise.all([
      ...dirs.map((d) => loadDir(d, my).catch(() => S.kids.delete(d))),
      rpc('files', 'status', { root: S.grant }).then((s) => (S.status = s)).catch(() => (S.status = null)),
      rpc('git', 'summary', { cwd: S.root }).then((s) => (S.summary = s)).catch(() => (S.summary = null)),
      app.settings.sidebar_tab === 'changes' ? rpc('git', 'status', { cwd: S.root }).then((s) => (S.gitStatus = s)).catch(() => (S.gitStatus = null)) : null,
      app.settings.sidebar_tab === 'git' ? rpc('git', 'log', { cwd: S.root, limit: 40 }).then((s) => (S.log = s)).catch(() => (S.log = null)) : null,
    ])
    S.error = ''
  } catch (e) {
    S.error = e && e.message ? e.message : String(e)
  }
  if (n === refreshing && my === S.token) paint()
}

const relOf = (abs) => abs.slice(S.grant.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')

function gitLetter(rel, isDir) {
  const f = S.status && S.status.files
  if (!f) return ''
  if (isDir) {
    const key = rel + '/'
    if (f[key]) return f[key] === '?' ? '?' : 'm'
    for (const k in f) if (k.startsWith(key)) return 'm'
    return ''
  }
  return f[rel] || ''
}

const ignoredSet = () => new Set((S.status && S.status.ignored) || [])
const isIgnored = (rel, isDir, ig) => ig.has(rel) || ig.has(rel + '/') || (isDir === false && Array.from(ig).some((i) => i.endsWith('/') && rel.startsWith(i)))

function rows() {
  const out = []
  const ft = app.settings.file_tree || {}
  const ig = ignoredSet()
  const walk = (dir, depth) => {
    for (const e of S.kids.get(dir) || []) {
      if (ft.hidden === false && e.name.startsWith('.')) continue
      const abs = join(dir, e.target ? e.target.split('/').join(S.sep) : e.name)
      const rel = relOf(abs)
      const ignored = isIgnored(rel, e.dir, ig)
      if (ignored && ft.ignored === false) continue
      out.push({ e, abs, rel, depth, ignored })
      if (e.dir && S.open.has(abs)) walk(abs, depth + 1)
      if (out.length > 3000) return
    }
  }
  walk(S.grant, 0)
  return out
}

function treeRow(r) {
  const { e, abs, depth } = r
  const g = gitLetter(r.rel, e.dir)
  const open = e.dir && S.open.has(abs)
  const row = h(
    'div',
    { class: `tr-row${e.dir ? ' dir' : ''}${open ? ' open' : ''}${abs === S.sel ? ' sel' : ''}`, dataset: { g: r.ignored ? 'I' : g }, style: { paddingLeft: `${6 + depth * 12}px` } },
    h('span', { class: 'chev' }, e.dir ? icon('chev-right') : ''),
    h('span', { class: 'fi' }, icon(e.dir ? (open ? 'folder-open' : 'folder') : fileIcon(e.name))),
    h('span', { class: 'nm' }, e.label || e.name),
    g && g !== 'm' && !e.dir ? h('span', { class: 'gl' }, g === '?' ? 'U' : g) : g ? h('span', { class: 'gs' }) : '',
  )
  row.title = shortPath(abs)
  row.addEventListener('click', () => {
    S.sel = abs
    if (e.dir) toggle(abs)
    else {
      paint()
      runCommand('file.open', { path: abs })
    }
  })
  row.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    S.sel = abs
    showMenu({
      anchor: { x: ev.clientX, y: ev.clientY },
      items: [
        e.dir ? { label: open ? 'Collapse' : 'Expand', icon: 'folder-open', onClick: () => toggle(abs) } : { label: 'Open', icon: 'file', onClick: () => runCommand('file.open', { path: abs }) },
        e.dir ? { label: 'New terminal here', icon: 'terminal', onClick: () => runCommand('pane.split.right', { cwd: abs, kind: 'shell' }) } : null,
        { sep: true },
        { label: 'Copy path', icon: 'copy', onClick: () => navigator.clipboard.writeText(abs).catch(() => {}) },
        { label: 'Copy relative path', icon: 'copy', onClick: () => navigator.clipboard.writeText(r.rel).catch(() => {}) },
        { label: 'Reveal in file manager', icon: 'external', onClick: () => rpc('files', 'reveal', { path: abs, root: S.grant }).catch(() => {}) },
        { label: 'Rename…', icon: 'edit', onClick: () => renameEntry(abs, e.name) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: () => rpc('files', 'remove', { path: abs, root: S.grant }).then(() => refresh()).catch((x) => toast('error', x.message || String(x))) },
      ].filter(Boolean),
    })
    paint()
  })
  return row
}

async function toggle(abs) {
  if (S.open.has(abs)) S.open.delete(abs)
  else {
    S.open.add(abs)
    if (!S.kids.has(abs)) {
      try {
        await loadDir(abs)
      } catch {
        S.kids.set(abs, [])
      }
    }
  }
  paint()
}

async function create(kind) {
  if (!S.grant) return
  const dir = S.sel && S.kids.has(S.sel) ? S.sel : S.grant
  const name = await promptDialog({ title: kind === 'dir' ? 'New folder' : 'New file', label: 'Name', placeholder: kind === 'dir' ? 'folder' : 'notes.md', confirm: 'Create' })
  if (!name) return
  try {
    await rpc('files', 'create', { path: join(dir, name), root: S.grant, kind })
    S.open.add(dir)
    await refresh()
  } catch (e) {
    toast('error', e.message || String(e))
  }
}

async function renameEntry(abs, old) {
  const name = await promptDialog({ title: 'Rename', label: 'Name', value: old, confirm: 'Rename' })
  if (!name || name === old) return
  try {
    await rpc('files', 'rename', { from: abs, to: join(abs.slice(0, abs.length - old.length).replace(/[\\/]+$/, ''), name), root: S.grant })
    await refresh()
  } catch (e) {
    toast('error', e.message || String(e))
  }
}

const LETTER = (f) => (f.kind === 'untracked' ? '?' : f.kind === 'unmerged' ? 'U' : [f.index, f.worktree].find((c) => c && c !== '.') || 'M')

function paintChanges() {
  const files = (S.gitStatus && S.gitStatus.files) || []
  if (!S.summary && !S.gitStatus) return bodyEl.replaceChildren(h('div', { class: 'sb-empty' }, 'This folder is not in a git repository.'))
  if (!files.length) return bodyEl.replaceChildren(h('div', { class: 'sb-empty' }, 'No changes. The working tree is clean.'))
  const rowOf = (f) => {
    const l = LETTER(f)
    const name = baseName(f.path)
    const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '')
    const r = h('div', { class: 'ch-row', dataset: { g: l } }, h('span', { class: 'gl' }, l === '?' ? 'U' : l), h('span', { class: 'nm' }, name, dir ? h('span', { class: 'dir' }, dir) : ''))
    r.addEventListener('click', () => runCommand('file.open', { path: join(S.grant || S.root, f.path.split('/').join(S.sep)) }))
    return r
  }
  const staged = files.filter((f) => f.index && f.index !== '.' && f.kind !== 'untracked')
  const rest = files.filter((f) => !staged.includes(f))
  const out = []
  if (staged.length) out.push(h('div', { class: 'sb-sec' }, h('span', {}, 'Staged'), h('span', { class: 'mono' }, String(staged.length))), ...staged.map(rowOf))
  if (rest.length) out.push(h('div', { class: 'sb-sec' }, h('span', {}, 'Changes'), h('span', { class: 'mono' }, String(rest.length))), ...rest.map(rowOf))
  bodyEl.replaceChildren(...out)
}

function paintGit() {
  const s = S.summary
  if (!s) return bodyEl.replaceChildren(h('div', { class: 'sb-empty' }, 'This folder is not in a git repository.'))
  const commits = (S.log && S.log.commits) || []
  bodyEl.replaceChildren(
    h('div', { class: 'sb-sec' }, h('span', {}, s.branch || 'detached HEAD'), h('button', { class: 'btn sm quiet', type: 'button', onClick: () => runCommand('block.git') }, icon('branch'), 'Open Git')),
    s.upstream ? h('div', { class: 'sb-empty', style: { padding: '2px 12px 8px' } }, `${s.upstream} · ${s.ahead || 0} ahead, ${s.behind || 0} behind`) : '',
    h('div', { class: 'sb-sec' }, h('span', {}, 'Recent commits')),
    ...commits.slice(0, 40).map((c) => h('div', { class: 'gl-row', title: c.subject }, h('span', { class: 'h' }, (c.hash || '').slice(0, 7)), h('span', { class: 's' }, c.subject))),
    !commits.length ? h('div', { class: 'sb-empty' }, 'No commits yet.') : '',
  )
}

function paintFoot() {
  footEl.hidden = !!app.settings.status_bar
  if (footEl.hidden) return
  const s = S.summary
  if (!s) return footEl.replaceChildren(h('span', { class: 'ab' }, shortPath(S.root)))
  const n = s.changed ?? (s.modified || 0) + (s.staged || 0)
  footEl.replaceChildren(icon('branch'), h('span', {}, s.branch || 'HEAD'), n ? h('span', { class: 'm' }, `●${n}`) : '', s.untracked ? h('span', { class: 'u' }, `?${s.untracked}`) : '', s.ahead || s.behind ? h('span', { class: 'ab' }, `${s.ahead ? `↑${s.ahead}` : ''}${s.behind ? `↓${s.behind}` : ''}`) : '')
}

function paint() {
  if (!built || el.hidden) return
  nameEl.textContent = folderLabel(S.root) || 'Files'
  nameEl.title = S.root
  const tab = app.settings.sidebar_tab || 'files'
  for (const b of segEl.children) b.classList.toggle('on', b.dataset.tab === tab)
  head.querySelectorAll('.icon-btn').forEach((b, i) => (b.hidden = tab !== 'files' && i < 3))
  if (!S.root) bodyEl.replaceChildren(h('div', { class: 'sb-empty' }, 'Focus a terminal to browse its folder.'))
  else if (S.error) bodyEl.replaceChildren(h('div', { class: 'sb-empty' }, `Cannot read this folder: ${S.error}`))
  else if (tab === 'changes') paintChanges()
  else if (tab === 'git') paintGit()
  else if (!S.kids.has(S.grant)) bodyEl.replaceChildren(h('div', { class: 'sb-empty' }, 'Loading…'))
  else {
    const rs = rows()
    bodyEl.replaceChildren(...(rs.length ? rs.map(treeRow) : [h('div', { class: 'sb-empty' }, 'This folder is empty.')]))
  }
  paintFoot()
}

let followTimer = 0
function follow() {
  clearTimeout(followTimer)
  followTimer = setTimeout(() => {
    if (!app.settings.files_sidebar) return
    const cwd = app.focusedCwd()
    if (cwd && cwd !== S.root) setRoot(cwd)
  }, 60)
}

function applyVisibility() {
  build()
  const on = !!app.settings.files_sidebar
  el.hidden = !on
  document.documentElement.style.setProperty('--sidebar-w', `${app.settings.sidebar_width || 260}px`)
  document.documentElement.classList.toggle('sidebar-open', on)
  if (on) {
    const cwd = app.focusedCwd()
    if (cwd && cwd !== S.root) setRoot(cwd)
    else paint()
    if (S.root && S.grant) refresh()
  }
}

export function initSidebar() {
  build()
  applyVisibility()
  app.on('settings', (p) => {
    if ('files_sidebar' in p) applyVisibility()
    else if ('sidebar_tab' in p) refresh().then(paint)
    else if ('sidebar_width' in p) document.documentElement.style.setProperty('--sidebar-w', `${app.settings.sidebar_width}px`)
    else if ('file_tree' in p) refresh()
  })
  app.on('state', follow)
  app.on('focus', follow)
  app.on('panes', follow)
  if (app.d.onBlock) {
    let t = 0
    app.d.onBlock('files', (ev, payload) => {
      if (ev === 'tree' && payload && payload.id === ID) {
        clearTimeout(t)
        t = setTimeout(() => app.settings.files_sidebar && refresh(), 200)
      }
    })
    app.d.onBlock('git', () => {
      clearTimeout(t)
      t = setTimeout(() => app.settings.files_sidebar && refresh(), 300)
    })
  }
  window.addEventListener('focus', () => app.settings.files_sidebar && refresh())
}
