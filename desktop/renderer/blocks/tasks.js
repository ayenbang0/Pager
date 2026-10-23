// Task manager block: processes with CPU, memory and GPU, as a sortable list or a parent/child tree, with a detail
// card for the selection and Stop / Force Quit behind a confirmation. Sampling is pull-based and runs only while
// the pane is on screen: a hidden Task manager makes no requests and keeps no timer.
import { h, fromHTML, reconcile } from '../ui/dom.js'

const CSS = new URL('./tasks.css', import.meta.url).href
if (!document.querySelector(`link[href="${CSS}"]`)) document.head.append(h('link', { rel: 'stylesheet', href: CSS }))

const svg = (body) => `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICONS = {
  tasks: svg('<path d="M2 11.5h2.2l1.6-6 2.6 8 2-5.5 1.1 3.5H14"/><rect x="1.5" y="2" width="13" height="12" rx="2.2" opacity=".0"/>'),
  chev: svg('<path d="M6 4l4 4-4 4"/>'),
  search: svg('<circle cx="7" cy="7" r="4.3"/><path d="M10.3 10.3L13.5 13.5"/>'),
  list: svg('<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><path d="M2.4 4h.1M2.4 8h.1M2.4 12h.1"/>'),
  tree: svg('<path d="M3 3v7.5c0 .8.7 1.5 1.5 1.5H7M3 7h4"/><rect x="7" y="5.5" width="6.5" height="3" rx="1"/><rect x="7" y="10.5" width="6.5" height="3" rx="1"/>'),
  warn: svg('<path d="M8 2.2l6 10.6H2z"/><path d="M8 6.5v3M8 11.3h.01"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  pause: svg('<path d="M5.5 3.5v9M10.5 3.5v9"/>'),
  play: svg('<path d="M5 3.5l7 4.5-7 4.5z"/>'),
}
const ico = (k) => fromHTML(ICONS[k])

const ROW = 28
const INTERVAL = 2000
const TILE_COLORS = ['#5a8cff', '#3ecf8e', '#f5a524', '#b98cff', '#35c7e6', '#ff7040', '#e5487f', '#8a8a92']

const KiB = 1024
function fmtMem(b) {
  if (b >= 1024 * KiB * KiB) return (b / (1024 * KiB * KiB)).toFixed(b >= 10 * 1024 * KiB * KiB ? 0 : 1) + ' GB'
  if (b >= 100 * KiB * KiB) return Math.round(b / (KiB * KiB)) + ' MB'
  if (b >= KiB * KiB) return (b / (KiB * KiB)).toFixed(1) + ' MB'
  return Math.round(b / KiB) + ' KB'
}
const fmtPct = (v) => (v >= 10 ? Math.round(v) + '%' : v > 0 ? v.toFixed(1) + '%' : '0%')
const hue = (s) => {
  let n = 0
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0
  return TILE_COLORS[n % TILE_COLORS.length]
}
const shortName = (n) => n.replace(/\.exe$/i, '')
/** Command line minus its executable (quoted or not). */
function argsOf(cmd) {
  if (!cmd) return ''
  const m = /^\s*(?:"[^"]*"|\S+)\s*(.*)$/.exec(cmd)
  return m ? m[1] : ''
}
const KIND_LABEL = { self: 'Pager', daemon: 'Pager daemon', child: 'Runs in Pager' }
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')

function mount(el, ctx) {
  const state = {
    snap: null,
    view: 'list',
    sort: { key: 'cpu', dir: -1 },
    filter: '',
    selected: null, // pid
    expanded: new Set(),
    detail: null,
    error: null,
    confirm: null, // { action, pid, tree }
    busy: false,
  }
  let disposed = false
  let timer = 0
  let inflight = false
  let visible = true
  let rows = []

  // ------------------------------------------------------------ skeleton
  const root = h('div', { class: 'tk' })
  const bar = h('div', { class: 'tk-bar' })
  const head = h('div', { class: 'tk-head' })
  const scroller = h('div', { class: 'tk-scroll', tabIndex: 0, onScroll: () => paintRows() })
  const spacer = h('div', { class: 'tk-spacer' })
  const inner = h('div', { class: 'tk-inner' })
  scroller.append(spacer, inner)
  const empty = h('div', { class: 'tk-empty', hidden: true })
  const detail = h('div', { class: 'tk-detail', hidden: true })
  const foot = h('div', { class: 'tk-foot mono' })
  const dialog = h('div', { class: 'tk-scrim', hidden: true })
  root.append(bar, h('div', { class: 'tk-table' }, head, scroller, empty), detail, foot, dialog)
  el.append(root)

  // ------------------------------------------------------------ meters / bar
  const mCpu = meter('CPU')
  const mMem = meter('Memory')
  const mGpu = meter('GPU')
  function meter(label) {
    const val = h('span', { class: 'tk-m-v mono' }, '–')
    const fill = h('i')
    return { el: h('div', { class: 'tk-m' }, h('span', { class: 'tk-m-l' }, label), val, h('span', { class: 'tk-m-bar' }, fill)), val, fill }
  }
  const seg = h(
    'div',
    { class: 'seg' },
    ...['list', 'tree'].map((v) =>
      h(
        'button',
        { class: 'seg-b' + (v === state.view ? ' on' : ''), dataset: { view: v }, title: v === 'list' ? 'List' : 'Tree', onClick: () => setView(v) },
        ico(v),
        h('span', null, v === 'list' ? 'List' : 'Tree'),
      ),
    ),
  )
  const search = h('input', {
    class: 'tk-search',
    placeholder: 'Filter processes',
    spellcheck: false,
    onInput: (e) => {
      state.filter = e.target.value.trim().toLowerCase()
      rebuild()
    },
  })
  bar.append(mCpu.el, mMem.el, mGpu.el, h('div', { class: 'tk-gap' }), h('label', { class: 'tk-find' }, ico('search'), search), seg)

  function setView(v) {
    state.view = v
    seg.querySelectorAll('.seg-b').forEach((b) => b.classList.toggle('on', b.dataset.view === v))
    rebuild()
  }

  function paintMeters() {
    const s = state.snap
    if (!s) return
    mCpu.val.textContent = fmtPct(s.cpu)
    mCpu.fill.style.transform = `scaleX(${Math.min(1, s.cpu / 100)})`
    const pct = (s.mem.used / s.mem.total) * 100
    mMem.val.textContent = `${fmtMem(s.mem.used)} · ${Math.round(pct)}%`
    mMem.fill.style.transform = `scaleX(${Math.min(1, pct / 100)})`
    if (s.gpu === false) {
      mGpu.val.textContent = 'n/a'
      mGpu.fill.style.transform = 'scaleX(0)'
      mGpu.el.title = 'Windows reports no GPU engine counters on this machine'
    } else if (s.gpu === null) {
      mGpu.val.textContent = '…'
    } else {
      mGpu.val.textContent = fmtPct(s.gpu)
      mGpu.fill.style.transform = `scaleX(${Math.min(1, s.gpu / 100)})`
    }
  }

  // ------------------------------------------------------------ table
  const COLS = [
    { key: 'name', label: 'Name', cls: 'c-name' },
    { key: 'pid', label: 'PID', cls: 'c-pid' },
    { key: 'cpu', label: 'CPU', cls: 'c-cpu' },
    { key: 'mem', label: 'Memory', cls: 'c-mem' },
    { key: 'gpu', label: 'GPU', cls: 'c-gpu' },
  ]
  function paintHead() {
    head.replaceChildren(
      ...COLS.map((c) =>
        h(
          'button',
          {
            class: `tk-th ${c.cls}` + (state.sort.key === c.key ? ' on' : ''),
            onClick: () => {
              state.sort = state.sort.key === c.key ? { key: c.key, dir: -state.sort.dir } : { key: c.key, dir: c.key === 'name' || c.key === 'pid' ? 1 : -1 }
              rebuild()
            },
          },
          c.label,
          state.sort.key === c.key ? h('span', { class: 'tk-sort' }, state.sort.dir < 0 ? '▾' : '▴') : null,
        ),
      ),
    )
  }

  const cmp = () => {
    const { key, dir } = state.sort
    return (a, b) => {
      let d
      if (key === 'name') d = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      else d = a[key] - b[key]
      return d * dir || b.mem - a.mem || a.pid - b.pid
    }
  }

  function matches(p) {
    const f = state.filter
    return !f || p.name.toLowerCase().includes(f) || String(p.pid) === f || p.cmd.toLowerCase().includes(f) || (KIND_LABEL[p.kind] || '').toLowerCase().includes(f)
  }

  /** The visible rows in order: { p, depth, kids, open } */
  function computeRows() {
    const s = state.snap
    if (!s) return []
    const sort = cmp()
    if (state.view === 'list') return s.procs.filter(matches).sort(sort).map((p) => ({ p, depth: 0, kids: 0, open: false }))
    const byPid = new Map(s.procs.map((p) => [p.pid, p]))
    const kids = new Map()
    const roots = []
    for (const p of s.procs) {
      const parent = byPid.get(p.ppid)
      if (parent && parent.pid !== p.pid && parent.create <= p.create) {
        if (!kids.has(parent.pid)) kids.set(parent.pid, [])
        kids.get(parent.pid).push(p)
      } else roots.push(p)
    }
    // with a filter: keep matches and their ancestors, everything expanded
    let keep = null
    if (state.filter) {
      keep = new Set()
      const up = (p) => {
        for (let hop = 0; p && hop < 64 && !keep.has(p.pid); hop++) {
          keep.add(p.pid)
          p = byPid.get(p.ppid)
        }
      }
      for (const p of s.procs) if (matches(p)) up(p)
    }
    const out = []
    const walk = (p, depth) => {
      if (keep && !keep.has(p.pid)) return
      const k = (kids.get(p.pid) || []).filter((c) => !keep || keep.has(c.pid)).sort(sort)
      const open = keep ? true : state.expanded.has(p.pid) || (state.selected !== null && isAncestor(p.pid, state.selected, byPid))
      out.push({ p, depth, kids: k.length, open })
      if (open) for (const c of k) walk(c, depth + 1)
    }
    roots.sort(sort).forEach((p) => walk(p, 0))
    return out
  }

  function isAncestor(anc, pid, byPid) {
    for (let p = byPid.get(pid), hop = 0; p && hop < 64; p = byPid.get(p.ppid), hop++) if (p.ppid === anc) return true
    return false
  }

  function createRow() {
    const tile = h('span', { class: 'tk-tile' })
    const chev = h('button', { class: 'tk-chev', tabIndex: -1 }, ico('chev'))
    const name = h('span', { class: 'tk-name' })
    const args = h('span', { class: 'tk-args mono' })
    const badge = h('span', { class: 'tk-badge', hidden: true })
    const row = h(
      'div',
      { class: 'tk-row' },
      h('div', { class: 'c-name' }, chev, tile, name, badge, args),
      h('div', { class: 'c-pid mono' }),
      h('div', { class: 'c-cpu mono' }, h('i'), h('b')),
      h('div', { class: 'c-mem mono' }, h('i'), h('b')),
      h('div', { class: 'c-gpu mono' }, h('i'), h('b')),
    )
    row.addEventListener('click', (e) => {
      const r = row.__row
      if (!r) return
      if (e.target.closest('.tk-chev')) {
        if (r.open) state.expanded.delete(r.p.pid)
        else state.expanded.add(r.p.pid)
        rebuild()
        return
      }
      select(r.p.pid)
    })
    row.addEventListener('dblclick', (e) => {
      const r = row.__row
      if (r && r.kids && !e.target.closest('.tk-chev')) {
        if (r.open) state.expanded.delete(r.p.pid)
        else state.expanded.add(r.p.pid)
        rebuild()
      }
    })
    row.__refs = { tile, chev, name, args, badge }
    return row
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text
  }

  function updateRow(row, r) {
    row.__row = r
    const { p } = r
    const R = row.__refs
    row.style.transform = `translateY(${r.y}px)`
    row.classList.toggle('sel', p.pid === state.selected)
    row.classList.toggle('pager', !!p.kind)
    const [cName, cPid, cCpu, cMem, cGpu] = row.children
    cName.style.paddingLeft = 8 + r.depth * 14 + 'px'
    R.chev.style.visibility = r.kids ? 'visible' : 'hidden'
    R.chev.classList.toggle('open', r.open)
    R.chev.style.display = state.view === 'tree' ? '' : 'none'
    const nm = shortName(p.name)
    setText(R.name, nm)
    R.tile.style.setProperty('--c', hue(nm))
    setText(R.tile, (nm[0] || '?').toUpperCase())
    setText(R.args, argsOf(p.cmd))
    R.badge.hidden = !p.kind
    if (p.kind) setText(R.badge, KIND_LABEL[p.kind])
    setText(cPid, String(p.pid))
    fillCell(cCpu, p.cpu, p.cpu / 100, p.cpu > 0 ? fmtPct(p.cpu) : '')
    fillCell(cMem, p.mem, p.mem / (state.snap.mem.total * 0.12), fmtMem(p.mem))
    const g = state.snap.gpu === false ? null : p.gpu
    cGpu.style.display = state.snap.gpu === false ? 'none' : ''
    if (g !== null) fillCell(cGpu, g, g / 100, g > 0 ? fmtPct(g) : '')
  }

  function fillCell(cell, value, frac, text) {
    const [fill, label] = cell.children
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, frac)).toFixed(3)})`
    setText(label, text)
  }

  function rebuild() {
    paintHead()
    rows = computeRows()
    rows.forEach((r, i) => (r.y = i * ROW))
    spacer.style.height = rows.length * ROW + 'px'
    empty.hidden = rows.length > 0 || !state.snap
    if (!rows.length && state.snap) empty.textContent = state.filter ? 'No process matches.' : 'No processes.'
    head.classList.toggle('no-gpu', !!state.snap && state.snap.gpu === false)
    scroller.classList.toggle('no-gpu', !!state.snap && state.snap.gpu === false)
    paintRows()
  }

  function paintRows() {
    if (disposed) return
    const top = scroller.scrollTop
    const hgt = scroller.clientHeight || 480
    const start = Math.max(0, Math.floor(top / ROW) - 6)
    const end = Math.min(rows.length, Math.ceil((top + hgt) / ROW) + 6)
    reconcile(inner, rows.slice(start, end), (r) => r.p.pid, createRow, updateRow)
  }

  // ------------------------------------------------------------ selection + detail
  async function select(pid) {
    state.selected = pid
    state.detail = null
    rebuild()
    paintDetail()
    try {
      const p = currentProc()
      const d = await ctx.rpc('detail', { pid })
      if (state.selected === pid && p) {
        state.detail = d
        paintDetail()
      }
    } catch {
      /* the process may have ended: the next sample drops the selection */
    }
  }

  const currentProc = () => (state.snap && state.selected !== null ? state.snap.procs.find((p) => p.pid === state.selected) || null : null)

  function protection(p) {
    if (p.critical) return `${shortName(p.name)} is a critical Windows process; ending it would crash or log you out.`
    if (p.kind === 'self') return 'This is part of Pager itself. Quit Pager from its window instead.'
    if (p.kind === 'daemon') return 'This is the Pager session daemon; it owns your terminals. Quit Pager, or run "pager daemon stop".'
    return null
  }

  function paintDetail() {
    const p = currentProc()
    if (!p) {
      detail.hidden = true
      detail.replaceChildren()
      return
    }
    detail.hidden = false
    const d = state.detail && state.detail.pid === p.pid ? state.detail : null
    const locked = protection(p)
    const nm = shortName(p.name)
    const tile = h('span', { class: 'tk-tile big', style: { '--c': hue(nm) } }, (nm[0] || '?').toUpperCase())
    const facts = [
      ['PID', String(p.pid)],
      ['Parent', d && d.parent ? `${shortName(d.parent)} (${p.ppid})` : String(p.ppid)],
      ['Threads', String(p.threads)],
      d && d.user ? ['User', d.user] : null,
      d && d.children ? ['Children', String(d.children)] : null,
    ].filter(Boolean)
    detail.replaceChildren(...[
      h(
        'div',
        { class: 'tk-d-main' },
        tile,
        h(
          'div',
          { class: 'tk-d-text' },
          h('div', { class: 'tk-d-name' }, nm, p.kind ? h('span', { class: 'tk-badge' }, KIND_LABEL[p.kind]) : null, d && d.suspended ? h('span', { class: 'tk-badge warn' }, 'Paused') : null),
          h('div', { class: 'tk-d-cmd mono', title: p.cmd || (d && d.path) || '' }, p.cmd || (d && d.path) || ''),
          h('div', { class: 'tk-d-facts' }, facts.map(([k, v]) => h('span', null, h('em', null, k), h('b', { class: 'mono', title: v }, v)))),
        ),
        h(
          'div',
          { class: 'tk-d-actions' },
          h('button', { class: 'tk-btn', disabled: !!locked, title: locked || 'Ask the program to close (Delete)', onClick: () => ask('stop') }, 'Stop', h('kbd', null, 'Del')),
          h('button', { class: 'tk-btn danger', disabled: !!locked, title: locked || 'End the process immediately', onClick: () => ask('kill') }, 'Force Quit', h('kbd', null, 'Shift Del')),
          h(
            'button',
            {
              class: 'tk-btn icon',
              disabled: !!locked,
              title: locked || (d && d.suspended ? 'Resume' : 'Pause'),
              onClick: () => pauseResume(d && d.suspended),
            },
            ico(d && d.suspended ? 'play' : 'pause'),
          ),
        ),
      ),
      locked ? h('div', { class: 'tk-d-lock' }, ico('warn'), locked) : null,
    ].filter(Boolean))
  }

  // ------------------------------------------------------------ actions
  function ask(action) {
    const p = currentProc()
    if (!p || protection(p)) return
    state.confirm = { action, pid: p.pid, create: p.create, tree: false }
    paintDialog()
  }

  function descendantsOf(pid) {
    const s = state.snap
    const kids = new Map()
    for (const p of s.procs) {
      if (!kids.has(p.ppid)) kids.set(p.ppid, [])
      kids.get(p.ppid).push(p)
    }
    const out = []
    const seen = new Set([pid])
    const walk = (id) => {
      for (const k of kids.get(id) || []) {
        if (seen.has(k.pid)) continue
        seen.add(k.pid)
        out.push(k)
        walk(k.pid)
      }
    }
    walk(pid)
    return out
  }

  function paintDialog() {
    const c = state.confirm
    if (!c) {
      dialog.hidden = true
      dialog.replaceChildren()
      return
    }
    const p = state.snap.procs.find((x) => x.pid === c.pid)
    if (!p) {
      state.confirm = null
      return paintDialog()
    }
    const nm = shortName(p.name)
    const desc = descendantsOf(p.pid)
    const blocked = c.tree ? desc.find((x) => x.kind === 'self' || x.kind === 'daemon' || x.critical) : null
    const kill = c.action === 'kill'
    const tree = h('input', { type: 'checkbox', checked: c.tree, onChange: (e) => ((c.tree = e.target.checked), paintDialog()) })
    const go = h('button', { class: 'tk-btn ' + (kill ? 'danger' : 'primary'), disabled: state.busy || !!blocked, onClick: () => run(c) }, kill ? 'Force Quit' : 'Stop')
    dialog.hidden = false
    dialog.replaceChildren(
      h(
        'div',
        { class: 'tk-dlg', role: 'alertdialog', 'aria-label': `${kill ? 'Force quit' : 'Stop'} ${nm}` },
        h('div', { class: 'tk-dlg-t' }, ico('warn'), `${kill ? 'Force quit' : 'Stop'} ${nm}?`),
        h(
          'div',
          { class: 'tk-dlg-b' },
          kill
            ? `${nm} (PID ${p.pid}) ends immediately. Anything it has not saved is lost.`
            : `Asks ${nm} (PID ${p.pid}) to close its windows, like clicking the close button. Programs without a window ignore this; use Force Quit for those.`,
        ),
        p.kind === 'child' ? h('div', { class: 'tk-dlg-note' }, 'This runs inside Pager (a terminal, agent or one of their programs). Its pane will show it as exited.') : null,
        desc.length
          ? h('label', { class: 'tk-dlg-opt' }, tree, h('span', null, `Also end ${desc.length} child process${desc.length === 1 ? '' : 'es'} (${desc.slice(0, 3).map((x) => shortName(x.name)).join(', ')}${desc.length > 3 ? ', …' : ''})`))
          : null,
        blocked ? h('div', { class: 'tk-dlg-note bad' }, `${shortName(blocked.name)} is below it and cannot be ended${blocked.critical ? ' (critical)' : ' (part of Pager)'}.`) : null,
        h('div', { class: 'tk-dlg-a' }, h('button', { class: 'tk-btn', onClick: () => ((state.confirm = null), paintDialog()) }, 'Cancel'), go),
      ),
    )
    go.focus()
  }

  async function run(c) {
    state.busy = true
    paintDialog()
    try {
      const res = await ctx.rpc(c.action, { pid: c.pid, create: c.create, tree: c.tree, confirm: true })
      if (c.action === 'stop') ctx.toast && ctx.toast('info', res.closed ? 'Asked it to close.' : 'It has no window to close. Use Force Quit to end it.')
      else if (res.failed && res.failed.length) ctx.toast && ctx.toast('error', `Windows refused for ${res.failed.length} process(es) (access denied).`)
      else ctx.toast && ctx.toast('info', 'Ended.')
    } catch (e) {
      ctx.toast && ctx.toast('error', cleanErr(e))
    }
    state.busy = false
    state.confirm = null
    paintDialog()
    sampleNow()
  }

  async function pauseResume(isPaused) {
    const p = currentProc()
    if (!p || protection(p)) return
    try {
      await ctx.rpc(isPaused ? 'resume' : 'suspend', { pid: p.pid, create: p.create, confirm: true })
      select(p.pid)
    } catch (e) {
      ctx.toast && ctx.toast('error', cleanErr(e))
    }
  }

  // ------------------------------------------------------------ sampling (only while visible)
  async function sampleNow() {
    if (disposed || inflight || !visible) return
    inflight = true
    try {
      const snap = await ctx.rpc('sample', { gpu: true })
      if (disposed) return
      state.snap = snap
      state.error = null
      if (state.selected !== null && !snap.procs.some((p) => p.pid === state.selected)) {
        state.selected = null
        state.detail = null
      }
      paintMeters()
      rebuild()
      paintDetail()
      if (state.confirm) paintDialog()
      paintFoot()
    } catch (e) {
      state.error = cleanErr(e)
      paintFoot()
    } finally {
      inflight = false
      schedule()
    }
  }

  function schedule() {
    clearTimeout(timer)
    timer = 0
    if (disposed || !visible) return
    timer = setTimeout(sampleNow, INTERVAL)
  }

  function setVisible(v) {
    if (v === visible) return
    visible = v
    if (v) sampleNow()
    else {
      clearTimeout(timer)
      timer = 0
    }
  }

  function paintFoot() {
    const s = state.snap
    if (state.error) {
      foot.textContent = state.error
      foot.classList.add('err')
      return
    }
    foot.classList.remove('err')
    if (!s) return (foot.textContent = 'Sampling…')
    const c = s.cost
    foot.textContent = `${s.procs.length} processes · every ${INTERVAL / 1000} s${c && c.helperCpuPct !== null ? ` · sampler ${c.helperCpuPct}% CPU, ${c.roundTripMs} ms, ${c.kbPerSample} KB per sample` : ''} · paused while hidden`
  }

  const io = new IntersectionObserver((entries) => setVisible(entries[entries.length - 1].isIntersecting && document.visibilityState === 'visible'))
  io.observe(root)
  const onVis = () => setVisible(document.visibilityState === 'visible' && root.getBoundingClientRect().width > 0)
  document.addEventListener('visibilitychange', onVis)

  root.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return
    if (state.confirm) {
      if (e.key === 'Escape') {
        state.confirm = null
        paintDialog()
      }
      return
    }
    const i = rows.findIndex((r) => r.p.pid === state.selected)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (n) {
        select(n.p.pid)
        const y = rows.indexOf(n) * ROW
        if (y < scroller.scrollTop) scroller.scrollTop = y
        else if (y + ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + ROW - scroller.clientHeight
      }
    } else if (e.key === 'Delete') ask(e.shiftKey ? 'kill' : 'stop')
    else if (e.key === 'ArrowRight' && i >= 0 && state.view === 'tree' && rows[i].kids && !rows[i].open) (state.expanded.add(rows[i].p.pid), rebuild())
    else if (e.key === 'ArrowLeft' && i >= 0 && state.view === 'tree' && rows[i].open) (state.expanded.delete(rows[i].p.pid), rebuild())
  })

  paintHead()
  paintFoot()
  sampleNow()

  return {
    dispose() {
      disposed = true
      clearTimeout(timer)
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      root.remove()
    },
    focus: () => scroller.focus(),
    resize: () => paintRows(),
  }
}

export default { id: 'tasks', title: 'Task manager', icon: ICONS.tasks, mount }
