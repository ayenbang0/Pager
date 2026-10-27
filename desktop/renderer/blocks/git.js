// The git block: a source-control panel in the shape of a source-control tool. Three views of one repository —
// Changes (conflicted/staged/unstaged/untracked groups, multi-select, bulk actions, line-level staging, commit
// composer with sign-off), History (lane graph, search, commit detail) and Branches (local branches, remote
// branches, tags, remotes, stashes with destructive-action confirmations) — plus a banner for the merge/rebase/
// cherry-pick/revert in progress. The main-process half is desktop/electron/blocks/git.cjs; this file only renders
// and orchestrates. `mountChanges` is the compact sidebar view.
import { h, rafThrottle, uid } from '../ui/dom.js'
import { createDiffView } from './gitdiff.js'
import { highlightParts, initials, avatarHue, layoutGraph, parseDecoration, relativeTime, withWorkingTree } from './gitgraph.js'
import { buildPatch, parseDiff } from './gitpatch.js'
import { icon, iconSvg } from './giticons.js'
import {
  announce, commitButton, dirty, errorText, filterEntries, fullDate, GROUPS, groupStatus, mergeCandidates,
  onAnnounce, operationText, pathsOf, plural, refRows, selectKeys, SHORTCUTS, splitPath, STATUS_NAME, statusClass,
  subscribe, trackText,
} from './gitmodel.js'
import { createOverlay } from './gitui.js'
import { registerInstance, registerShare } from './share.js'

export { mountChanges } from './gitchanges.js'

// The block's stylesheet loads itself (the shell never links it), so any host that imports the module gets the styling.
const CSS = new URL('./git.css', import.meta.url).href
if (!document.querySelector(`link[href="${CSS}"]`)) document.head.append(h('link', { rel: 'stylesheet', href: CSS }))

const ROW_H = 28
const LANE_W = 16
const PAGE = 300
const MAX_COMMITS = 20000
const OVERSCAN = 8
const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
const COMMIT_KEYS = isMac ? '⌘⏎' : 'Ctrl ⏎'

const VIEWS = [
  ['changes', 'Changes', 'changes'],
  ['history', 'History', 'commit'],
  ['refs', 'Branches', 'branch'],
]
const GROUP_META = {
  conflicted: { title: 'Conflicted', bulk: null },
  staged: { title: 'Staged', bulk: 'Unstage all' },
  unstaged: { title: 'Changes', bulk: 'Stage all' },
  untracked: { title: 'Untracked', bulk: 'Stage all' },
}

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
    refs: { branches: [], remotes: [], tags: [], stashes: [], remoteNames: [], remoteInfo: [] },
    commits: [],
    hasMore: false,
    loadingMore: false,
    layout: null, // { rows, width }
    all: [], // commits incl. the working-tree row
    index: new Map(),
    sel: { kind: 'wip' }, // history selection
    commitFile: null, // path of the file whose commit diff is shown
    detail: null, // commit() result of the selected commit
    undo: { undo: null, redo: null },
    busy: new Map(), // tool name -> opId
    search: { open: false, q: '', hits: [], at: -1, scanning: false },
    error: '',
    loading: true,
    view: 'changes',
    // Changes view
    ch: { query: '', selected: new Set(), anchor: null, file: null, collapsed: {} },
    // Branches view
    rf: { query: '', collapsed: new Set(), sel: null, file: null },
    // commit composer
    box: { summary: '', body: '', amend: false, signoff: false, committing: false, writing: false, prefilled: null },
  }
  let disposed = false
  let loadToken = 0
  let focusedRow = null
  let argsPathHandled = false
  let discardArmed = null
  let diffToken = 0
  let refsDiffToken = 0
  const detailCache = new Map()
  const chEntriesCache = { entries: [], order: [] }

  const rpc = (method, a = {}) => ctx.rpc(method, { cwd: S.repo?.root ?? S.cwd, ...a })
  const fail = (e) => toast('error', errorText(e))

  // ------------------------------------------------------------------ skeleton
  const root = h('div', { class: 'gt gt-block', tabIndex: -1 })
  el.replaceChildren(root)
  const overlay = createOverlay(root)

  const repoChip = h('button', { class: 'gt-repo', type: 'button', title: 'Copy the repository path' })
  repoChip.addEventListener('click', () => {
    if (!S.repo) return
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(S.repo.root).then(() => toast('info', 'Copied the repository path'), () => toast('error', 'Could not copy'))
    else toast('error', 'Could not copy')
  })
  const branchBtn = h('button', { class: 'gt-btn quiet gt-branch-btn', type: 'button', title: 'Switch branch', onClick: () => openBranchPicker() })
  const trackEl = h('span', { class: 'gt-track' })
  const tools = h('div', { class: 'gt-tools' })
  const bar = h('div', { class: 'gt-bar' }, repoChip, branchBtn, trackEl, h('span', { class: 'gt-grow' }), tools)

  const banner = h('div', { class: 'gt-banner', hidden: true })

  const tabsEl = h('div', { class: 'gt-tabs', role: 'tablist' })
  const tabBtns = new Map()
  for (const [id, label, ico] of VIEWS) {
    const b = h('button', { class: 'gt-tab', role: 'tab', type: 'button', 'aria-selected': 'false', title: `${label} (Alt ${id === 'changes' ? 1 : id === 'history' ? 2 : 3})` }, icon(ico), h('span', {}, label), h('span', { class: 'gt-tab-n', hidden: true }))
    b.addEventListener('click', () => switchView(id))
    tabBtns.set(id, b)
    tabsEl.append(b)
  }
  const viewTools = h('div', { class: 'gt-viewtools' })
  tabsEl.append(h('span', { class: 'gt-grow' }), viewTools)

  // ---- Changes view
  const chFilter = h('input', { class: 'gt-filter-input', type: 'text', placeholder: 'Filter files', spellcheck: false })
  const chFilterClear = h('button', { class: 'gt-ibtn', type: 'button', title: 'Clear filter', hidden: true }, icon('x'))
  const chFilterCount = h('span', { class: 'gt-filter-n' })
  const chSelectAll = h('input', { class: 'gt-cb-in', type: 'checkbox', title: 'Select every visible file', 'aria-label': 'Select every visible file' })
  const selbar = h('div', { class: 'gt-selbar', hidden: true })
  const groupsEl = h('div', { class: 'gt-chv-scroll', tabIndex: 0, role: 'listbox', 'aria-label': 'Changed files' })
  const wipDiff = createDiffView({ onApply, onReload: () => loadChangesDiff(true) })
  const chList = h('div', { class: 'gt-chv-list' },
    h('div', { class: 'gt-filter' }, icon('filter'), chSelectAll, chFilter, chFilterClear, chFilterCount),
    selbar,
    groupsEl,
    buildComposer())
  const chView = h('div', { class: 'gt-view gt-changes' }, h('div', { class: 'gt-chv' }, chList, h('div', { class: 'gt-chv-diff' }, wipDiff.el)))

  // ---- History view
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
  const commitPane = h('div', { class: 'gt-cdetail' })
  const commitHead = h('div', { class: 'gt-chead' })
  const commitFiles = h('div', { class: 'gt-flist' })
  const commitDiff = createDiffView({})
  const commitSplit = h('div', { class: 'gt-dsplit' }, commitFiles, commitDiff.el)
  commitPane.append(commitHead, commitSplit)
  const detailEl = h('div', { class: 'gt-detail' }, commitPane)
  const main = h('div', { class: 'gt-main' }, graphPane, splitter, detailEl)
  const historyView = h('div', { class: 'gt-view gt-history', hidden: true }, searchBar, main)

  // ---- Branches view
  const rfFilter = h('input', { class: 'gt-filter-input', type: 'text', placeholder: 'Filter branches, tags, stashes', spellcheck: false })
  const rfFilterClear = h('button', { class: 'gt-ibtn', type: 'button', title: 'Clear filter', hidden: true }, icon('x'))
  const rfFilterCount = h('span', { class: 'gt-filter-n' })
  const rvList = h('div', { class: 'gt-rv-list', tabIndex: 0, role: 'listbox', 'aria-label': 'References' })
  const refsDiff = createDiffView({})
  const refsHead = h('div', { class: 'gt-chead' })
  const refsFiles = h('div', { class: 'gt-flist' })
  const refsSplit = h('div', { class: 'gt-dsplit' }, refsFiles, refsDiff.el)
  const refsDetail = h('div', { class: 'gt-cdetail' }, refsHead, refsSplit)
  const refsView = h('div', { class: 'gt-view gt-refs', hidden: true },
    h('div', { class: 'gt-rv' },
      h('div', { class: 'gt-filter' }, icon('filter'), rfFilter, rfFilterClear, rfFilterCount, h('span', { class: 'gt-grow' }),
        h('button', { class: 'gt-ibtn', type: 'button', title: 'New branch…', onClick: () => newBranch(null) }, icon('plus')),
        h('button', { class: 'gt-ibtn', type: 'button', title: 'Create tag…', onClick: () => newTag(null) }, icon('tag'))),
      rvList,
      h('div', { class: 'gt-detail gt-rv-detail' }, refsDetail)))

  const emptyEl = h('div', { class: 'gt-empty', hidden: true })
  root.append(bar, banner, tabsEl, chView, historyView, refsView, emptyEl)

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
      repoChip.hidden = true
      branchBtn.replaceChildren(h('span', { class: 'gt-branch-name' }, S.loading ? 'Loading…' : 'No repository'))
      branchBtn.disabled = true
      trackEl.textContent = ''
    } else {
      repoChip.hidden = false
      fill(repoChip, icon('folder'), h('span', {}, repo.name))
      repoChip.title = `${repo.root}\nCopy the repository path`
      branchBtn.disabled = false
      const name = b ? (b.head ?? (b.oid ? `detached @ ${b.oid.slice(0, 7)}` : 'no commits yet')) : (repo.branch ?? '')
      branchBtn.replaceChildren(h('span', { class: 'gt-branch-name' }, name), icon('chevD', 'gt-caret'))
      branchBtn.title = b?.upstream ? `${name} → ${b.upstream}\nSwitch branch` : 'Switch branch'
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
      if (busy && S.busy.get(t.id)) title = 'Working… click to cancel'
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
      pruneChanges()
      pruneHistory()
      render()
      if (S.search.open && S.search.q) runSearch(S.search.q, true)
      loadSelection()
      loadChangesDiff()
      loadRefsDetail()
      if (!argsPathHandled && args.path) {
        argsPathHandled = true
        openFileInChanges(args.path, !!args.staged)
      }
    } catch (e) {
      if (disposed) return
      S.loading = false
      if (/not a git repository|does not exist|must be absolute/i.test(errorText(e))) {
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

  /** After a status reload: drop selections that no longer exist. */
  function pruneChanges() {
    const g = groupStatus(S.status?.files ?? [])
    const live = new Set([...g.conflicted, ...g.staged, ...g.unstaged, ...g.untracked].map((e) => e.key))
    for (const k of [...S.ch.selected]) if (!live.has(k)) S.ch.selected.delete(k)
    if (S.ch.file && !live.has(S.ch.file)) {
      const first = [...g.unstaged, ...g.staged, ...g.untracked, ...g.conflicted].find((e) => live.has(e.key))
      S.ch.file = first ? first.key : null
    }
  }
  function pruneHistory() {
    if (S.sel.kind === 'commit' && !S.index.has(S.sel.hash)) S.sel = { kind: 'wip' }
    if (S.commitFile && !S.detail?.files?.some((f) => f.path === S.commitFile)) S.commitFile = null
  }

  // ------------------------------------------------------------------ Changes view
  /** Porcelain files -> the four groups, filtered by the Changes view's query. */
  function chEntries() {
    const g = groupStatus(S.status?.files ?? [])
    return filterEntries([...g.conflicted, ...g.staged, ...g.unstaged, ...g.untracked], S.ch.query)
  }

  /** Every entry of the four groups, ignoring the filter: selection actions must not drop filtered-out files. */
  function allEntries() {
    const g = groupStatus(S.status?.files ?? [])
    return [...g.conflicted, ...g.staged, ...g.unstaged, ...g.untracked]
  }

  function buildComposer() {
    const summary = h('input', {
      class: 'gt-input', type: 'text', placeholder: 'Summary', spellcheck: false,
      onInput: () => ((S.box.summary = summary.value), renderBox()),
      onKeydown: boxKey,
    })
    const why = h('textarea', {
      class: 'gt-input why', rows: 2, placeholder: 'Why this change? (optional)', spellcheck: false,
      onInput: () => ((S.box.body = why.value), renderBox()),
      onKeydown: boxKey,
    })
    const count = h('span', { class: 'gt-sum-count' })
    const write = h('button', { class: 'gt-chip', type: 'button', title: 'Write the message for the staged changes', onClick: writeMessage }, icon('sparkle'), 'Write it')
    const amend = h('button', { class: 'gt-chip', type: 'button', role: 'switch', title: 'Replace the last commit instead of adding a new one', onClick: () => toggleAmend() }, h('span', { class: 'gt-chip-box' }, icon('check')), 'Amend')
    const sign = h('button', { class: 'gt-chip', type: 'button', role: 'switch', title: 'Add a Signed-off-by trailer with your git identity', onClick: () => ((S.box.signoff = !S.box.signoff), renderBox()) }, h('span', { class: 'gt-chip-box' }, icon('check')), 'Sign off')
    const commit = h('button', { class: 'gt-btn accent gt-commit', type: 'button', onClick: doCommit })
    S.composer = { summary, why, count, write, amend, sign, commit }
    return h('div', { class: 'gt-cbox' },
      h('div', { class: 'gt-sum-wrap' }, summary, count),
      why,
      h('div', { class: 'gt-cbox-row' }, write, amend, sign, h('span', { class: 'gt-grow' }), commit))
  }

  function boxKey(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      doCommit()
    }
  }

  function stagedCount() {
    return groupStatus(S.status?.files ?? []).staged.length
  }

  function renderBox() {
    const c = S.composer
    if (!c) return
    const n = stagedCount()
    const op = S.status?.operation
    const msg = S.box.summary.trim()
    const len = [...S.box.summary].length
    c.count.textContent = len ? String(len) : ''
    c.count.classList.toggle('over', len > 72)
    const blocked = S.box.committing || !!op
    c.summary.disabled = blocked
    c.why.disabled = blocked
    c.write.disabled = S.box.writing || blocked || !n
    c.write.title = op ? 'Finish the merge/rebase first' : n ? 'Generate message' : 'Stage something to describe it'
    c.write.replaceChildren(icon(S.box.writing ? 'spinner' : 'sparkle'), S.box.writing ? 'Writing message…' : 'Write it')
    c.amend.classList.toggle('on', S.box.amend)
    c.amend.setAttribute('aria-checked', String(S.box.amend))
    c.amend.disabled = blocked || !S.status?.branch.oid
    c.sign.classList.toggle('on', S.box.signoff)
    c.sign.setAttribute('aria-checked', String(S.box.signoff))
    c.sign.disabled = blocked
    const st = commitButton({ staged: n, conflicted: S.status?.conflicted ?? 0, summary: msg, amend: S.box.amend, committing: S.box.committing })
    c.commit.disabled = blocked || st.disabled
    c.commit.title = op ? 'Finish the merge/rebase in progress first' : st.hint || (S.box.amend ? 'Amend the last commit' : 'Commit the staged changes')
    fill(c.commit,
      S.box.committing ? icon('spinner') : null,
      blocked && op ? 'Finish the merge first' : S.box.committing ? 'Committing…' : st.label,
      blocked || S.box.committing ? null : h('kbd', { class: 'gt-kbd on-accent' }, COMMIT_KEYS))
  }

  async function writeMessage() {
    if (S.box.writing) return
    S.box.writing = true
    renderBox()
    try {
      const m = await rpc('generateMessage')
      S.box.summary = S.composer.summary.value = m.summary
      S.box.body = S.composer.why.value = m.body || ''
      if (m.note) toast('info', m.note)
    } catch (e) {
      fail(e)
    }
    S.box.writing = false
    renderBox()
  }

  async function toggleAmend() {
    S.box.amend = !S.box.amend
    if (S.box.amend && !S.box.summary && !S.box.body && S.status?.branch.oid) {
      try {
        const d = await rpc('commit', { hash: S.status.branch.oid })
        const [s, ...rest] = d.message.split('\n')
        S.box.summary = S.composer.summary.value = s
        S.box.body = S.composer.why.value = rest.join('\n').trim()
        S.box.prefilled = { summary: S.box.summary, body: S.box.body }
      } catch (e) {
        fail(e)
      }
    } else if (!S.box.amend && S.box.prefilled && S.box.summary === S.box.prefilled.summary && S.box.body === S.box.prefilled.body) {
      S.box.summary = S.composer.summary.value = ''
      S.box.body = S.composer.why.value = ''
      S.box.prefilled = null
    }
    renderBox()
  }

  async function doCommit() {
    if (S.composer?.commit.disabled) return
    S.box.committing = true
    renderBox()
    const amend = S.box.amend
    const r = await mutateOp(() => rpc('commitCreate', { summary: S.box.summary, body: S.box.body, amend, signoff: S.box.signoff }), amend ? 'Amended the last commit' : 'Committed')
    S.box.committing = false
    if (r) {
      S.box.summary = S.composer.summary.value = ''
      S.box.body = S.composer.why.value = ''
      S.box.amend = false
      S.box.signoff = false
      S.box.prefilled = null
    }
    renderBox()
  }

  /** Line/hunk staging from the diff view: rebuilds the patch and applies it to the index. */
  async function onApply(kind, diff, selection) {
    const e = allEntries().find((x) => x.key === S.ch.file)
    if (!e) return
    const reverse = kind === 'unstage'
    const patch = buildPatch(diff, selection, { reverse })
    if (!patch) return toast('info', 'Nothing to apply in that selection')
    const whole = selection.some((s) => s.lines === null)
    const label = `${reverse ? 'Unstage' : 'Stage'} ${whole ? 'hunk' : 'lines'} in ${splitPath(e.path).name}`
    wipDiff.clear() // the picked indexes are meaningless once the diff changes
    await mutateOp(() => rpc('applyPatch', { patch, reverse, label }))
  }

  function chRow(e) {
    const selected = S.ch.selected.has(e.key)
    const current = S.ch.file === e.key
    const { dir, name } = splitPath(e.path)
    const actions = h('span', { class: 'gt-row-actions' })
    if (e.conflict) {
      actions.append(
        h('button', { class: 'gt-ibtn', type: 'button', title: 'Keep your version (ours), stages it', onClick: (ev) => (ev.stopPropagation(), resolveFile(e, 'ours')) }, icon('check')),
        h('button', { class: 'gt-ibtn', type: 'button', title: 'Keep their version (theirs), stages it', onClick: (ev) => (ev.stopPropagation(), resolveFile(e, 'theirs')) }, icon('copy')),
      )
    } else {
      const armed = discardArmed === e.key
      const discard = h(
        'button',
        {
          class: 'gt-ibtn' + (armed ? ' armed' : ''), type: 'button',
          title: armed ? 'Click again to discard' : e.untracked ? 'Delete this untracked file' : 'Discard changes',
          onClick: (ev) => (ev.stopPropagation(), armDiscard(e.key, () => discardEntries([e], { confirm: false }))),
        },
        armed ? h('span', { class: 'gt-armed' }, 'Discard?') : icon('trash'),
      )
      if (e.group === 'staged') actions.append(discard, h('button', { class: 'gt-ibtn', type: 'button', title: 'Unstage', onClick: (ev) => (ev.stopPropagation(), mutateOp(() => rpc('unstage', { paths: [e.path] }))) }, icon('minus')))
      else actions.append(h('button', { class: 'gt-ibtn', type: 'button', title: 'Stage', onClick: (ev) => (ev.stopPropagation(), mutateOp(() => rpc('stage', { paths: [e.path] }))) }, icon('plus')), discard)
    }
    return h(
      'div',
      {
        class: 'gt-frow' + (selected ? ' sel' : '') + (current ? ' cur' : ''), role: 'option', 'aria-selected': selected, dataset: { key: e.key, path: e.path },
        title: `${STATUS_NAME[e.status] ?? ''}${e.orig ? ` from ${e.orig}` : ''}${e.conflict ? '\nConflicted: take ours or theirs' : ''}\n${e.path}`,
        onDblclick: () => ctx.openPath?.(`${S.repo.root.replace(/[\\/]+$/, '')}/${e.path}`),
      },
      h('input', { class: 'gt-cb-in', type: 'checkbox', 'aria-label': `Select ${e.path}`, checked: selected, onClick: (ev) => (ev.stopPropagation(), toggleSelect(e.key)) }),
      h('span', { class: `gt-st ${statusClass(e.status)}` }, e.status),
      h('span', { class: 'gt-fname' }, dir ? h('span', { class: 'dim' }, dir) : null, h('b', {}, name), e.orig ? h('span', { class: 'dim' }, ` ← ${e.orig}`) : null),
      actions,
    )
  }

  /** Two-click discard: the first click arms the button, the second throws the changes away. */
  function armDiscard(key, run) {
    if (discardArmed !== key) {
      discardArmed = key
      renderChanges()
      setTimeout(() => {
        if (discardArmed === key && !disposed) {
          discardArmed = null
          renderChanges()
        }
      }, 2500)
      return
    }
    discardArmed = null
    run()
  }

  function chClick(e, ev) {
    const next = selectKeys({ order: chEntriesCache.order, selected: S.ch.selected, anchor: S.ch.anchor }, e.key, { toggle: ev.ctrlKey || ev.metaKey, range: ev.shiftKey })
    S.ch.selected = next.selected
    S.ch.anchor = next.anchor
    S.ch.file = e.key
    renderChanges()
    loadChangesDiff()
  }

  function toggleSelect(key) {
    const next = selectKeys({ order: chEntriesCache.order, selected: S.ch.selected, anchor: S.ch.anchor }, key, { toggle: true })
    S.ch.selected = next.selected
    S.ch.anchor = next.anchor
    S.ch.file = key
    renderChanges()
    loadChangesDiff()
  }

  function chSection(group) {
    const meta = GROUP_META[group]
    const items = chEntriesCache.entries.filter((e) => e.group === group)
    if (!items.length) return null
    const open = S.ch.query ? true : !S.ch.collapsed[group]
    return h('section', { class: 'gt-sec' },
      h('div', { class: 'gt-sec-head', role: 'button', tabIndex: -1, onClick: () => ((S.ch.collapsed[group] = !S.ch.collapsed[group]), renderChanges()) },
        h('span', { class: 'gt-chev' + (open ? ' open' : '') }, icon('chevR')),
        h('span', { class: 'gt-sec-title' }, meta.title),
        h('span', { class: 'gt-count' + (group === 'conflicted' ? ' bad' : '') }, items.length),
        h('span', { class: 'gt-grow' }),
        meta.bulk ? h('button', { class: 'gt-link', type: 'button', onClick: (ev) => (ev.stopPropagation(), bulkRun(group)) }, meta.bulk) : null),
      open ? h('div', { class: 'gt-sec-body' }, items.map(chRow)) : null)
  }

  function bulkRun(group) {
    const paths = chEntriesCache.entries.filter((e) => e.group === group).map((e) => e.path)
    if (!paths.length) return
    if (group === 'staged') mutateOp(() => rpc('unstage', { paths }), `Unstaged ${plural(paths.length, 'file')}`)
    else mutateOp(() => rpc('stage', { paths }), `Staged ${plural(paths.length, 'file')}`)
  }

  function renderSelbar() {
    const n = S.ch.selected.size
    if (!n) {
      selbar.hidden = true
      return
    }
    selbar.hidden = false
    const entries = allEntries().filter((e) => S.ch.selected.has(e.key))
    const staged = entries.filter((e) => e.group === 'staged')
    const rest = entries.filter((e) => e.group !== 'staged' && !e.conflict)
    fill(selbar,
      h('span', { class: 'gt-sel-n' }, `${n} selected`),
      h('span', { class: 'gt-grow' }),
      rest.length ? h('button', { class: 'gt-btn sm', type: 'button', onClick: () => stagePaths(rest.map((e) => e.path)) }, icon('plus'), `Stage ${rest.length}`) : null,
      staged.length ? h('button', { class: 'gt-btn sm', type: 'button', onClick: () => mutateOp(() => rpc('unstage', { paths: staged.map((e) => e.path) }), `Unstaged ${plural(staged.length, 'file')}`) }, icon('minus'), `Unstage ${staged.length}`) : null,
      rest.length ? h('button', { class: 'gt-btn sm quiet', type: 'button', onClick: () => discardSelected() }, icon('trash'), `Discard ${rest.length}`) : null,
      h('button', { class: 'gt-ibtn', type: 'button', title: 'Clear selection', onClick: () => ((S.ch.selected = new Set()), renderChanges()) }, icon('x')),
    )
  }

  function renderChanges() {
    chEntriesCache.entries = chEntries()
    chEntriesCache.order = chEntriesCache.entries.map((e) => e.key)
    const total = chEntriesCache.entries.length
    chFilterClear.hidden = !S.ch.query
    chFilterCount.textContent = S.ch.query ? `${total}` : ''
    chSelectAll.checked = total > 0 && S.ch.selected.size >= total
    chSelectAll.indeterminate = S.ch.selected.size > 0 && S.ch.selected.size < total
    renderBox()
    if (!S.status) {
      fill(groupsEl)
      return
    }
    const sections = GROUPS.map(chSection).filter(Boolean)
    if (!sections.length) {
      const clean = !dirty(S.status)
      fill(groupsEl, h('div', { class: 'gt-ch-empty small' }, icon(clean ? 'check' : 'search'), h('div', { class: 'gt-ch-note' }, clean ? 'Working tree clean' : 'No files match the filter')))
    } else {
      fill(groupsEl, ...sections)
    }
    if (S.status.truncated) groupsEl.append(h('div', { class: 'gt-ch-note pad' }, 'The list is cut off: too many changed files.'))
    renderSelbar()
  }

  let chDiffToken = 0
  async function loadChangesDiff(keepScroll = false) {
    if (!S.repo || S.view !== 'changes' || !S.status) return
    const e = allEntries().find((x) => x.key === S.ch.file)
    if (!e) return wipDiff.message(dirty(S.status) ? 'Select a file to see its changes.' : 'The working tree is clean.')
    if (e.conflict) {
      return wipDiff.show(parseDiff(''), {
        path: e.path, mode: 'worktree', noticeTitle: 'Merge conflict',
        notice: 'This file has merge conflicts. Take ours or theirs here, or resolve the markers in your editor, then stage the file.',
        actions: [
          h('button', { class: 'gt-btn sm', type: 'button', onClick: () => resolveFile(e, 'ours') }, 'Take ours'),
          h('button', { class: 'gt-btn sm', type: 'button', onClick: () => resolveFile(e, 'theirs') }, 'Take theirs'),
        ],
      })
    }
    const mine = ++chDiffToken
    try {
      const r = await rpc('diff', { path: e.path, ...(e.group === 'staged' ? { staged: true } : e.group === 'untracked' ? { untracked: true } : {}), ignoreWhitespace: wipDiff.ignoreWhitespace })
      if (mine !== chDiffToken || disposed) return
      const notice = r.tooLarge ? `This file is too large to show (${Math.round(r.size / 1048576)} MB).` : r.truncated ? 'This diff is too large to show completely.' : ''
      wipDiff.show(parseDiff(r.text), { path: e.path, mode: e.group === 'staged' ? 'staged' : 'worktree', keepScroll: keepScroll || undefined, notice: notice && !r.text ? notice : '' })
    } catch (err) {
      if (mine !== chDiffToken || disposed) return
      wipDiff.message(errorText(err))
    }
  }

  async function resolveFile(e, side) {
    await mutateOp(() => rpc('resolve', { path: e.path, side }), side === 'ours' ? `Took ours in ${splitPath(e.path).name}` : `Took theirs in ${splitPath(e.path).name}`)
  }

  function stagePaths(paths) {
    if (!paths.length) return
    mutateOp(() => rpc('stage', { paths }), `Staged ${plural(paths.length, 'file')}`)
  }

  function discardSelected() {
    const entries = allEntries().filter((e) => S.ch.selected.has(e.key) && !e.conflict)
    if (!entries.length) return
    discardEntries(entries)
  }

  async function discardEntries(entries, { confirm = true } = {}) {
    // Unstage first: a staged change lives only in the index, and a staged new file is untracked once unstaged.
    const staged = entries.filter((e) => e.group === 'staged')
    const rest = entries.filter((e) => e.group !== 'staged')
    const clean = new Set(rest.filter((e) => e.untracked).map((e) => e.path))
    const restore = new Set()
    for (const e of staged) {
      if (e.status === 'A' || e.status === 'R') {
        clean.add(e.path)
        if (e.status === 'R' && e.orig) restore.add(e.orig) // the rename source comes back
      } else if (!clean.has(e.path)) restore.add(e.path)
    }
    for (const e of rest) if (!e.untracked && !clean.has(e.path)) restore.add(e.path)
    if (!staged.length && !restore.size && !clean.size) return
    if (confirm) {
      const v = await overlay.dialog({ title: `Discard ${plural(entries.length, 'file')}?`, text: 'Throws away the working-tree changes' + (clean.size ? ' and deletes the untracked files' : '') + '. This cannot be undone.', ok: 'Discard', danger: true })
      if (!v) return
    }
    if (staged.length) await mutateOp(() => rpc('unstage', { paths: staged.map((e) => e.path) }))
    if (restore.size) await mutateOp(() => rpc('discard', { paths: [...restore] }))
    if (clean.size) await mutateOp(() => rpc('discard', { untracked: [...clean] }))
    toast('info', `Discarded ${plural(entries.length, 'file')}`)
  }

  function openFileInChanges(path, staged) {
    const entries = allEntries()
    const e = entries.find((x) => x.path === path && (staged ? x.group === 'staged' : true)) ?? entries.find((x) => x.path === path)
    if (!e) return toast('info', 'That file has no changes in this view.')
    S.ch.file = e.key
    S.ch.selected = new Set([e.key])
    S.ch.anchor = e.key
    if (S.view !== 'changes') switchView('changes')
    else {
      renderChanges()
      loadChangesDiff()
    }
    groupsEl.querySelector(`[data-key="${CSS.escape(e.key)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  chFilter.addEventListener('input', () => ((S.ch.query = chFilter.value), renderChanges()))
  chFilter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (chFilter.value) (chFilter.value = '', (S.ch.query = ''), renderChanges())
      else groupsEl.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveChFile(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveChFile(-1)
    }
  })
  chFilterClear.addEventListener('click', () => ((chFilter.value = ''), (S.ch.query = ''), renderChanges(), chFilter.focus()))
  chSelectAll.addEventListener('click', (e) => {
    e.stopPropagation()
    const on = chSelectAll.checked
    S.ch.selected = on ? new Set(chEntriesCache.order) : new Set()
    S.ch.anchor = null
    renderChanges()
  })
  groupsEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('input, button')) return
    const row = e.target.closest('.gt-frow')
    if (!row) return
    const entry = chEntriesCache.entries.find((x) => x.key === row.dataset.key)
    if (entry) chClick(entry, e)
  })
  groupsEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.gt-frow')
    if (!row) return
    e.preventDefault()
    const entry = chEntriesCache.entries.find((x) => x.key === row.dataset.key)
    if (entry) fileMenu(e, entry)
  })
  groupsEl.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? '')) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') (e.preventDefault(), moveChFile(e.key === 'ArrowDown' ? 1 : -1))
    else if (e.key === ' ') (e.preventDefault(), stageSelected())
    else if (e.key === 'Delete' || e.key === 'Backspace') (e.preventDefault(), discardSelected())
  })

  /** Moves the diff selection through the visible entries. */
  function moveChFile(dir) {
    const order = chEntriesCache.order
    if (!order.length) return
    let i = order.indexOf(S.ch.file)
    i = i < 0 ? (dir > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, i + dir))
    S.ch.file = order[i]
    S.ch.selected = new Set([order[i]])
    S.ch.anchor = order[i]
    renderChanges()
    loadChangesDiff()
    groupsEl.querySelector(`[data-key="${CSS.escape(order[i])}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  /** Space: stage the selected unstaged files, or unstage them when every selected file is staged. */
  function stageSelected() {
    const entries = allEntries().filter((e) => S.ch.selected.has(e.key) && !e.conflict)
    if (!entries.length) return
    const unstaged = entries.filter((e) => e.group !== 'staged')
    if (unstaged.length) stagePaths(unstaged.map((e) => e.path))
    else mutateOp(() => rpc('unstage', { paths: entries.map((e) => e.path) }), `Unstaged ${plural(entries.length, 'file')}`)
  }

  function fileMenu(anchor, e) {
    const items = []
    if (e.conflict) {
      items.push(
        { label: 'Take ours (your version)', icon: 'check', onClick: () => resolveFile(e, 'ours') },
        { label: 'Take theirs (their version)', icon: 'copy', onClick: () => resolveFile(e, 'theirs') },
      )
    } else if (e.group === 'staged') {
      items.push({ label: 'Unstage', icon: 'minus', onClick: () => mutateOp(() => rpc('unstage', { paths: [e.path] })) })
    } else {
      items.push({ label: 'Stage', icon: 'plus', onClick: () => mutateOp(() => rpc('stage', { paths: [e.path] })) })
    }
    if (!e.conflict) items.push({ label: e.untracked ? 'Delete untracked file' : 'Discard changes', icon: 'trash', danger: true, onClick: () => discardEntries([e]) })
    items.push({ sep: true }, { label: 'Copy path', icon: 'copy', onClick: () => copy(e.path, 'Copied the path') })
    overlay.menu(anchor, items)
  }

  // ------------------------------------------------------------------ History view
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
    graphFoot.textContent = S.loadingMore ? 'Loading more history…' : S.hasMore ? `Showing the newest ${S.commits.length.toLocaleString()} commits` : ''
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
    if (c.wip) {
      // The working tree lives in the Changes view.
      S.sel = { kind: 'wip' }
      switchView('changes')
      renderRows()
      return
    }
    S.sel = { kind: 'commit', hash: c.hash }
    S.commitFile = null
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
      searchCount.textContent = 'Searching…'
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
    if (S.view !== 'history') switchView('history')
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
    try {
      await rpc('deleteBranch', { name })
      announce(S.repo?.root, S)
      toast('info', `Deleted ${name}`)
      await refresh()
    } catch (e) {
      if (/unmerged|merged/i.test(errorText(e))) {
        const force = await overlay.dialog({ title: `Force-delete branch ${name}?`, text: 'It has commits not on its upstream. Force-deleting loses them if the branch is never merged.', ok: 'Delete anyway', danger: true })
        if (force) {
          try {
            await rpc('deleteBranch', { name, force: true })
            announce(S.repo?.root, S)
            toast('info', `Deleted ${name}`)
          } catch (e2) {
            fail(e2)
          }
          await refresh()
        }
      } else fail(e)
      await refresh()
    }
  }
  async function renameBranch(name) {
    const v = await overlay.dialog({ title: `Rename branch ${name}`, text: 'Renames any local branch.', fields: [{ name: 'to', label: 'New name', placeholder: 'feature/name', value: name }], ok: 'Rename' })
    if (!v || !v.to || v.to === name) return
    await mutateOp(() => rpc('renameBranch', { name, to: v.to }), `Renamed to ${v.to}`)
  }
  async function deleteRemoteBranch(name) {
    const ok = await overlay.dialog({ title: `Delete ${name} on the remote?`, text: 'This deletes the branch on the remote. Other people may still have it.', ok: 'Delete on remote', danger: true })
    if (!ok) return
    const r = await mutateOp(() => rpc('deleteRemoteBranch', { name }))
    if (r && r.output) toast('info', r.output.split('\n').filter(Boolean).slice(-1)[0] || `Deleted ${name}`)
  }
  async function deleteTag(name) {
    const ok = await overlay.dialog({ title: `Delete tag ${name}?`, text: 'The tag is removed locally. Deleting it on the remote takes a push.', ok: 'Delete tag', danger: true })
    if (!ok) return
    await mutateOp(() => rpc('deleteTag', { name }), `Deleted tag ${name}`)
  }
  async function mergeRef(ref) {
    const current = S.status?.branch.head
    const ok = await overlay.dialog({ title: `Merge ${ref} into ${current ?? 'HEAD'}?`, text: 'Fast-forwards when possible, otherwise creates a merge commit. Conflicts stop the merge — the banner shows what is left.' })
    if (!ok) return
    const r = await mutateOp(() => rpc('merge', { ref }))
    if (r && r.conflicts) toast('info', 'The merge stopped on conflicts — resolve them in the Changes view.')
  }

  function commitMenu(anchor, c) {
    const chips = parseDecoration(c.refs, S.refs.remoteNames)
    const items = [
      { label: 'Check out this commit', icon: 'check', onClick: () => mutateOp(() => rpc('checkout', { ref: c.hash }), `Checked out ${c.hash.slice(0, 7)} (detached HEAD)`) },
      { label: 'New branch here…', icon: 'branch', onClick: () => newBranch(c.hash, 'New branch here') },
      { label: 'Create tag here…', icon: 'tag', onClick: () => newTag(c.hash) },
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
      { label: 'Stash changes…', icon: 'stash', disabled: !dirty(S.status), onClick: stashChanges },
      { sep: true },
    ]
    if (S.refs.stashes.length) {
      items.push({ header: 'Stashes' })
      S.refs.stashes.forEach((s) => items.push({ label: `Pop ${s.ref}: ${s.message.replace(/^On [^:]+: /, '')}`, icon: 'pull', onClick: () => stashPop(s) }))
      items.push({ sep: true }, { label: 'Manage stashes in Branches', icon: 'branch', onClick: () => switchView('refs') })
    } else items.push({ label: 'No stashes', disabled: true })
    overlay.menu(anchor, items, { align: 'right' })
  }

  async function stashChanges() {
    const v = await overlay.dialog({ title: 'Stash changes', text: 'Saves the staged and unstaged changes (including untracked files) and cleans the working tree.', fields: [{ name: 'message', label: 'Message (optional)', placeholder: 'wip', required: false }], ok: 'Stash' })
    if (!v) return
    await mutateOp(() => rpc('stashPush', v.message ? { message: v.message } : {}), 'Stashed the working tree')
  }
  async function stashPop(s) {
    const ok = await overlay.dialog({ title: `Pop ${s.ref}?`, text: `Applies "${(s.message ?? s.title ?? '').replace(/^On [^:]+: /, '')}" and removes the stash entry.` })
    if (!ok) return
    await mutateOp(() => rpc('stashPop', { ref: s.ref }), `Popped ${s.ref}`)
  }
  async function stashApply(s) {
    await mutateOp(() => rpc('stashApply', { ref: s.ref }), `Applied ${s.ref}`)
  }
  async function stashDrop(s) {
    const ok = await overlay.dialog({ title: `Drop ${s.ref}?`, text: `Deletes "${(s.message ?? s.title ?? '').replace(/^On [^:]+: /, '')}". This cannot be undone.`, ok: 'Drop stash', danger: true })
    if (!ok) return
    await mutateOp(() => rpc('stashDrop', { ref: s.ref }), `Dropped ${s.ref}`)
  }

  function moreMenu(anchor) {
    overlay.menu(
      anchor,
      [
        { label: 'Refresh', icon: 'fetch', kbd: 'F5', disabled: !S.repo, onClick: () => refresh() },
        { sep: true },
        ...(S.repo
          ? [
              { label: 'New branch…', icon: 'branch', onClick: () => newBranch(null) },
              { label: 'Create tag…', icon: 'tag', onClick: () => newTag(null) },
              { label: 'Merge a branch…', icon: 'merge', onClick: () => mergeMenu(anchor) },
              { sep: true },
              { label: 'Clone repository…', icon: 'globe', onClick: cloneFlow },
              { sep: true },
            ]
          : [{ label: 'Initialize repository here', icon: 'plus', onClick: initRepo }, { label: 'Clone repository…', icon: 'globe', onClick: cloneFlow }, { sep: true }]),
        { label: 'Search commits', icon: 'search', kbd: 'Ctrl F', disabled: !S.repo, onClick: openSearch },
        { label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', disabled: !S.repo, onClick: shortcutsModal },
        { sep: true },
        { label: 'Copy repository path', icon: 'copy', disabled: !S.repo, onClick: () => copy(S.repo.root, 'Copied the path') },
        ctx.openPath ? { label: 'Reveal in Files', icon: 'folder', disabled: !S.repo, onClick: () => ctx.openPath(S.repo.root) } : null,
      ],
      { align: 'right' },
    )
  }

  function mergeMenu(anchor) {
    const candidates = mergeCandidates(S.refs, S.status?.branch.head)
    const items = candidates.slice(0, 30).map((name) => ({ label: `Merge ${name}`, icon: 'merge', onClick: () => mergeRef(name) }))
    if (!items.length) items.push({ label: 'Nothing to merge', disabled: true })
    overlay.menu(anchor, [{ header: 'Merge into the current branch' }, ...items], { align: 'right' })
  }

  async function cloneFlow() {
    const v = await overlay.dialog({ title: 'Clone a repository', text: 'Clones into a folder you pick.', fields: [{ name: 'url', label: 'Repository URL', placeholder: 'https://… or user/host:repo.git', required: true }, { name: 'name', label: 'Folder name (optional)', placeholder: 'defaults to the repository name', required: false }], ok: 'Choose folder' })
    if (!v || !v.url) return
    let dir = null
    try {
      const p = await rpc('pickFolder', { title: 'Clone into…', create: true })
      dir = p && p.path
    } catch (e) {
      return fail(e)
    }
    if (!dir) return
    try {
      const r = await rpc('clone', { url: v.url, dir, name: v.name || undefined })
      toast('info', `Cloned into ${r.path.split(/[\\/]/).pop()}`)
      ctx.openBlock?.('git', { cwd: r.path })
    } catch (e) {
      fail(e)
    }
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
        return h('div', { class: 'gt-branch-pop' }, h('div', { class: 'gt-pop-head' }, icon('search'), input), list, h('div', { class: 'gt-pop-foot' }, h('button', { class: 'gt-btn sm quiet', onClick: () => (close(), newBranch(null)) }, icon('plus'), 'New branch…'), h('button', { class: 'gt-btn sm quiet', onClick: () => (close(), newTag(null)) }, icon('tag'), 'New tag…')))
      },
      { cls: 'wide' },
    )
  }

  // ------------------------------------------------------------------ detail: shared pieces
  function commitHeadNodes(d) {
    const [subject, ...rest] = d.message.split('\n')
    const body = rest.join('\n').trim()
    const chips = parseDecoration(d.refs, S.refs.remoteNames)
    const idx = S.index.get(d.hash)
    const color = idx !== undefined ? laneColor(S.layout.rows[idx].color) : 'var(--accent)'
    return [
      h('div', { class: 'gt-d-subject' }, subject),
      body ? h('pre', { class: 'gt-d-body' }, body) : null,
      h(
        'div',
        { class: 'gt-d-meta' },
        avatar(d.author, d.email, 22),
        h('span', { class: 'gt-d-author' }, d.author),
        h('span', { class: 'gt-dim', title: fullDate(d.time) }, `${relativeTime(d.time)} ago · ${fullDate(d.time)}`),
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
    ]
  }

  function fileRowCommit(f, onPick, selected) {
    const { dir, name } = splitPath(f.path)
    return h(
      'div',
      { class: 'gt-frow' + (selected ? ' sel' : ''), dataset: { path: f.path }, title: `${STATUS_NAME[f.status] ?? f.status}${f.oldPath ? ` (from ${f.oldPath})` : ''}\n${f.path}`, onClick: () => onPick(f.path) },
      h('span', { class: `gt-st ${statusClass(f.status)}` }, f.status),
      h('span', { class: 'gt-fname' }, dir ? h('span', { class: 'dim' }, dir) : null, h('b', {}, name), f.oldPath ? h('span', { class: 'dim' }, ` ← ${f.oldPath}`) : null),
      f.binary ? h('span', { class: 'gt-stat' }, h('i', {}, 'bin')) : h('span', { class: 'gt-stat' }, f.add ? h('i', { class: 'add' }, `+${f.add}`) : null, f.del ? h('i', { class: 'del' }, `−${f.del}`) : null),
    )
  }

  function fileListNodes(d, onPick, isSel) {
    const add = d.files.reduce((a, f) => a + f.add, 0)
    const del = d.files.reduce((a, f) => a + f.del, 0)
    return [
      h('div', { class: 'gt-flist-head' }, h('span', {}, plural(d.files.length, 'file'), ' changed'), h('span', { class: 'gt-stat' }, add ? h('i', { class: 'add' }, `+${add}`) : null, del ? h('i', { class: 'del' }, `−${del}`) : null)),
      h('div', { class: 'gt-flist-body' }, d.files.map((f) => fileRowCommit(f, onPick, isSel?.(f)))),
      d.truncated ? h('div', { class: 'gt-ch-note pad' }, 'The file list is cut off.') : null,
    ]
  }

  // ------------------------------------------------------------------ detail: commit (History)
  function renderDetail() {
    if (S.sel.kind === 'wip') {
      fill(commitHead,
        h('div', { class: 'gt-ch-empty small' }, icon('changes'), h('div', { class: 'gt-ch-note' }, 'The working tree lives in the Changes view.'),
          h('button', { class: 'gt-btn sm', type: 'button', onClick: () => switchView('changes') }, 'Review changes')))
      fill(commitFiles)
      commitDiff.message('')
      return
    }
    const d = S.detail
    fill(commitHead, ...(d ? commitHeadNodes(d) : [h('div', { class: 'gt-ch-note pad' }, 'Loading commit…')]))
    fill(commitFiles, ...(d ? fileListNodes(d, pickCommitFile, (f) => f.path === S.commitFile) : []))
    if (!d) return
    if (!d.files.length) commitDiff.message('This commit changes no files.')
  }

  function pickCommitFile(path) {
    S.commitFile = path
    renderDetail()
    loadSelection()
  }

  // ------------------------------------------------------------------ detail: commit (Branches)
  function renderRefsDetail() {
    const r = refsDetailRow
    if (!r?.detail) {
      fill(refsHead, h('div', { class: 'gt-ch-note pad' }, r ? 'Loading commit…' : 'Select a branch, tag or stash to see its commit.'))
      fill(refsFiles)
      refsDiff.message('')
      return
    }
    const d = r.detail
    fill(refsHead, ...commitHeadNodes(d))
    fill(refsFiles, ...fileListNodes(d, (p) => loadRefsDiff(r, p), (f) => f.path === S.rf.file))
  }

  let refsDetailRow = null
  let refsLoading = false
  async function loadRefsDetail() {
    if (!S.repo || S.view !== 'refs') return
    const r = S.rf.sel ? findRefRow(S.rf.sel) : null
    if (!r) {
      refsDetailRow = null
      renderRefsDetail()
      return
    }
    if (r.detail) {
      refsDetailRow = r
      renderRefsDetail()
      loadRefsDiff(r, r.detail.files[0]?.path)
      return
    }
    if (refsLoading) return
    refsLoading = true
    refsDetailRow = r
    renderRefsDetail()
    try {
      const mine = ++refsDiffToken
      const d = await rpc('commit', { hash: r.hash })
      if (mine !== refsDiffToken || disposed) return
      r.detail = d
      if (S.rf.sel === r.id) {
        refsDetailRow = r
        renderRefsDetail()
        loadRefsDiff(r, d.files[0]?.path)
      }
    } catch (e) {
      refsDetailRow = r
      fill(refsHead, h('div', { class: 'gt-ch-note pad' }, errorText(e)))
    } finally {
      refsLoading = false
    }
  }

  function findRefRow(id) {
    if (!id) return null
    const [kind, ...rest] = id.split(':')
    const name = rest.join(':')
    if (kind === 'branch') {
      const b = S.refs.branches.find((x) => x.name === name)
      return b ? { id, kind, name: b.name, hash: b.hash, detail: null } : null
    }
    if (kind === 'remote') {
      const b = S.refs.remotes.find((x) => x.name === name)
      return b ? { id, kind, name: b.name, hash: b.hash, detail: null } : null
    }
    if (kind === 'tag') {
      const t = S.refs.tags.find((x) => x.name === name)
      return t ? { id, kind, name: t.name, hash: t.hash, detail: null } : null
    }
    if (kind === 'stash') {
      const s = S.refs.stashes.find((x) => x.ref === name)
      return s ? { id, kind, name: s.ref, ref: s.ref, message: s.message, title: s.message.replace(/^On [^:]+: /, ''), hash: s.hash, detail: null } : null
    }
    return null
  }

  let refsDiffTokenLocal = 0
  async function loadRefsDiff(r, path) {
    if (path) S.rf.file = path
    try {
      const d = r.detail
      const f = d?.files.find((x) => x.path === path)
      if (!f) return refsDiff.message(d?.files.length ? 'Select a file.' : 'This commit changes no files.')
      if (f.binary) return refsDiff.show(parseDiff(''), { path: f.path, mode: 'commit', notice: 'Binary file: nothing to show.' })
      const res = await rpc('diff', { hash: d.hash, parent: d.parents[0], path: f.path, oldPath: f.oldPath, ignoreWhitespace: refsDiff.ignoreWhitespace })
      if (mine !== refsDiffTokenLocal || disposed) return
      refsDiff.show(parseDiff(res.text), { path: f.path, mode: 'commit', notice: res.truncated && !res.text ? 'This diff is too large to show.' : '' })
    } catch (e) {
      if (mine !== refsDiffTokenLocal || disposed) return
      refsDiff.message(errorText(e))
    }
  }

  // ------------------------------------------------------------------ Branches view
  function renderRefs() {
    const rows = refRows(S.refs, S.rf.query, S.rf.collapsed)
    rfFilterClear.hidden = !S.rf.query
    rfFilterCount.textContent = S.rf.query ? `${rows.filter((r) => r.type === 'item').length}` : ''
    if (!rows.length) {
      fill(rvList, h('div', { class: 'gt-ch-empty small' }, icon('branch'), h('div', { class: 'gt-ch-note' }, S.rf.query ? 'Nothing matches the filter.' : 'No branches, tags or stashes yet.')))
      return
    }
    fill(rvList, ...rows.map(refRow))
  }

  function refRow(r) {
    if (r.type === 'header') {
      const open = !S.rf.collapsed.has(r.id)
      return h('div', { class: 'gt-rv-head', role: 'button', tabIndex: -1, onClick: () => (S.rf.collapsed.has(r.id) ? S.rf.collapsed.delete(r.id) : S.rf.collapsed.add(r.id), renderRefs()) },
        h('span', { class: 'gt-chev' + (open ? ' open' : '') }, icon('chevR')), h('span', {}, r.title), h('span', { class: 'gt-count' }, r.count))
    }
    if (r.type === 'subheader') return h('div', { class: 'gt-rv-subhead' }, h('span', {}, r.title), r.url ? h('span', { class: 'gt-rv-url' }, r.url) : null)
    const ico = r.kind === 'branch' ? 'branch' : r.kind === 'remote' ? 'globe' : r.kind === 'tag' ? 'tag' : 'stash'
    const sub = r.kind === 'branch' ? [trackText(r), r.gone ? 'upstream gone' : '', relativeTime(r.date)].filter(Boolean).join('  ') : r.kind === 'stash' ? r.title || '' : relativeTime(r.date)
    const current = r.kind === 'branch' && r.current
    return h(
      'div',
      { class: 'gt-rv-row' + (current ? ' current' : '') + (S.rf.sel === r.id ? ' sel' : ''), role: 'option', 'aria-selected': S.rf.sel === r.id, dataset: { id: r.id }, title: r.name },
      icon(ico),
      h('span', { class: 'gt-rv-n' }, r.kind === 'remote' ? r.short : r.name),
      sub ? h('span', { class: 'gt-rv-sub' }, sub) : null,
      current ? h('span', { class: 'gt-pill ok' }, 'current') : null,
      h('span', { class: 'gt-grow' }),
      h('button', { class: 'gt-ibtn', type: 'button', title: 'Actions', onClick: (e) => (e.stopPropagation(), refMenu(e.currentTarget, r)) }, icon('more')),
    )
  }

  rvList.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.gt-rv-row')
    if (!row || e.button !== 0 || e.target.closest('button')) return
    selectRef(row.dataset.id)
  })
  rvList.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.gt-rv-row')
    if (!row) return
    const r = findRefRow(row.dataset.id)
    if (r && (r.kind === 'branch' || r.kind === 'remote')) checkoutRef({ type: r.kind, name: r.name, current: r.current })
  })
  rvList.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.gt-rv-row')
    if (!row) return
    e.preventDefault()
    const r = findRefRow(row.dataset.id)
    if (r) refMenu({ x: e.clientX, y: e.clientY }, r)
  })
  rvList.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? '')) return
    const rows = [...rvList.querySelectorAll('.gt-rv-row')]
    const i = rows.findIndex((x) => x.dataset.id === S.rf.sel)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = Math.max(0, Math.min(rows.length - 1, (i < 0 ? (e.key === 'ArrowDown' ? -1 : rows.length) : i) + (e.key === 'ArrowDown' ? 1 : -1)))
      const row = rows[n]
      if (row) selectRef(row.dataset.id)
    } else if (e.key === 'Enter' && i >= 0) {
      e.preventDefault()
      const r = findRefRow(S.rf.sel)
      if (r && (r.kind === 'branch' || r.kind === 'remote')) checkoutRef({ type: r.kind, name: r.name, current: r.current })
    }
  })

  function selectRef(id) {
    S.rf.sel = id
    renderRefs()
    loadRefsDetail()
    rvList.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  function refMenu(anchor, r) {
    const items = []
    const current = S.status?.branch.head
    if (r.kind === 'branch') {
      if (!r.current) items.push({ label: 'Check out', icon: 'check', onClick: () => checkoutRef({ type: 'branch', name: r.name }) })
      items.push(
        { label: 'New branch here…', icon: 'plus', onClick: () => newBranch(r.hash, 'New branch here') },
        { label: 'Create tag here…', icon: 'tag', onClick: () => newTag(r.hash) },
        { label: 'Rename…', icon: 'copy', onClick: () => renameBranch(r.name) },
      )
      if (!r.current && current) items.push({ label: `Merge into ${current}…`, icon: 'merge', onClick: () => mergeRef(r.name) })
      if (!r.current) items.push({ sep: true }, { label: 'Delete…', icon: 'trash', danger: true, onClick: () => deleteBranch(r.name) })
      items.push({ sep: true }, { label: 'Copy name', icon: 'copy', onClick: () => copy(r.name, 'Copied the branch name') })
    } else if (r.kind === 'remote') {
      items.push(
        { label: 'Check out (track)', icon: 'check', onClick: () => checkoutRef({ type: 'remote', name: r.name }) },
        { label: 'Delete on remote…', icon: 'trash', danger: true, onClick: () => deleteRemoteBranch(r.name) },
        { sep: true },
        { label: 'Copy name', icon: 'copy', onClick: () => copy(r.name, 'Copied the branch name') },
      )
    } else if (r.kind === 'tag') {
      items.push(
        { label: 'Check out (detached HEAD)', icon: 'check', onClick: () => checkoutRef({ type: 'tag', name: r.name }) },
        { label: 'Delete…', icon: 'trash', danger: true, onClick: () => deleteTag(r.name) },
        { sep: true },
        { label: 'Copy name', icon: 'copy', onClick: () => copy(r.name, 'Copied the tag name') },
      )
    } else if (r.kind === 'stash') {
      items.push(
        { label: 'Pop (apply and drop)', icon: 'pull', onClick: () => stashPop(r) },
        { label: 'Apply (keep the stash)', icon: 'check', onClick: () => stashApply(r) },
        { label: 'Drop…', icon: 'trash', danger: true, onClick: () => stashDrop(r) },
        { sep: true },
        { label: 'Copy ref', icon: 'copy', onClick: () => copy(r.name, 'Copied the stash ref') },
      )
    }
    overlay.menu(anchor, items)
  }

  rfFilter.addEventListener('input', () => ((S.rf.query = rfFilter.value), renderRefs()))
  rfFilter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (rfFilter.value) (rfFilter.value = '', (S.rf.query = ''), renderRefs())
      else rvList.focus()
    }
  })
  rfFilterClear.addEventListener('click', () => ((rfFilter.value = ''), (S.rf.query = ''), renderRefs(), rfFilter.focus()))

  // ------------------------------------------------------------------ banner, tabs, views
  function renderBanner() {
    const st = S.status
    const op = st?.operation
    const conf = st?.conflicted ?? 0
    if (!op && !conf) {
      banner.hidden = true
      return
    }
    banner.hidden = false
    banner.classList.toggle('op', !!op)
    banner.classList.toggle('conf', !op && conf > 0)
    if (op) {
      const t = operationText(op, conf)
      fill(banner,
        icon('alert'),
        h('span', { class: 'gt-banner-t' }, t.title),
        h('span', { class: 'gt-banner-d' }, t.detail),
        h('span', { class: 'gt-grow' }),
        t.canSkip ? h('button', { class: 'gt-btn sm quiet', type: 'button', onClick: () => operation('skip') }, 'Skip') : null,
        h('button', { class: 'gt-btn sm danger', type: 'button', onClick: () => operation('abort') }, 'Abort'),
        h('button', { class: 'gt-btn sm accent', type: 'button', disabled: conf > 0, title: conf > 0 ? 'Resolve the conflicts first' : '', onClick: () => operation('continue') }, t.continueLabel))
    } else {
      fill(banner,
        icon('alert'),
        h('span', { class: 'gt-banner-t' }, `${plural(conf, 'file')} with conflicts`),
        h('span', { class: 'gt-banner-d' }, 'Take ours or theirs in the Changes view, or resolve the markers in your editor, then stage the file.'),
        h('span', { class: 'gt-grow' }))
    }
  }

  async function operation(action) {
    const r = await mutateOp(() => rpc('operation', { action }))
    if (r && r.conflicts) toast('info', 'Conflicts remain — keep resolving.')
    else if (r) toast('info', action === 'abort' ? 'Aborted' : action === 'skip' ? 'Skipped' : 'Continued')
  }

  function renderTabs() {
    const g = groupStatus(S.status?.files ?? [])
    const total = g.conflicted.length + g.staged.length + g.unstaged.length + g.untracked.length
    for (const [id, label, ico] of VIEWS) {
      const b = tabBtns.get(id)
      const on = S.view === id
      b.classList.toggle('on', on)
      b.setAttribute('aria-selected', String(on))
      const n = b.querySelector('.gt-tab-n')
      if (id === 'changes') {
        n.hidden = !total
        n.textContent = total
        n.classList.toggle('bad', g.conflicted.length > 0)
        b.title = `${label} — ${total} changed file${total === 1 ? '' : 's'}${g.conflicted.length ? `, ${g.conflicted.length} conflicted` : ''} (Alt 1)`
      } else {
        n.hidden = true
        b.title = `${label} (Alt ${id === 'history' ? 2 : 3})`
      }
      fill(b, icon(ico), h('span', {}, label), n)
    }
    const tools = []
    if (S.view === 'history') tools.push({ icon: 'search', title: 'Search commits (Ctrl+F)', onClick: openSearch })
    if (S.view === 'refs') {
      tools.push({ icon: 'plus', title: 'New branch…', onClick: () => newBranch(null) })
      tools.push({ icon: 'tag', title: 'Create tag…', onClick: () => newTag(null) })
    }
    fill(viewTools, ...tools.map((t) => h('button', { class: 'gt-tool', type: 'button', title: t.title, onClick: t.onClick }, icon(t.icon))))
  }

  function switchView(v) {
    if (S.view === v) return
    S.view = v
    applyView()
    if (v === 'history') {
      rafThrottle(() => paintWindow())()
      loadSelection()
    }
    if (v === 'refs') loadRefsDetail()
    if (v === 'changes') loadChangesDiff(true)
  }

  function applyView() {
    const none = !S.repo
    chView.hidden = none || S.view !== 'changes'
    historyView.hidden = none || S.view !== 'history'
    refsView.hidden = none || S.view !== 'refs'
    renderTabs()
  }

  function shortcutsModal() {
    overlay.modal(
      h('div', {},
        h('div', { class: 'gt-dialog-title' }, 'Keyboard shortcuts'),
        h('div', { class: 'gt-short' }, ...SHORTCUTS.map(([k, what]) => h('div', { class: 'gt-short-row' }, h('kbd', { class: 'gt-kbd' }, k), h('span', {}, what)))),
        h('div', { class: 'gt-dialog-foot' }, h('button', { class: 'gt-btn', type: 'button', onClick: () => overlay.close() }, 'Close'))),
    )
  }

  // ------------------------------------------------------------------ whole render
  function render() {
    renderBar()
    renderBanner()
    applyView()
    searchBar.hidden = !S.repo || !S.search.open
    const none = !S.repo
    tabsEl.hidden = none
    emptyEl.hidden = !none
    if (none) {
      fill(emptyEl,
        icon('branch', 'gt-empty-ico'),
        h('div', { class: 'gt-empty-title' }, S.loading ? 'Opening repository…' : S.cwd ? 'This folder is not a Git repository' : 'No folder to open'),
        S.cwd ? h('div', { class: 'gt-empty-path' }, S.cwd) : null,
        !S.loading && S.cwd ? h('button', { class: 'gt-btn accent', type: 'button', onClick: initRepo }, 'Initialize repository') : null,
        S.error && S.cwd ? h('div', { class: 'gt-ch-note' }, S.error) : null)
      return
    }
    ctx.setTitle?.(`${S.repo.name} · ${S.status?.branch.head ?? 'git'}`)
    graphFootRender()
    if (!S.commits.length && !S.hasMore) rowsEl.dataset.empty = 'No commits yet. Stage some files and write the first one.'
    else delete rowsEl.dataset.empty
    renderRows()
    renderChanges()
    renderRefs()
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

  // ------------------------------------------------------------------ diff loading (history)
  /** Loads what the history selection needs: the commit's file list, and the diff of the selected file. */
  async function loadSelection() {
    if (!S.repo || S.view !== 'history' || S.sel.kind !== 'commit') return
    const mine = ++diffToken
    const sel = S.sel
    try {
      let d = detailCache.get(sel.hash)
      if (!d) {
        S.detail = null
        renderDetail()
        d = await rpc('commit', { hash: sel.hash })
        if (mine !== diffToken || disposed) return
        detailCache.set(sel.hash, d)
        if (detailCache.size > 60) detailCache.delete(detailCache.keys().next().value)
      }
      S.detail = d
      if (!S.commitFile || !d.files.some((f) => f.path === S.commitFile)) S.commitFile = d.files[0]?.path ?? null
      renderDetail()
      const f = d.files.find((x) => x.path === S.commitFile)
      if (!f) return commitDiff.message(d.files.length ? 'Select a file.' : 'This commit changes no files.')
      if (f.binary) return commitDiff.show(parseDiff(''), { path: f.path, mode: 'commit', notice: 'Binary file: nothing to show.' })
      const r = await rpc('diff', { hash: d.hash, parent: d.parents[0], path: f.path, oldPath: f.oldPath, ignoreWhitespace: commitDiff.ignoreWhitespace })
      if (mine !== diffToken || disposed) return
      commitDiff.show(parseDiff(r.text), { path: f.path, mode: 'commit', notice: r.truncated && !r.text ? 'This diff is too large to show.' : '' })
    } catch (e) {
      if (mine !== diffToken || disposed) return
      commitDiff.message(errorText(e))
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
  const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '') || document.activeElement?.isContentEditable
  root.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return
    if (e.key === '?' && !typing()) return shortcutsModal()
    if (typing()) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && !e.shiftKey && !e.altKey && k === 'b') return (e.preventDefault(), openBranchPicker())
    if (e.altKey && !mod && !e.shiftKey && (e.key === '1' || e.key === '2' || e.key === '3')) {
      e.preventDefault()
      return switchView(VIEWS[+e.key - 1][0])
    }
    if (mod && !e.shiftKey && k === 'f') {
      e.preventDefault()
      if (S.view === 'changes') return chFilter.focus()
      if (S.view === 'refs') return rfFilter.focus()
      return openSearch()
    }
    if (e.key === 'F5' || (mod && k === 'r')) return (e.preventDefault(), refresh())
    if (e.key === '/' && S.view === 'history') return (e.preventDefault(), openSearch())
    if (mod && k === 'z' && !e.shiftKey) return (e.preventDefault(), undoRedo('undo'))
    if (mod && k === 'z' && e.shiftKey) return (e.preventDefault(), undoRedo('redo'))
    if (S.view === 'changes') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return (e.preventDefault(), moveChFile(e.key === 'ArrowDown' ? 1 : -1))
      if (e.key === ' ') return (e.preventDefault(), stageSelected())
      if (mod && k === 'a') return (e.preventDefault(), (S.ch.selected = new Set(chEntriesCache.order)), renderChanges())
      if (e.key === 'Delete' || e.key === 'Backspace') return (e.preventDefault(), discardSelected())
    }
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

  // ---- sharing (local://chats-contract.md, "Sharing") -----------------------------------------------------------
  // Snapshot-only: a repository view is a one-time copy into the chat, never a live session — git state changes
  // constantly, so there is no op stream to replay. The payload is composed from the block's own open()/status()/
  // refs() results held in S (no extra daemon round-trip, no new git.cjs method).
  const shareAdapter = gitShare({
    snapshot: () => {
      const st = S.status || {}
      const g = groupStatus(st.files)
      return {
        path: S.repo?.root ?? S.cwd,
        branch: st.branch?.head ?? null,
        upstream: st.branch?.upstream ?? null,
        ahead: st.branch?.ahead ?? 0,
        behind: st.branch?.behind ?? 0,
        staged: g.staged.length,
        unstaged: g.unstaged.length,
        untracked: g.untracked.length,
        conflicts: g.conflicted.length,
        operation: st.operation ?? null,
        truncated: !!st.truncated,
      }
    },
  })
  const unshare = ctx.paneId ? registerInstance(ctx.paneId, 'git', (S.repo && S.repo.name) || args.cwd || S.cwd || 'Git', GIT_SHARE_MODES, shareAdapter) : null
  return {
    share: shareAdapter,
    focus: () => (S.repo ? (S.view === 'history' ? scroller : S.view === 'refs' ? rvList : groupsEl).focus() : root.focus()),
    resize: () => paintWindow(),
    refresh,
    /** Re-points the block at another folder (used when a pane follows a terminal). */
    async setCwd(next) {
      if (!next || next === S.cwd) return
      if (watched) ctx.rpc('unwatch', { cwd: watched }).catch(() => {})
      watched = null
      S.cwd = next
      S.repo = null
      S.status = null
      S.refs = { branches: [], remotes: [], tags: [], stashes: [], remoteNames: [], remoteInfo: [] }
      S.commits = []
      S.hasMore = false
      S.layout = null
      S.all = []
      S.index = new Map()
      S.detail = null
      S.undo = { undo: null, redo: null }
      S.sel = { kind: 'wip' }
      S.commitFile = null
      S.ch = { query: '', selected: new Set(), anchor: null, file: null, collapsed: {} }
      S.rf = { query: '', collapsed: new Set(), sel: null, file: null }
      S.box = { summary: '', body: '', amend: false, signoff: false, committing: false, writing: false, prefilled: null }
      if (S.composer) {
        S.composer.summary.value = ''
        S.composer.why.value = ''
      }
      S.view = 'changes'
      chFilter.value = ''
      rfFilter.value = ''
      discardArmed = null
      detailCache.clear()
      refsDetailRow = null
      refsLoading = false
      S.busy.clear()
      S.search.open = false
      searchBar.hidden = true
      loadToken++
      diffToken++
      chDiffToken++
      refsDiffToken++
      refsDiffTokenLocal++
      wipDiff.message('')
      commitDiff.message('')
      refsDiff.message('')
      await refresh()
      watchRepo()
    },
    dispose() {
      if (typeof unshare === 'function') { try { unshare() } catch { /* already unregistered */ } }
      disposed = true
      offEvent()
      offAnnounce()
      if (watched) ctx.rpc('unwatch', { cwd: watched }).catch(() => {})
      overlay.close()
      root.remove()
    },
  }
}

// ---------------------------------------------------------------------------------------------------- sharing

const GIT_SHARE_MODES = ['snapshot']

/**
 * The share adapter factory for the git block (local://chats-contract.md, "Sharing"). Snapshot-only: live git makes
 * no sense over the wire — a repository view ships one status summary and there is no op stream to replay, so
 * applyOp/applySnapshot stay defensive no-ops (the same pattern files.js uses for its snapshot-only file views).
 */
function gitShare(hooks = {}) {
  return {
    modes: GIT_SHARE_MODES,
    snapshot: () => (hooks.snapshot ? hooks.snapshot() : null),
    applyOp: () => {},
    applySnapshot: () => {},
  }
}
registerShare('git', gitShare)
