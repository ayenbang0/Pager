// The git block: branch/tag chips, commit graph with lanes, the working-tree row, commit search, commit detail with
// diffs, line-level staging (git apply --cached), undo/redo and the commit box. The main-process half is
// desktop/electron/blocks/git.cjs; this file only renders and orchestrates. `mountChanges` is the compact sidebar view.
import { h, rafThrottle, uid } from '../ui/dom.js'
import { createDiffView } from './gitdiff.js'
import { highlightParts, initials, avatarHue, layoutGraph, parseDecoration, relativeTime, WIP, withWorkingTree } from './gitgraph.js'
import { buildPatch, parseDiff } from './gitpatch.js'
import { icon, iconSvg } from './giticons.js'
import { announce, dirty, errorText, fullDate, onAnnounce, plural, splitPath, splitStatus, STATUS_NAME, statusClass, subscribe, trackText } from './gitmodel.js'
import { createOverlay } from './gitui.js'

export { mountChanges } from './gitchanges.js'

const ROW_H = 28
const LANE_W = 16
const PAGE = 300
const MAX_COMMITS = 20000
const OVERSCAN = 8
const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
const COMMIT_KEYS = isMac ? '\u2318\u23CE' : 'Ctrl \u23CE'

const svgNS = 'http://www.w3.org/2000/svg'
function svg(tag, attrs, ...kids) {
  const e = document.createElementNS(svgNS, tag)
  for (const k in attrs) e.setAttribute(k, attrs[k])
  for (const c of kids) c && e.append(c)
  return e
}

const keep = (kids) => kids.flat().filter((k) => k !== null && k !== undefined && k !== false)
/** el.append(...kids) that skips null/false (native append would print "null"). */
const put = (el, ...kids) => el.append(...keep(kids))
const fill = (el, ...kids) => el.replaceChildren(...keep(kids))

const laneColor = (i) => `var(--gl${i % 8})`
const laneX = (lane) => 10 + lane * LANE_W

/** One row's graph cell: lane lines plus the node (avatar for a commit, small dot for a merge, dashed ring for the working tree). */
function graphCell(row, commit, lanes, selected) {
  const w = Math.max(lanes, 1) * LANE_W + 8
  const mid = ROW_H / 2
  const s = svg('svg', { class: 'gt-g', width: w, height: ROW_H, viewBox: `0 0 ${w} ${ROW_H}` })
  const line = (d, color) => s.append(svg('path', { d, stroke: laneColor(color), class: 'gt-gl', fill: 'none' }))
  const nx = laneX(row.lane)
  for (const p of row.pass) line(`M${laneX(p.lane)} -1V${ROW_H + 1}`, p.color)
  for (const u of row.up) {
    const x = laneX(u.lane)
    line(x === nx ? `M${x} -1V${mid}` : `M${x} -1C${x} ${mid * 0.55} ${nx} ${mid * 0.45} ${nx} ${mid}`, u.color)
  }
  for (const d of row.down) {
    const x = laneX(d.lane)
    line(x === nx ? `M${nx} ${mid}V${ROW_H + 1}` : `M${nx} ${mid}C${nx} ${mid + (ROW_H - mid) * 0.55} ${x} ${mid + (ROW_H - mid) * 0.45} ${x} ${ROW_H + 1}`, d.color)
  }
  const color = laneColor(row.color)
  if (commit.wip) {
    s.append(svg('circle', { cx: nx, cy: mid, r: 6, class: 'gt-node-wip', stroke: color }))
  } else if (commit.parents.length > 1) {
    s.append(svg('circle', { cx: nx, cy: mid, r: 4.5, class: 'gt-node-merge', fill: color }))
  } else {
    const hue = avatarHue(commit.email || commit.author || '')
    const g = svg('g', { class: 'gt-node' })
    g.append(svg('circle', { cx: nx, cy: mid, r: 9, class: 'gt-av', style: `--hue:${hue}`, stroke: color }))
    const t = svg('text', { x: nx, y: mid + 0.5, class: 'gt-av-t', style: `--hue:${hue}` })
    t.textContent = initials(commit.author, commit.email)
    g.append(t)
    s.append(g)
  }
  if (selected) s.classList.add('sel')
  return s
}

function avatar(name, email, size = 22) {
  const hue = avatarHue(email || name || '')
  return h('span', { class: 'gt-avatar', style: { '--hue': hue, width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` }, title: `${name || ''}${email ? ` <${email}>` : ''}` }, initials(name, email))
}

function refChip(c, color, onDblclick) {
  const cls = `gt-ref ${c.type}${c.current ? ' current' : ''}`
  const ico = c.current ? icon('check') : c.type === 'remote' ? icon('globe') : c.type === 'tag' ? icon('tag') : null
  const b = h('span', { class: cls, style: { '--c': c.type === 'tag' ? 'var(--warn)' : color }, title: c.type === 'remote' ? `Remote branch ${c.name}` : c.type === 'tag' ? `Tag ${c.name}` : c.current ? `Current branch ${c.name}` : `Branch ${c.name}`, dataset: { ref: c.name, type: c.type } }, ico, h('span', { class: 'gt-ref-n' }, c.name))
  if (onDblclick) b.addEventListener('dblclick', (e) => (e.stopPropagation(), onDblclick(c)))
  return b
}

export default {
  id: 'git',
  title: 'Git',
  icon: iconSvg('branch'),
  hotkey: 'Ctrl+Alt+G',
  /**
   * args (JSON from the pane's `command`, or ctx.args): { cwd?, path?, staged? } to open on a working-tree file.
   */
  mount(el, ctx) {
    return mountGit(el, ctx)
  },
}

function mountGit(el, ctx) {
  const args = ctx.args && typeof ctx.args === 'object' ? ctx.args : {}
  const toast = (level, text) => (ctx.toast ? ctx.toast(level, text) : console.log(`[git] ${level}: ${text}`))
  const startCwd = args.cwd || (typeof ctx.cwd === 'function' ? ctx.cwd() : ctx.cwd) || ''

  // ------------------------------------------------------------------ state
  const S = {
    cwd: startCwd,
    repo: null, // open() result
    status: null,
    refs: { branches: [], remotes: [], tags: [], stashes: [], remoteNames: [] },
    commits: [],
    hasMore: false,
    loadingMore: false,
    layout: null, // { rows, width }
    all: [], // commits incl. the working-tree row
    index: new Map(),
    sel: { kind: 'wip' },
    wipFile: args.path ? { path: args.path, staged: !!args.staged } : null,
    commitFile: null, // path
    detail: null, // commit() result of the selected commit
    undo: { undo: null, redo: null },
    busy: new Map(), // tool name -> opId
    search: { open: false, q: '', hits: [], at: -1, scanning: false },
    error: '',
    loading: true,
  }
  let disposed = false
  let loadToken = 0
  let focusedRow = null
  const detailCache = new Map()

  const rpc = (method, a = {}) => ctx.rpc(method, { cwd: S.repo?.root ?? S.cwd, ...a })
  const fail = (e) => toast('error', errorText(e))

  // ------------------------------------------------------------------ skeleton
  const root = h('div', { class: 'gt gt-block', tabIndex: -1 })
  el.replaceChildren(root)
  const overlay = createOverlay(root)

  const branchBtn = h('button', { class: 'gt-branch-btn', title: 'Switch branch', onClick: () => openBranchPicker() })
  const trackEl = h('span', { class: 'gt-track' })
  const tools = h('div', { class: 'gt-tools' })
  const bar = h('div', { class: 'gt-bar' }, icon('branch', 'gt-bar-ico'), branchBtn, trackEl, h('span', { class: 'gt-grow' }), tools)

  const searchInput = h('input', {
    class: 'gt-search-input',
    type: 'text',
    placeholder: 'Search commits by subject, author or hash',
    spellcheck: false,
    onInput: () => runSearch(searchInput.value),
    onKeydown: (e) => {
      if (e.key === 'Enter') (e.preventDefault(), stepSearch(e.shiftKey ? -1 : 1))
      else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), closeSearch())
    },
  })
  const searchCount = h('span', { class: 'gt-search-count' })
  const searchBar = h(
    'div',
    { class: 'gt-search', hidden: true },
    icon('search'),
    searchInput,
    searchCount,
    h('button', { class: 'gt-ibtn', title: 'Previous match (Shift+Enter)', onClick: () => stepSearch(-1) }, icon('chevD', 'up')),
    h('button', { class: 'gt-ibtn', title: 'Next match (Enter)', onClick: () => stepSearch(1) }, icon('chevD')),
    h('button', { class: 'gt-ibtn', title: 'Close (Esc)', onClick: () => closeSearch() }, icon('x')),
  )

  const colHead = h('div', { class: 'gt-colhead' }, h('span', { class: 'gt-c-refs' }, 'Branch / Tag'), h('span', { class: 'gt-c-graph' }, 'Graph'), h('span', { class: 'gt-c-msg' }, 'Commit message'))
  const rowsEl = h('div', { class: 'gt-rows' })
  const scroller = h('div', { class: 'gt-scroll', tabIndex: 0, role: 'listbox', 'aria-label': 'Commits' }, rowsEl)
  const graphFoot = h('div', { class: 'gt-graph-foot', hidden: true })
  const graphPane = h('div', { class: 'gt-graph' }, colHead, scroller, graphFoot)

  const splitter = h('div', { class: 'gt-splitter', role: 'separator', 'aria-orientation': 'horizontal', title: 'Drag to resize' })
  const detailEl = h('div', { class: 'gt-detail' })
  const main = h('div', { class: 'gt-main' }, graphPane, splitter, detailEl)
  const emptyEl = h('div', { class: 'gt-empty', hidden: true })
  root.append(bar, searchBar, main, emptyEl)

  // ------------------------------------------------------------------ toolbar
  const TOOLS = [
    { id: 'fetch', icon: 'fetch', title: 'Fetch from all remotes', run: () => netOp('fetch', 'fetch', 'Fetched') },
    { id: 'pull', icon: 'pull', title: 'Pull (fast-forward only)', run: () => netOp('pull', 'pull', 'Pulled') },
    { id: 'push', icon: 'push', title: 'Push', run: () => netOp('push', 'push', 'Pushed') },
    { id: 'undo', icon: 'undo', title: 'Undo', run: () => undoRedo('undo') },
    { id: 'redo', icon: 'redo', title: 'Redo', run: () => undoRedo('redo') },
    { id: 'stash', icon: 'stash', title: 'Stash', run: (e) => stashMenu(e.currentTarget) },
    { id: 'search', icon: 'search', title: 'Search commits (Ctrl+F)', run: () => openSearch() },
    { id: 'more', icon: 'more', title: 'More', run: (e) => moreMenu(e.currentTarget) },
  ]
  const toolEls = new Map()
  for (const t of TOOLS) {
    const b = h('button', { class: 'gt-tool', title: t.title, onClick: (e) => t.run(e) }, icon(t.icon))
    toolEls.set(t.id, b)
    tools.append(b)
    if (t.id === 'push' || t.id === 'redo') tools.append(h('span', { class: 'gt-tsep' }))
  }

  function renderBar() {
    const repo = S.repo
    const b = S.status?.branch
    if (!repo) {
      branchBtn.replaceChildren(h('span', { class: 'gt-branch-name' }, S.loading ? 'Loading\u2026' : 'No repository'))
      branchBtn.disabled = true
      trackEl.textContent = ''
    } else {
      branchBtn.disabled = false
      const name = b ? (b.head ?? (b.oid ? `detached @ ${b.oid.slice(0, 7)}` : 'no commits yet')) : (repo.branch ?? '')
      branchBtn.replaceChildren(h('span', { class: 'gt-branch-name' }, name), icon('chevD', 'gt-caret'))
      branchBtn.title = b?.upstream ? `${name} \u2192 ${b.upstream}\nSwitch branch` : 'Switch branch'
      trackEl.textContent = b ? trackText(b) : ''
      trackEl.title = b?.upstream ? `${b.ahead} ahead, ${b.behind} behind ${b.upstream}` : ''
    }
    const disabled = !repo
    for (const t of TOOLS) {
      const el$ = toolEls.get(t.id)
      const busy = S.busy.has(t.id)
      el$.disabled = disabled && t.id !== 'more' || (!!S.busy.size && !busy && (t.id === 'fetch' || t.id === 'pull' || t.id === 'push'))
      el$.classList.toggle('busy', busy)
      el$.classList.toggle('on', t.id === 'search' && S.search.open)
      el$.replaceChildren(icon(busy ? 'spinner' : t.icon))
      let title = t.title
      if (busy && S.busy.get(t.id)) title = 'Working\u2026 click to cancel'
      if (t.id === 'undo') {
        el$.disabled = disabled || !S.undo.undo || S.busy.size > 0
        title = S.undo.undo ? `Undo: ${S.undo.undo}` : 'Nothing to undo'
      } else if (t.id === 'redo') {
        el$.disabled = disabled || !S.undo.redo || S.busy.size > 0
        title = S.undo.redo ? `Redo: ${S.undo.redo}` : 'Nothing to redo'
      } else if (t.id === 'push' && b && !b.upstream && b.head) title = 'Push and set upstream'
      el$.title = title
    }
  }

  // ------------------------------------------------------------------ loading
  async function resolveRepo() {
    const r = await ctx.rpc('open', { cwd: S.cwd })
    if (!r.ok) {
      S.repo = null
      S.error = r.error || 'not a git repository'
      return false
    }
    S.repo = r
    S.error = ''
    return true
  }

  let refreshing = false
  let again = false
  /** Reloads status, refs and the loaded part of the history. */
  async function refresh() {
    if (disposed) return
    if (refreshing) {
      again = true
      return
    }
    refreshing = true
    const mine = ++loadToken
    try {
      if (!S.repo && !(await resolveRepo())) {
        S.status = null
        S.commits = []
        S.layout = null
        S.all = []
        S.loading = false
        render()
        return
      }
      const want = Math.min(Math.max(S.commits.length, PAGE), MAX_COMMITS)
      const [status, refs, log] = await Promise.all([rpc('status'), rpc('refs'), rpc('log', { limit: want })])
      if (disposed || mine !== loadToken) return
      S.status = status
      S.refs = refs
      S.commits = log.commits
      S.hasMore = !!log.hasMore
      S.undo = status.undo ?? S.undo
      S.loading = false
      S.error = ''
      detailCache.clear()
      relayout()
      pickAfterStatus()
      render()
      if (S.search.open && S.search.q) runSearch(S.search.q, true)
      loadSelection()
    } catch (e) {
      if (disposed) return
      S.loading = false
      if (/not a git repository|does not exist/i.test(errorText(e))) {
        S.repo = null
        S.error = errorText(e)
        render()
      } else fail(e)
    } finally {
      refreshing = false
      if (again) {
        again = false
        refresh()
      }
    }
  }

  function relayout() {
    const head = S.status?.branch.oid ?? null
    S.all = withWorkingTree(S.commits, head)
    S.layout = layoutGraph(S.all)
    S.index = new Map(S.all.map((c, i) => [c.hash, i]))
    const cells = Math.max(S.layout.width, 1)
    root.style.setProperty('--gt-graph-w', `${Math.max(64, Math.min(cells, 14) * LANE_W + 24)}px`)
  }

  async function loadMore(all = false) {
    if (S.loadingMore || !S.hasMore || S.commits.length >= MAX_COMMITS) return
    S.loadingMore = true
    graphFootRender()
    try {
      do {
        const log = await rpc('log', { limit: PAGE, skip: S.commits.length })
        if (disposed) return
        S.commits = S.commits.concat(log.commits)
        S.hasMore = !!log.hasMore
      } while (all && S.hasMore && S.commits.length < MAX_COMMITS)
      relayout()
      renderRows()
    } catch (e) {
      fail(e)
    } finally {
      S.loadingMore = false
      graphFootRender()
    }
  }

  /** After a status reload: keep the selection valid. */
  function pickAfterStatus() {
    if (S.sel.kind === 'commit' && !S.index.has(S.sel.hash)) S.sel = { kind: 'wip' }
    if (S.sel.kind !== 'wip' || !S.status) return
    const { staged, unstaged } = splitStatus(S.status.files)
    const cur = S.wipFile
    const found = cur && (cur.staged ? staged : unstaged).some((f) => f.path === cur.path)
    if (found) return
    const other = cur && (cur.staged ? unstaged : staged).find((f) => f.path === cur.path)
    if (other) S.wipFile = { path: other.path, staged: !cur.staged }
    else if (unstaged.length) S.wipFile = { path: unstaged[0].path, staged: false }
    else if (staged.length) S.wipFile = { path: staged[0].path, staged: true }
    else S.wipFile = null
  }

  // ------------------------------------------------------------------ rendering: graph
  const winState = { start: -1, end: -1, rev: 0 }

  function rowEl(i) {
    const c = S.all[i]
    const row = S.layout.rows[i]
    const selected = c.wip ? S.sel.kind === 'wip' : S.sel.kind === 'commit' && S.sel.hash === c.hash
    const el$ = h('div', { class: 'gt-row' + (c.wip ? ' wip' : '') + (selected ? ' sel' : '') + (c.hash === S.status?.branch.oid ? ' head' : ''), role: 'option', 'aria-selected': selected, style: { transform: `translateY(${i * ROW_H}px)`, '--c': laneColor(row.color) }, dataset: { i, hash: c.hash } })
    // refs cell
    const refs = h('span', { class: 'gt-c-refs gt-cell-refs' })
    if (!c.wip) {
      const chips = parseDecoration(c.refs, S.refs.remoteNames)
      const shown = chips.slice(0, 2)
      for (const ch of shown) refs.append(refChip(ch, laneColor(row.color), (x) => checkoutRef(x)))
      if (chips.length > shown.length) refs.append(h('span', { class: 'gt-ref more', title: chips.slice(2).map((x) => x.name).join('\n') }, `+${chips.length - 2}`))
    }
    const msg = h('span', { class: 'gt-c-msg gt-cell-msg' })
    if (c.wip) {
      const st = S.status
      msg.append(h('span', { class: 'gt-subj wip' }, 'Working tree'))
      if (st && dirty(st)) {
        if (st.staged) msg.append(h('span', { class: 'gt-pill ok' }, `${st.staged} staged`))
        const un = st.modified + st.untracked
        if (un) msg.append(h('span', { class: 'gt-pill warn' }, `${un} unstaged`))
        if (st.conflicted) msg.append(h('span', { class: 'gt-pill bad' }, `${st.conflicted} conflicted`))
      } else msg.append(h('span', { class: 'gt-dim' }, 'clean'))
    } else {
      const subj = h('span', { class: 'gt-subj' })
      if (S.search.open && S.search.q) for (const p of highlightParts(c.subject, S.search.q)) subj.append(p.hit ? h('mark', {}, p.text) : p.text)
      else subj.textContent = c.subject
      msg.append(subj, h('span', { class: 'gt-meta' }, h('span', { class: 'gt-meta-a' }, c.author), h('span', { class: 'gt-meta-t', title: fullDate(c.time) }, relativeTime(c.time))))
      if (S.search.hits.length && S.search.hits[S.search.at] === i) el$.classList.add('hit')
    }
    el$.append(refs, h('span', { class: 'gt-c-graph gt-cell-graph' }, graphCell(row, c, S.layout.width, selected)), msg)
    return el$
  }

  const renderRows = () => {
    winState.start = -1 // force
    paintWindow()
  }

  function paintWindow() {
    if (!S.layout) return
    const total = S.all.length
    rowsEl.style.height = `${total * ROW_H}px`
    const top = scroller.scrollTop
    const vh = scroller.clientHeight || 400
    const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN)
    const end = Math.min(total, Math.ceil((top + vh) / ROW_H) + OVERSCAN)
    if (start === winState.start && end === winState.end) return
    winState.start = start
    winState.end = end
    const frag = document.createDocumentFragment()
    for (let i = start; i < end; i++) frag.append(rowEl(i))
    rowsEl.replaceChildren(frag)
    if (focusedRow !== null) {
      const f = rowsEl.querySelector(`[data-i="${focusedRow}"]`)
      f?.classList.add('focus')
    }
    if (end >= total - 40 && S.hasMore && !S.loadingMore && !S.search.scanning) loadMore()
  }
  scroller.addEventListener('scroll', rafThrottle(paintWindow), { passive: true })

  function graphFootRender() {
    graphFoot.hidden = !(S.loadingMore || (S.hasMore && S.commits.length >= MAX_COMMITS))
    graphFoot.textContent = S.loadingMore ? 'Loading more history\u2026' : S.hasMore ? `Showing the newest ${S.commits.length.toLocaleString()} commits` : ''
  }

  function scrollToRow(i, center = false) {
    const y = i * ROW_H
    const vh = scroller.clientHeight
    if (center) scroller.scrollTop = Math.max(0, y - vh / 2 + ROW_H / 2)
    else if (y < scroller.scrollTop) scroller.scrollTop = y
    else if (y + ROW_H > scroller.scrollTop + vh) scroller.scrollTop = y + ROW_H - vh
    paintWindow()
  }

  rowsEl.addEventListener('pointerdown', (e) => {
    const r = e.target.closest('.gt-row')
    if (!r || e.button !== 0) return
    if (e.target.closest('.gt-ref')) return
    selectIndex(+r.dataset.i)
  })
  rowsEl.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.gt-row')
    if (!r) return
    e.preventDefault()
    const i = +r.dataset.i
    selectIndex(i)
    const c = S.all[i]
    if (c.wip) return
    commitMenu({ x: e.clientX, y: e.clientY }, c)
  })
  scroller.addEventListener('keydown', (e) => {
    const cur = S.sel.kind === 'wip' ? 0 : (S.index.get(S.sel.hash) ?? 0)
    let n = cur
    const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 1)
    if (e.key === 'ArrowDown') n = cur + 1
    else if (e.key === 'ArrowUp') n = cur - 1
    else if (e.key === 'PageDown') n = cur + page
    else if (e.key === 'PageUp') n = cur - page
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = S.all.length - 1
    else return
    e.preventDefault()
    selectIndex(Math.max(0, Math.min(S.all.length - 1, n)), true)
  })

  function selectIndex(i, scroll = false) {
    const c = S.all[i]
    if (!c) return
    S.sel = c.wip ? { kind: 'wip' } : { kind: 'commit', hash: c.hash }
    if (c.wip) pickAfterStatus()
    else S.commitFile = null
    if (scroll) scrollToRow(i)
    renderRows()
    renderDetail()
    loadSelection()
  }

  // ------------------------------------------------------------------ search
  function matches(c, q) {
    return c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || c.hash.startsWith(q) || (c.refs || '').toLowerCase().includes(q)
  }
  async function runSearch(q, keep = false) {
    S.search.q = q
    const needle = q.trim().toLowerCase()
    if (needle && S.hasMore && !S.search.scanning) {
      S.search.scanning = true
      searchCount.textContent = 'Searching\u2026'
      await loadMore(true)
      S.search.scanning = false
      if (S.search.q.trim().toLowerCase() !== needle) return runSearch(S.search.q)
    }
    S.search.hits = needle ? S.all.flatMap((c, i) => (!c.wip && matches(c, needle) ? [i] : [])) : []
    if (!keep) S.search.at = S.search.hits.length ? 0 : -1
    else S.search.at = Math.min(S.search.at, S.search.hits.length - 1)
    updateSearchCount()
    renderRows()
    if (S.search.at >= 0 && !keep) selectIndex(S.search.hits[S.search.at], false), scrollToRow(S.search.hits[S.search.at], true)
  }
  function updateSearchCount() {
    const n = S.search.hits.length
    searchCount.textContent = !S.search.q.trim() ? '' : n ? `${S.search.at + 1} of ${n}` : 'No matches'
    searchCount.classList.toggle('none', !!S.search.q.trim() && !n)
  }
  function stepSearch(dir) {
    const n = S.search.hits.length
    if (!n) return
    S.search.at = (S.search.at + dir + n) % n
    updateSearchCount()
    const i = S.search.hits[S.search.at]
    selectIndex(i, false)
    scrollToRow(i, true)
  }
  function openSearch() {
    S.search.open = true
    searchBar.hidden = false
    renderBar()
    searchInput.focus()
    searchInput.select()
    if (S.search.q) runSearch(S.search.q, true)
  }
  function closeSearch() {
    S.search.open = false
    searchBar.hidden = true
    S.search.hits = []
    S.search.at = -1
    renderBar()
    renderRows()
    scroller.focus()
  }

  // ------------------------------------------------------------------ operations
  /** Runs a mutating call, reports errors, announces the change to sibling views and reloads. */
  async function mutateOp(fn, okText) {
    try {
      const r = await fn()
      if (r && r.undo) S.undo = r.undo
      if (okText) toast('info', okText)
      return r
    } catch (e) {
      fail(e)
      return null
    } finally {
      announce(S.repo?.root, S)
      await refresh()
    }
  }

  async function netOp(id, method, done) {
    if (S.busy.has(id)) {
      const opId = S.busy.get(id)
      if (opId) ctx.rpc('cancel', { id: opId }).catch(() => {})
      return
    }
    const opId = uid('op')
    S.busy.set(id, opId)
    renderBar()
    try {
      const r = await rpc(method, { opId })
      const text = r && r.output ? String(r.output).split('\n').filter(Boolean).slice(-1)[0] : ''
      toast('info', text && text.length < 120 ? `${done}: ${text}` : done)
    } catch (e) {
      if (!/cancelled/.test(errorText(e))) fail(e)
    } finally {
      S.busy.delete(id)
      announce(S.repo?.root, S)
      await refresh()
      renderBar()
    }
  }

  async function undoRedo(kind) {
    if (S.busy.size) return
    S.busy.set(kind, null)
    renderBar()
    try {
      const r = await rpc(kind)
      S.undo = { undo: r.undo, redo: r.redo }
      toast('info', `${kind === 'undo' ? 'Undid' : 'Redid'}: ${r.label}`)
    } catch (e) {
      fail(e)
    } finally {
      S.busy.delete(kind)
      announce(S.repo?.root, S)
      await refresh()
      renderBar()
    }
  }

  async function checkoutRef(c) {
    const track = c.type === 'remote'
    if (c.current) return
    if (c.type === 'remote') {
      // A remote branch with a local branch of the same name: just switch to that one.
      const local = c.name.slice(c.name.indexOf('/') + 1)
      const has = S.refs.branches.some((b) => b.name === local)
      return mutateOp(() => rpc('checkout', has ? { ref: local } : { ref: c.name, track: true }), `Switched to ${local}`)
    }
    return mutateOp(() => rpc('checkout', { ref: c.name, track: false }), c.type === 'tag' ? `Checked out tag ${c.name} (detached HEAD)` : `Switched to ${c.name}`)
  }

  async function newBranch(from, label = 'New branch') {
    const v = await overlay.dialog({ title: label, text: from ? `Starts at ${from.length > 24 ? from.slice(0, 8) : from}.` : 'Starts at the current commit and switches to it.', fields: [{ name: 'name', label: 'Branch name', placeholder: 'feature/name' }], ok: 'Create branch' })
    if (!v) return
    await mutateOp(() => rpc('createBranch', { name: v.name, from: from || undefined }), `Created ${v.name}`)
  }
  async function newTag(hash) {
    const v = await overlay.dialog({ title: 'Create tag', text: hash ? `At ${hash.slice(0, 8)}.` : 'At the current commit.', fields: [{ name: 'name', label: 'Tag name', placeholder: 'v1.0.0' }], ok: 'Create tag' })
    if (!v) return
    await mutateOp(() => rpc('createTag', { name: v.name, hash: hash || undefined }), `Tagged ${v.name}`)
  }
  async function deleteBranch(name) {
    const ok = await overlay.dialog({ title: `Delete branch ${name}?`, text: 'Git refuses when the branch has unmerged commits.', ok: 'Delete', danger: true })
    if (!ok) return
    await mutateOp(() => rpc('deleteBranch', { name }), `Deleted ${name}`)
  }

  function commitMenu(anchor, c) {
    const chips = parseDecoration(c.refs, S.refs.remoteNames)
    const items = [
      { label: 'Check out this commit', icon: 'check', onClick: () => mutateOp(() => rpc('checkout', { ref: c.hash }), `Checked out ${c.hash.slice(0, 7)} (detached HEAD)`) },
      { label: 'New branch here\u2026', icon: 'branch', onClick: () => newBranch(c.hash, 'New branch here') },
      { label: 'Create tag here\u2026', icon: 'tag', onClick: () => newTag(c.hash) },
      { sep: true },
      { label: 'Copy commit hash', icon: 'copy', onClick: () => copy(c.hash, 'Copied the commit hash') },
      { label: 'Copy subject', icon: 'copy', onClick: () => copy(c.subject, 'Copied the subject') },
    ]
    const locals = chips.filter((x) => x.type === 'branch' && !x.current)
    if (locals.length) items.push({ sep: true }, ...locals.map((x) => ({ label: `Check out ${x.name}`, icon: 'branch', onClick: () => checkoutRef(x) })))
    overlay.menu(anchor, items)
  }

  function copy(text, ok) {
    const done = () => toast('info', ok)
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => toast('error', 'Could not copy'))
    else toast('error', 'Could not copy')
  }

  function stashMenu(anchor) {
    const items = [
      { label: 'Stash changes', icon: 'stash', disabled: !dirty(S.status), onClick: () => mutateOp(() => rpc('stashPush', {}), 'Stashed the working tree') },
      { sep: true },
    ]
    if (S.refs.stashes.length) {
      items.push({ header: 'Stashes' })
      S.refs.stashes.forEach((s, i) => items.push({ label: `Pop ${s.ref}: ${s.message.replace(/^On [^:]+: /, '')}`, icon: 'pull', onClick: () => mutateOp(() => rpc('stashPop', { ref: s.ref }), `Applied ${s.ref}`) }))
    } else items.push({ label: 'No stashes', disabled: true })
    overlay.menu(anchor, items, { align: 'right' })
  }

  function moreMenu(anchor) {
    overlay.menu(
      anchor,
      [
        { label: 'Refresh', icon: 'fetch', kbd: 'F5', onClick: () => refresh() },
        { sep: true },
        { label: 'New branch\u2026', icon: 'branch', disabled: !S.repo, onClick: () => newBranch(null) },
        { label: 'Create tag\u2026', icon: 'tag', disabled: !S.repo, onClick: () => newTag(null) },
        { sep: true },
        { label: 'Search commits', icon: 'search', kbd: 'Ctrl F', disabled: !S.repo, onClick: openSearch },
        { label: 'Copy repository path', icon: 'copy', disabled: !S.repo, onClick: () => copy(S.repo.root, 'Copied the path') },
        ctx.openPath ? { label: 'Reveal in Files', icon: 'folder', disabled: !S.repo, onClick: () => ctx.openPath(S.repo.root) } : null,
      ],
      { align: 'right' },
    )
  }

  function openBranchPicker() {
    if (!S.repo) return
    overlay.popover(
      branchBtn,
      (close) => {
        const input = h('input', { class: 'gt-pop-input', type: 'text', placeholder: 'Switch to a branch or tag', spellcheck: false })
        const list = h('div', { class: 'gt-pop-list', role: 'listbox' })
        let items = []
        let at = 0
        const groups = () => {
          const q = input.value.trim().toLowerCase()
          const m = (n) => !q || n.toLowerCase().includes(q)
          const out = []
          const local = S.refs.branches.filter((b) => m(b.name)).sort((a, b) => Number(b.current) - Number(a.current) || b.date - a.date)
          if (local.length) out.push({ header: 'Branches' }, ...local.map((b) => ({ ref: { type: 'branch', name: b.name, current: b.current }, sub: [trackText(b), b.gone ? 'upstream gone' : '', relativeTime(b.date)].filter(Boolean).join('  '), deletable: !b.current })))
          const rem = S.refs.remotes.filter((b) => m(b.name) && !S.refs.branches.some((l) => `${S.refs.remoteNames.find((r) => b.name.startsWith(`${r}/`)) ?? ''}/${l.name}` === b.name)).sort((a, b) => b.date - a.date)
          if (rem.length) out.push({ header: 'Remote' }, ...rem.slice(0, 80).map((b) => ({ ref: { type: 'remote', name: b.name }, sub: relativeTime(b.date) })))
          const tags = S.refs.tags.filter((t) => m(t.name)).sort((a, b) => b.date - a.date)
          if (tags.length) out.push({ header: 'Tags' }, ...tags.slice(0, 80).map((t) => ({ ref: { type: 'tag', name: t.name }, sub: t.annotated ? 'annotated' : relativeTime(t.date) })))
          return out
        }
        const paint = () => {
          const g = groups()
          items = g.filter((x) => x.ref)
          if (at >= items.length) at = Math.max(0, items.length - 1)
          list.replaceChildren(
            ...(g.length
              ? g.map((x) => {
                  if (x.header) return h('div', { class: 'gt-mh' }, x.header)
                  const idx = items.indexOf(x)
                  const row = h(
                    'div',
                    { class: 'gt-pi' + (idx === at ? ' on' : '') + (x.ref.current ? ' current' : ''), role: 'option', onPointermove: () => idx !== at && ((at = idx), paint()), onClick: () => (close(), checkoutRef(x.ref)) },
                    icon(x.ref.type === 'tag' ? 'tag' : x.ref.type === 'remote' ? 'globe' : x.ref.current ? 'check' : 'branch'),
                    h('span', { class: 'gt-pi-n' }, x.ref.name),
                    h('span', { class: 'gt-pi-s' }, x.sub || ''),
                    x.deletable ? h('button', { class: 'gt-ibtn', title: `Delete ${x.ref.name}`, onClick: (e) => (e.stopPropagation(), close(), deleteBranch(x.ref.name)) }, icon('trash')) : null,
                  )
                  return row
                })
              : [h('div', { class: 'gt-pop-empty' }, 'Nothing matches')]),
          )
          list.querySelector('.gt-pi.on')?.scrollIntoView({ block: 'nearest' })
        }
        input.addEventListener('input', () => ((at = 0), paint()))
        input.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), (at = Math.min(items.length - 1, at + 1)), paint())
          else if (e.key === 'ArrowUp') (e.preventDefault(), (at = Math.max(0, at - 1)), paint())
          else if (e.key === 'Enter') {
            e.preventDefault()
            const x = items[at]
            if (x) (close(), checkoutRef(x.ref))
          }
        })
        paint()
        queueMicrotask(() => input.focus())
        return h('div', { class: 'gt-branch-pop' }, h('div', { class: 'gt-pop-head' }, icon('search'), input), list, h('div', { class: 'gt-pop-foot' }, h('button', { class: 'gt-btn sm quiet', onClick: () => (close(), newBranch(null)) }, icon('plus'), 'New branch\u2026'), h('button', { class: 'gt-btn sm quiet', onClick: () => (close(), newTag(null)) }, icon('tag'), 'New tag\u2026')))
      },
      { cls: 'wide' },
    )
  }

  // ------------------------------------------------------------------ detail: shared pieces
  function fileRowCommit(f, i) {
    const { dir, name } = splitPath(f.path)
    return h(
      'div',
      { class: 'gt-frow' + (S.commitFile === f.path ? ' sel' : ''), dataset: { path: f.path }, title: `${STATUS_NAME[f.status] ?? f.status}${f.oldPath ? ` (from ${f.oldPath})` : ''}\n${f.path}`, onClick: () => ((S.commitFile = f.path), renderDetail(), loadSelection()) },
      h('span', { class: `gt-st ${statusClass(f.status)}` }, f.status),
      h('span', { class: 'gt-fname' }, dir ? h('span', { class: 'dim' }, dir) : null, h('b', {}, name)),
      f.binary ? h('span', { class: 'gt-stat' }, h('i', {}, 'bin')) : h('span', { class: 'gt-stat' }, f.add ? h('i', { class: 'add' }, `+${f.add}`) : null, f.del ? h('i', { class: 'del' }, `\u2212${f.del}`) : null),
    )
  }

  // ------------------------------------------------------------------ detail: commit
  const commitDiff = createDiffView({})
  const commitPane = h('div', { class: 'gt-cdetail', hidden: true })
  const commitHead = h('div', { class: 'gt-chead' })
  const commitFiles = h('div', { class: 'gt-flist' })
  const commitSplit = h('div', { class: 'gt-dsplit' }, commitFiles, commitDiff.el)
  commitPane.append(commitHead, commitSplit)

  function renderCommitDetail() {
    const d = S.detail
    commitHead.replaceChildren()
    commitFiles.replaceChildren()
    if (!d) {
      commitHead.append(h('div', { class: 'gt-ch-note pad' }, 'Loading commit\u2026'))
      return
    }
    const [subject, ...rest] = d.message.split('\n')
    const body = rest.join('\n').trim()
    const chips = parseDecoration(d.refs, S.refs.remoteNames)
    const idx = S.index.get(d.hash)
    const color = idx !== undefined ? laneColor(S.layout.rows[idx].color) : 'var(--accent)'
    put(commitHead,
      h('div', { class: 'gt-d-subject' }, subject),
      body ? h('pre', { class: 'gt-d-body' }, body) : null,
      h(
        'div',
        { class: 'gt-d-meta' },
        avatar(d.author, d.email, 22),
        h('span', { class: 'gt-d-author' }, d.author),
        h('span', { class: 'gt-dim', title: fullDate(d.time) }, `${relativeTime(d.time)} ago \u00b7 ${fullDate(d.time)}`),
        d.committer && (d.committer !== d.author || d.committerEmail !== d.email) ? h('span', { class: 'gt-dim' }, `committed by ${d.committer}`) : null,
        h('span', { class: 'gt-grow' }),
        h('button', { class: 'gt-hash', title: `${d.hash}\nClick to copy`, onClick: () => copy(d.hash, 'Copied the commit hash') }, d.hash.slice(0, 8), icon('copy')),
      ),
      d.parents.length || chips.length
        ? h(
            'div',
            { class: 'gt-d-rel' },
            d.parents.length ? h('span', { class: 'gt-dim' }, d.parents.length > 1 ? 'Parents' : 'Parent') : null,
            ...d.parents.map((p) => h('button', { class: 'gt-hash flat', title: S.index.has(p) ? 'Go to this commit' : 'Older than the loaded history', disabled: !S.index.has(p), onClick: () => selectIndex(S.index.get(p), true) }, p.slice(0, 8))),
            h('span', { class: 'gt-grow' }),
            ...chips.map((c) => refChip(c, color, null)),
          )
        : null,
    )
    const add = d.files.reduce((a, f) => a + f.add, 0)
    const del = d.files.reduce((a, f) => a + f.del, 0)
    put(commitFiles,
      h('div', { class: 'gt-flist-head' }, h('span', {}, plural(d.files.length, 'file'), ' changed'), h('span', { class: 'gt-stat' }, add ? h('i', { class: 'add' }, `+${add}`) : null, del ? h('i', { class: 'del' }, `\u2212${del}`) : null)),
      h('div', { class: 'gt-flist-body' }, d.files.map(fileRowCommit)),
      d.truncated ? h('div', { class: 'gt-ch-note pad' }, 'The file list is cut off.') : null,
    )
  }

  // ------------------------------------------------------------------ detail: working tree
  const wipDiff = createDiffView({ onApply })
  const wipPane = h('div', { class: 'gt-wip', hidden: true })
  const wipLists = h('div', { class: 'gt-wip-lists' })
  const sbox = {
    summary: h('input', { class: 'gt-input', type: 'text', placeholder: 'Summary', spellcheck: false, onInput: () => ((box.summary = sbox.summary.value), renderBox()), onKeydown: boxKey }),
    why: h('textarea', { class: 'gt-input why', rows: 2, placeholder: 'Why this change\u2026', spellcheck: false, onInput: () => ((box.body = sbox.why.value), renderBox()), onKeydown: boxKey }),
    count: h('span', { class: 'gt-sum-count' }),
    write: h('button', { class: 'gt-chip', title: 'Generate message', onClick: writeMessage }),
    amend: h('button', { class: 'gt-chip', role: 'switch', title: 'Replace the last commit instead of adding a new one', onClick: toggleAmend }, h('span', { class: 'gt-chip-box' }, icon('check')), 'Amend'),
    commit: h('button', { class: 'gt-btn accent gt-commit', onClick: doCommit }),
  }
  const commitBox = h(
    'div',
    { class: 'gt-cbox' },
    h('div', { class: 'gt-sum-wrap' }, sbox.summary, sbox.count),
    sbox.why,
    h('div', { class: 'gt-cbox-row' }, sbox.write, sbox.amend, h('span', { class: 'gt-grow' }), sbox.commit),
  )
  const box = { summary: '', body: '', amend: false, writing: false, committing: false, prefilled: null }
  wipPane.append(h('div', { class: 'gt-wip-side' }, wipLists, commitBox), wipDiff.el)
  detailEl.append(commitPane, wipPane)

  function boxKey(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      doCommit()
    }
  }

  let discardArmed = null
  function wipRow(f, staged) {
    const { dir, name } = splitPath(f.path)
    const selected = S.wipFile && S.wipFile.path === f.path && S.wipFile.staged === staged
    const actions = h('span', { class: 'gt-row-actions' })
    if (staged) actions.append(h('button', { class: 'gt-ibtn', title: 'Unstage file', onClick: (e) => (e.stopPropagation(), mutateOp(() => rpc('unstage', { paths: [f.path] }))) }, icon('minus')))
    else {
      const key = f.path
      const armed = discardArmed === key
      actions.append(
        h(
          'button',
          {
            class: 'gt-ibtn' + (armed ? ' armed' : ''),
            title: armed ? 'Click again to discard' : f.untracked ? 'Delete this untracked file' : 'Discard changes',
            onClick: (e) => {
              e.stopPropagation()
              if (!armed) {
                discardArmed = key
                renderWip()
                setTimeout(() => discardArmed === key && ((discardArmed = null), !disposed && renderWip()), 2500)
                return
              }
              discardArmed = null
              mutateOp(() => rpc('discard', f.untracked ? { untracked: [f.path] } : { paths: [f.path] }))
            },
          },
          armed ? h('span', { class: 'gt-armed' }, 'Discard?') : icon('trash'),
        ),
        h('button', { class: 'gt-ibtn', title: 'Stage file', onClick: (e) => (e.stopPropagation(), mutateOp(() => rpc('stage', { paths: [f.path] }))) }, icon('plus')),
      )
    }
    return h(
      'div',
      { class: 'gt-frow' + (selected ? ' sel' : ''), dataset: { path: f.path, side: staged ? 's' : 'u' }, title: `${STATUS_NAME[f.status] ?? ''}${f.orig ? ` from ${f.orig}` : ''}\n${f.path}`, onClick: () => ((S.wipFile = { path: f.path, staged }), renderWip(), loadSelection()) },
      h('span', { class: `gt-st ${statusClass(f.status)}` }, f.status),
      h('span', { class: 'gt-fname' }, dir ? h('span', { class: 'dim' }, dir) : null, h('b', {}, name)),
      actions,
    )
  }

  function wipSection(title, items, staged, bulk) {
    return h(
      'section',
      { class: 'gt-sec' },
      h('div', { class: 'gt-sec-head static' }, h('span', { class: 'gt-sec-title' }, title), h('span', { class: 'gt-count' }, items.length), h('span', { class: 'gt-grow' }), items.length ? h('button', { class: 'gt-link', onClick: bulk.run }, bulk.label) : null),
      items.length ? h('div', { class: 'gt-sec-body' }, items.map((f) => wipRow(f, staged))) : h('div', { class: 'gt-sec-empty' }, staged ? 'Nothing staged' : 'No unstaged changes'),
    )
  }

  function stagedCount() {
    return S.status ? splitStatus(S.status.files).staged.length : 0
  }

  function renderWip() {
    if (!S.status) return
    const { staged, unstaged } = splitStatus(S.status.files)
    wipLists.replaceChildren(
      wipSection('Staged', staged, true, { label: 'Unstage all', run: () => mutateOp(() => rpc('unstage', { all: true })) }),
      wipSection('Unstaged', unstaged, false, { label: 'Stage all', run: () => mutateOp(() => rpc('stage', { all: true })) }),
    )
    if (S.status.truncated) wipLists.append(h('div', { class: 'gt-ch-note pad' }, 'The list is cut off: too many changed files.'))
    renderBox()
  }

  function renderBox() {
    const n = stagedCount()
    const msg = box.summary.trim()
    const len = [...box.summary].length
    sbox.count.textContent = len ? String(len) : ''
    sbox.count.classList.toggle('over', len > 72)
    sbox.summary.disabled = box.committing
    sbox.why.disabled = box.committing
    sbox.write.replaceChildren(icon(box.writing ? 'spinner' : 'sparkle'), box.writing ? 'Writing message\u2026' : 'Write it')
    sbox.write.disabled = box.writing || box.committing || !n
    sbox.write.title = n ? 'Generate message' : 'Stage something to describe it'
    sbox.amend.classList.toggle('on', box.amend)
    sbox.amend.setAttribute('aria-checked', String(box.amend))
    sbox.amend.disabled = box.committing || !S.status?.branch.oid
    const can = !box.committing && (box.amend || (n > 0 && !!msg))
    sbox.commit.disabled = !can
    fill(sbox.commit,
      box.committing ? icon('spinner') : null,
      box.committing ? 'Committing\u2026' : box.amend ? (n ? `Amend with ${plural(n, 'file')}` : 'Amend message') : n ? `Commit ${plural(n, 'file')}` : 'Nothing staged',
      box.committing ? null : h('kbd', { class: 'gt-kbd on-accent' }, COMMIT_KEYS),
    )
  }

  async function writeMessage() {
    if (box.writing) return
    box.writing = true
    renderBox()
    try {
      const m = await rpc('generateMessage')
      box.summary = sbox.summary.value = m.summary
      box.body = sbox.why.value = m.body || ''
      if (m.note) toast('info', m.note)
    } catch (e) {
      fail(e)
    }
    box.writing = false
    renderBox()
  }

  async function toggleAmend() {
    box.amend = !box.amend
    if (box.amend && !box.summary && !box.body && S.status?.branch.oid) {
      try {
        const d = await rpc('commit', { hash: S.status.branch.oid })
        const [s, ...rest] = d.message.split('\n')
        box.summary = sbox.summary.value = s
        box.body = sbox.why.value = rest.join('\n').trim()
        box.prefilled = { summary: box.summary, body: box.body }
      } catch (e) {
        fail(e)
      }
    } else if (!box.amend && box.prefilled && box.summary === box.prefilled.summary && box.body === box.prefilled.body) {
      box.summary = sbox.summary.value = ''
      box.body = sbox.why.value = ''
      box.prefilled = null
    }
    renderBox()
  }

  async function doCommit() {
    if (sbox.commit.disabled) return
    box.committing = true
    renderBox()
    const amend = box.amend
    const r = await mutateOp(() => rpc('commitCreate', { summary: box.summary, body: box.body, amend }), amend ? 'Amended the last commit' : 'Committed')
    box.committing = false
    if (r) {
      box.summary = sbox.summary.value = ''
      box.body = sbox.why.value = ''
      box.amend = false
      box.prefilled = null
      S.sel = { kind: 'wip' }
    }
    renderBox()
  }

  async function onApply(kind, diff, selection) {
    const f = S.wipFile
    if (!f) return
    const reverse = kind === 'unstage'
    const patch = buildPatch(diff, selection, { reverse })
    if (!patch) return toast('info', 'Nothing to apply in that selection')
    const whole = selection.some((s) => s.lines === null)
    const label = `${reverse ? 'Unstage' : 'Stage'} ${whole ? 'hunk' : 'lines'} in ${splitPath(f.path).name}`
    wipDiff.clear() // the picked indexes are meaningless once the diff changes
    await mutateOp(() => rpc('applyPatch', { patch, reverse, label }))
  }

  // ------------------------------------------------------------------ detail dispatch
  function renderDetail() {
    const wip = S.sel.kind === 'wip'
    wipPane.hidden = !wip
    commitPane.hidden = wip
    if (wip) renderWip()
    else renderCommitDetail()
  }

  /** Loads what the selection needs: the commit's file list, and the diff of the selected file. */
  let diffToken = 0
  async function loadSelection() {
    if (!S.repo) return
    const mine = ++diffToken
    const sel = S.sel
    try {
      if (sel.kind === 'wip') {
        const f = S.wipFile
        if (!f || !S.status) return wipDiff.message(S.status && dirty(S.status) ? 'Select a file to see its changes.' : 'The working tree is clean.')
        const info = splitStatus(S.status.files)
        const entry = (f.staged ? info.staged : info.unstaged).find((x) => x.path === f.path)
        if (!entry) return
        if (entry.conflict) return wipDiff.show(parseDiff(''), { path: f.path, mode: 'worktree', notice: 'This file has merge conflicts. Resolve them in your editor, then stage the file.' })
        const r = await rpc('diff', f.staged ? { path: f.path, staged: true } : entry.untracked ? { path: f.path, untracked: true } : { path: f.path })
        if (mine !== diffToken || disposed) return
        const notice = r.tooLarge ? `This file is too large to show (${Math.round(r.size / 1048576)} MB).` : r.truncated ? 'This diff is too large to show completely.' : ''
        wipDiff.show(parseDiff(r.text), { path: f.path, mode: f.staged ? 'staged' : 'worktree', keepScroll: true, notice: notice && !r.text ? notice : '' })
        return
      }
      let d = detailCache.get(sel.hash)
      if (!d) {
        S.detail = null
        renderCommitDetail()
        d = await rpc('commit', { hash: sel.hash })
        if (mine !== diffToken || disposed) return
        detailCache.set(sel.hash, d)
        if (detailCache.size > 60) detailCache.delete(detailCache.keys().next().value)
      }
      S.detail = d
      if (!S.commitFile || !d.files.some((f) => f.path === S.commitFile)) S.commitFile = d.files[0]?.path ?? null
      renderCommitDetail()
      const f = d.files.find((x) => x.path === S.commitFile)
      if (!f) return commitDiff.message(d.files.length ? 'Select a file.' : 'This commit changes no files.')
      if (f.binary) return commitDiff.show(parseDiff(''), { path: f.path, mode: 'commit', notice: 'Binary file: nothing to show.' })
      const r = await rpc('diff', { hash: d.hash, parent: d.parents[0], path: f.path, oldPath: f.oldPath })
      if (mine !== diffToken || disposed) return
      commitDiff.show(parseDiff(r.text), { path: f.path, mode: 'commit', notice: r.truncated && !r.text ? 'This diff is too large to show.' : '' })
    } catch (e) {
      if (mine !== diffToken || disposed) return
      const m = errorText(e)
      ;(sel.kind === 'wip' ? wipDiff : commitDiff).message(m)
    }
  }

  // ------------------------------------------------------------------ whole render
  function render() {
    renderBar()
    const none = !S.repo
    main.hidden = none
    searchBar.hidden = none || !S.search.open
    emptyEl.hidden = !none
    if (none) {
      fill(emptyEl,
        icon('branch', 'gt-empty-ico'),
        h('div', { class: 'gt-empty-title' }, S.loading ? 'Opening repository\u2026' : S.cwd ? 'This folder is not a Git repository' : 'No folder to open'),
        S.cwd ? h('div', { class: 'gt-empty-path' }, S.cwd) : null,
        !S.loading && S.cwd ? h('button', { class: 'gt-btn accent', onClick: initRepo }, 'Initialize repository') : null,
      )
      return
    }
    ctx.setTitle?.(`${S.repo.name} \u00b7 ${S.status?.branch.head ?? 'git'}`)
    graphFootRender()
    if (!S.commits.length && !S.hasMore) rowsEl.dataset.empty = 'No commits yet. Stage some files and write the first one.'
    else delete rowsEl.dataset.empty
    renderRows()
    renderDetail()
  }

  async function initRepo() {
    try {
      await ctx.rpc('init', { cwd: S.cwd })
      S.repo = null
      await refresh()
      watchRepo()
    } catch (e) {
      fail(e)
    }
  }

  // ------------------------------------------------------------------ splitter
  const splitKey = 'pager.git.detail'
  const savedSplit = (() => {
    try {
      return +localStorage.getItem(splitKey) || 0
    } catch {
      return 0
    }
  })()
  if (savedSplit) main.style.setProperty('--gt-detail', `${savedSplit}px`)
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    try { splitter.setPointerCapture(e.pointerId) } catch { /* synthetic events have no active pointer */ }
    const rect = main.getBoundingClientRect()
    const horizontal = getComputedStyle(main).flexDirection === 'row'
    const move = (ev) => {
      const total = horizontal ? rect.width : rect.height
      const pos = horizontal ? rect.right - ev.clientX : rect.bottom - ev.clientY
      const px = Math.round(Math.max(total * 0.2, Math.min(total * 0.8, pos)))
      main.style.setProperty('--gt-detail', `${px}px`)
    }
    const up = () => {
      splitter.removeEventListener('pointermove', move)
      splitter.removeEventListener('pointerup', up)
      const v = parseInt(main.style.getPropertyValue('--gt-detail'), 10)
      try {
        if (v) localStorage.setItem(splitKey, String(v))
      } catch {
        /* storage unavailable */
      }
      paintWindow()
    }
    splitter.addEventListener('pointermove', move)
    splitter.addEventListener('pointerup', up)
  })
  splitter.addEventListener('dblclick', () => {
    main.style.removeProperty('--gt-detail')
    try {
      localStorage.removeItem(splitKey)
    } catch {
      /* storage unavailable */
    }
    paintWindow()
  })

  // ------------------------------------------------------------------ keyboard
  root.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') (e.preventDefault(), openSearch())
    else if (e.key === 'F5' || (mod && e.key.toLowerCase() === 'r')) (e.preventDefault(), refresh())
    else if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? '')) (e.preventDefault(), openSearch())
    else if (mod && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? '')) (e.preventDefault(), undoRedo(e.shiftKey ? 'redo' : 'undo'))
  })

  // ------------------------------------------------------------------ live updates
  let watched = null
  function watchRepo() {
    if (!S.repo || watched === S.repo.root) return
    watched = S.repo.root
    ctx.rpc('watch', { cwd: watched }).catch(() => {})
  }
  const refreshSoon = (() => {
    let t = 0
    return () => {
      clearTimeout(t)
      t = setTimeout(() => !disposed && refresh(), 80)
    }
  })()
  const offEvent = subscribe(ctx, (event, p) => {
    if (event === 'changed' && p && S.repo && p.root === S.repo.root) refreshSoon()
  })
  const offAnnounce = onAnnounce((r, src) => {
    if (src !== S && S.repo && r === S.repo.root) refreshSoon()
  })

  renderBar()
  render()
  refresh().then(watchRepo)

  return {
    focus: () => (S.repo ? scroller.focus() : root.focus()),
    resize: () => paintWindow(),
    refresh,
    /** Re-points the block at another folder (used when a pane follows a terminal). */
    async setCwd(next) {
      if (!next || next === S.cwd) return
      if (watched) ctx.rpc('unwatch', { cwd: watched }).catch(() => {})
      watched = null
      S.cwd = next
      S.repo = null
      S.commits = []
      S.sel = { kind: 'wip' }
      S.wipFile = null
      await refresh()
      watchRepo()
    },
    dispose() {
      disposed = true
      offEvent()
      offAnnounce()
      if (watched) ctx.rpc('unwatch', { cwd: watched }).catch(() => {})
      overlay.close()
      root.remove()
    },
  }
}
