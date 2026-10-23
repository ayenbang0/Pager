// Command palette, generic picker and theme picker. One overlay at a time, mounted in #overlay.
//   openPalette({ scope?, query? })   closePalette()   paletteOpen()
//   openPicker({ placeholder, items, current?, onHover?, onPick, onClose?, footer?, width? })   openThemePicker()
import { h, fromHTML } from './dom.js'
import { icon, agentTile } from './icons.js'
import { overlayEl, closeMenus } from './popover.js'
import { app } from './store.js'
import { allCommands, runCommand, recentCommands, splitChord } from './commands.js'
import { tabLabel, shortPath, isAgent, paneGlyph } from './labels.js'
import { THEMES, currentThemeId, previewTheme, pickTheme, resolvedMode } from './appearance.js'

// ------------------------------------------------------------------ fuzzy matching

const isBoundary = (s, i) => {
  if (i === 0) return true
  const p = s[i - 1]
  const c = s[i]
  if (/[\s\-_./\\:()[\]]/.test(p)) return true
  return p === p.toLowerCase() && p !== p.toUpperCase() && c !== c.toLowerCase()
}

const NEG = -1e9
const GAP = 1

/** Subsequence match with word-start / consecutive bonuses. -> { score, idx:number[] } | null */
export function fuzzy(q, text) {
  const m = q.length
  const n = text.length
  if (!m) return { score: 0, idx: [] }
  if (m > n) return null
  const t = text.toLowerCase()
  const qq = q.toLowerCase()
  let k = 0
  for (let j = 0; j < n && k < m; j++) if (t[j] === qq[k]) k++
  if (k < m) return null

  const best = []
  const from = []
  for (let i = 0; i < m; i++) {
    const cur = new Float64Array(n).fill(NEG)
    const par = new Int32Array(n).fill(-1)
    const prev = i ? best[i - 1] : null
    let run = NEG
    let runK = -1
    for (let j = 0; j < n; j++) {
      if (t[j] === qq[i]) {
        const bonus = 10 + (isBoundary(text, j) ? 8 : 0) + (j === 0 ? 6 : 0) + (text[j] === q[i] ? 1 : 0)
        if (!i) {
          cur[j] = bonus - Math.min(j, 12) * 0.3
        } else {
          let b = NEG
          let from_ = -1
          if (j > 0 && prev[j - 1] > NEG / 2) {
            b = prev[j - 1] + 8
            from_ = j - 1
          }
          if (run > NEG / 2 && run > b) {
            b = run
            from_ = runK
          }
          if (from_ >= 0) {
            cur[j] = b + bonus
            par[j] = from_
          }
        }
      }
      if (i && j >= 1) {
        if (prev[j - 1] > run) {
          run = prev[j - 1]
          runK = j - 1
        }
      }
      if (i && run > NEG / 2) run -= GAP
    }
    best.push(cur)
    from.push(par)
  }
  let end = -1
  let top = NEG
  const last = best[m - 1]
  for (let j = 0; j < n; j++) if (last[j] > top) ((top = last[j]), (end = j))
  if (end < 0) return null
  const idx = new Array(m)
  for (let i = m - 1, j = end; i >= 0; i--) {
    idx[i] = j
    j = from[i][j]
  }
  return { score: top - n * 0.05, idx }
}

function rank(items, q) {
  if (!q) return items.slice()
  const out = []
  items.forEach((it, i) => {
    let m = fuzzy(q, it.label)
    let score
    let next = it
    if (m) {
      score = m.score
      next = { ...it, hl: m.idx }
    } else if (it.sub && (m = fuzzy(q, it.sub))) {
      score = m.score * 0.5 - 20
      next = { ...it, subHl: m.idx }
    } else return
    out.push({ it: next, score, i })
  })
  out.sort((a, b) => b.score - a.score || a.i - b.i)
  return out.map((o) => o.it)
}

/** Make groups contiguous, in first-seen order. */
function groupBy(items) {
  const order = []
  const map = new Map()
  for (const it of items) {
    const g = it.group || ''
    if (!map.has(g)) {
      map.set(g, [])
      order.push(g)
    }
    map.get(g).push(it)
  }
  return order.flatMap((g) => map.get(g))
}

function hlNodes(text, idx) {
  if (!idx || !idx.length) return text
  const set = new Set(idx)
  const out = []
  let i = 0
  while (i < text.length) {
    const on = set.has(i)
    let j = i + 1
    while (j < text.length && set.has(j) === on) j++
    const s = text.slice(i, j)
    out.push(on ? h('mark', null, s) : s)
    i = j
  }
  return out
}

// ------------------------------------------------------------------ overlay engine

let cur = null // the open overlay
let seq = 0

function keysEl(chord) {
  const el = h('span', { class: 'kbds sm' })
  String(chord || '').trim().split(/\s+/).filter(Boolean).forEach((s, i) => {
    if (i) el.append(h('span', { class: 'sep' }, '›'))
    for (const k of splitChord(s)) el.append(h('span', { class: 'kbd' }, k))
  })
  return el
}

function tileEl(it) {
  const t = it.tile
  let inner
  if (t && t.agent) inner = agentTile(t.agent, 20)
  else if (t && t.svg) inner = fromHTML(t.svg)
  else if (t && t.letter) inner = h('span', { class: 'pal-letter', style: t.bg ? { background: t.bg } : null }, t.letter)
  else inner = icon(typeof it.icon === 'string' && it.icon ? it.icon : 'chev-right', 14)
  return h('span', { class: 'pal-ic' + (t ? ' brand' : '') }, inner)
}

function swatchEl(sw) {
  return h(
    'span',
    { class: 'tn-sw', style: { background: sw.bg, color: sw.fg } },
    h('span', { class: 'tn-sw-t' }, 'fg'),
    h('span', { class: 'tn-sw-d' }, (sw.dots || []).slice(0, 7).map((c) => h('i', { style: { background: c } }))),
  )
}

function footEl(hints) {
  return h(
    'div',
    { class: 'pal-foot' },
    h('span', { class: 'kbd' }, '↑'),
    h('span', { class: 'kbd' }, '↓'),
    h('span', { class: 'pal-fl' }, 'navigate'),
    h('span', { class: 'kbd' }, '↵'),
    h('span', { class: 'pal-fl' }, hints),
    h('span', { class: 'pal-fs' }),
    h('span', { class: 'kbd' }, 'esc'),
    h('span', { class: 'pal-fl' }, 'close'),
  )
}

let carry = null // focus target of the overlay that just closed, for a follow-up overlay opened by its action
function restoreTarget() {
  const a = document.activeElement
  if ((!a || a === document.body) && carry && performance.now() - carry.t < 300) return carry.el
  return a
}

/**
 * cfg: { kind, cls, layerCls, width, top, listMax, rowH?, placeholder, label, query?, chips?:[{id,label}], chip?,
 *        build(query, chip, ov) -> items, empty?, currentKey?, footer?:string (hint for ↵), onPick(item), onHover?(item|null),
 *        onClose?(picked) }
 * item: { key, label, sub?, hint?, keys?, icon?, tile?, swatch?, mode?, group?, hl?, subHl?, disabled?, current?, acts?:[{icon, tip, run}] }
 */
function mountOverlay(cfg) {
  closeOverlay()
  closeMenus()
  const id = ++seq
  const ov = {
    kind: cfg.kind,
    cfg,
    id,
    items: [],
    rows: [],
    sel: -1,
    lastSel: undefined,
    query: cfg.query || '',
    chip: cfg.chip || null,
    closed: false,
    picked: false,
    prev: restoreTarget(),
    hoverTimer: 0,
    pt: null,
    first: true,
  }

  const input = h('input', {
    class: 'pal-in',
    type: 'text',
    value: ov.query,
    placeholder: cfg.placeholder,
    attrs: {
      spellcheck: 'false',
      autocomplete: 'off',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': `pal-list-${id}`,
      'aria-label': cfg.label,
    },
  })
  const head = h('div', { class: 'pal-head' }, icon('search', 17), input, h('span', { class: 'kbd pal-esc' }, 'esc'))

  const chipEls = new Map()
  let chipRow = null
  if (cfg.chips) {
    chipRow = h('div', { class: 'pal-chips', role: 'tablist' })
    for (const c of cfg.chips) {
      const b = h('button', { type: 'button', class: 'pal-chip', role: 'tab', tabIndex: -1, onClick: () => ov.setChip(c.id) }, c.label)
      chipEls.set(c.id, b)
      chipRow.append(b)
    }
  }

  const list = h('div', { class: 'pal-list', role: 'listbox', id: `pal-list-${id}` })
  const foot = cfg.footer ? footEl(cfg.footer) : null
  const card = h('div', { class: `pal-card ${cfg.cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': cfg.label }, head, chipRow, list, foot)
  const layer = h('div', { class: `scrim pal-layer ${cfg.layerCls}`, style: { '--pal-w': cfg.width, '--pal-top': cfg.top, '--pal-list': cfg.listMax } }, card)
  ov.layer = layer
  ov.input = input

  const selectable = (i) => i >= 0 && i < ov.items.length && !ov.items[i].disabled
  const firstSel = () => ov.items.findIndex((it) => !it.disabled)

  function fireHover(item) {
    if (!cfg.onHover) return
    clearTimeout(ov.hoverTimer)
    ov.hoverTimer = setTimeout(() => cfg.onHover(item), 30)
  }

  function select(i, { scroll = true, silent = false } = {}) {
    if (i !== -1 && !selectable(i)) return
    const old = ov.rows[ov.sel]
    if (old) {
      old.classList.remove('sel')
      old.setAttribute('aria-selected', 'false')
    }
    ov.sel = i
    const row = ov.rows[i]
    const item = i >= 0 ? ov.items[i] : null
    if (row) {
      row.classList.add('sel')
      row.setAttribute('aria-selected', 'true')
      input.setAttribute('aria-activedescendant', row.id)
      if (scroll) {
        if (i === firstSel()) list.scrollTop = 0
        else row.scrollIntoView({ block: 'nearest' })
      }
    } else input.removeAttribute('aria-activedescendant')
    if (item !== ov.lastSel) {
      ov.lastSel = item
      if (!silent) fireHover(item)
    }
  }

  function rowEl(it, i) {
    const row = h(
      'div',
      { class: 'pal-row' + (it.disabled ? ' dis' : '') + (it.current ? ' cur' : '') + (it.cls ? ` ${it.cls}` : ''), role: 'option', id: `pal-${id}-${i}`, 'aria-selected': 'false', dataset: { i } },
      it.swatch ? swatchEl(it.swatch) : tileEl(it),
      h(
        'span',
        { class: 'pal-main' },
        h('span', { class: 'pal-l' }, hlNodes(it.label, it.hl)),
        it.hint ? h('span', { class: 'pal-hint' }, it.hint) : null,
        it.sub ? h('span', { class: 'pal-sub' }, hlNodes(it.sub, it.subHl)) : null,
      ),
      it.mode ? h('span', { class: 'pal-mode' }, it.mode) : null,
      it.acts && it.acts.length
        ? h(
            'span',
            { class: 'pal-acts' },
            it.acts.map((a, n) => h('button', { type: 'button', class: 'icon-btn pal-act', tabIndex: -1, 'aria-label': a.tip, dataset: { a: n }, attrs: { 'data-tip': a.tip } }, icon(a.icon, 14))),
          )
        : null,
      it.keys ? keysEl(it.keys) : null,
      it.current ? h('span', { class: 'pal-ck' }, icon('check', 13)) : null,
    )
    return row
  }

  function render(keepKey) {
    const items = cfg.build(ov.query, ov.chip, ov) || []
    ov.items = items
    ov.rows = []
    ov.sel = -1
    list.textContent = ''
    if (!items.length) {
      list.append(h('div', { class: 'pal-empty' }, cfg.empty || 'No results'))
      if (ov.lastSel) {
        ov.lastSel = null
        fireHover(null)
      }
      ov.first = false
      return
    }
    let g = null
    items.forEach((it, i) => {
      const grp = it.group || ''
      if (grp !== g) {
        g = grp
        if (grp) list.append(h('div', { class: 'pal-grp', role: 'presentation' }, grp))
      }
      const row = rowEl(it, i)
      ov.rows.push(row)
      list.append(row)
    })
    let pick = keepKey !== undefined ? items.findIndex((it) => it.key === keepKey && !it.disabled) : -1
    if (pick < 0 && !ov.query.trim() && cfg.currentKey !== undefined) pick = items.findIndex((it) => it.key === cfg.currentKey && !it.disabled)
    if (pick < 0) pick = firstSel()
    list.scrollTop = 0
    select(pick, { scroll: pick !== firstSel(), silent: ov.first })
    ov.first = false
  }
  ov.update = (keep) => {
    if (ov.closed) return
    render(keep ? (ov.items[ov.sel] || {}).key : undefined)
  }

  ov.setChip = (cid) => {
    if (!chipEls.has(cid) || cid === ov.chip) return
    ov.chip = cid
    syncChips()
    if (cfg.onChip) cfg.onChip(cid, ov)
    render()
    input.focus()
  }
  function syncChips() {
    for (const [k, b] of chipEls) {
      b.classList.toggle('on', k === ov.chip)
      b.setAttribute('aria-selected', k === ov.chip ? 'true' : 'false')
    }
  }
  const cycleChip = (d) => {
    const ids = cfg.chips.map((c) => c.id)
    ov.setChip(ids[(ids.indexOf(ov.chip) + d + ids.length) % ids.length])
  }

  function teardown() {
    ov.closed = true
    carry = { el: ov.prev, t: performance.now() }
    clearTimeout(ov.hoverTimer)
    document.removeEventListener('focusin', trap, true)
    layer.remove()
    if (cur === ov) cur = null
  }
  function restoreFocus() {
    const p = ov.prev
    const a = document.activeElement
    if (p && p.isConnected && typeof p.focus === 'function' && (!a || a === document.body)) p.focus({ preventScroll: true })
  }
  /** Close without picking. */
  ov.close = () => {
    if (ov.closed) return
    teardown()
    if (cfg.onHover) cfg.onHover(null)
    restoreFocus()
    if (cfg.onClose) cfg.onClose(false)
  }
  /** Close, then run fn (so an action that opens another overlay is not fought by our focus trap). */
  ov.finish = (fn) => {
    if (ov.closed) return
    ov.picked = true
    teardown()
    try {
      fn()
    } finally {
      restoreFocus()
      if (cfg.onClose) cfg.onClose(true)
    }
  }
  const activate = (i) => {
    if (!selectable(i)) return
    const it = ov.items[i]
    ov.finish(() => cfg.onPick(it))
  }

  function trap(e) {
    if (!layer.contains(e.target)) input.focus()
  }

  input.addEventListener('input', () => {
    ov.query = input.value
    if (cfg.onQuery) cfg.onQuery(ov.query, ov)
    render()
  })

  const move = (d, wrap) => {
    const n = ov.items.length
    if (!n) return
    let i = ov.sel
    for (let step = 0; step < n; step++) {
      i = i + d
      if (i < 0 || i >= n) {
        if (!wrap) return
        i = (i + n) % n
      }
      if (selectable(i)) return select(i)
    }
  }
  const edge = (end) => {
    const n = ov.items.length
    for (let k = 0; k < n; k++) {
      const i = end ? n - 1 - k : k
      if (selectable(i)) return select(i)
    }
  }

  layer.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    const k = e.key
    if (k === 'Escape') ov.close()
    else if (k === 'ArrowDown') move(1, true)
    else if (k === 'ArrowUp') move(-1, true)
    else if (k === 'PageDown') move(8, false)
    else if (k === 'PageUp') move(-8, false)
    else if (k === 'Home') edge(false)
    else if (k === 'End') edge(true)
    else if (k === 'Enter') activate(ov.sel)
    else if (k === 'Tab') {
      if (cfg.chips) cycleChip(e.shiftKey ? -1 : 1)
    } else if (cfg.chips && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(k)) {
      const c = cfg.chips[+k - 1]
      if (c) ov.setChip(c.id)
    } else return
    e.preventDefault()
    e.stopPropagation()
  })

  list.addEventListener('pointermove', (e) => {
    if (ov.pt && ov.pt.x === e.clientX && ov.pt.y === e.clientY) return
    ov.pt = { x: e.clientX, y: e.clientY }
    const row = e.target.closest && e.target.closest('.pal-row')
    if (row) select(+row.dataset.i, { scroll: false })
  })
  list.addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('.pal-row')
    if (!row) return
    const i = +row.dataset.i
    const btn = e.target.closest('.pal-act')
    if (btn) {
      e.stopPropagation()
      const act = ov.items[i].acts[+btn.dataset.a]
      ov.finish(act.run)
      return
    }
    activate(i)
  })
  card.addEventListener('mousedown', (e) => {
    if (e.target !== input) e.preventDefault()
  })
  let downOnScrim = false
  layer.addEventListener('pointerdown', (e) => (downOnScrim = e.target === layer))
  layer.addEventListener('click', (e) => {
    if (downOnScrim && e.target === layer) ov.close()
  })

  cur = ov
  syncChips()
  render()
  overlayEl().append(layer)
  document.addEventListener('focusin', trap, true)
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  return ov
}

function closeOverlay() {
  if (cur) cur.close()
}

// ------------------------------------------------------------------ palette

const SCOPES = ['all', 'commands', 'files', 'sessions', 'hosts']
const CHIPS = [
  { id: 'all', label: 'All' },
  { id: 'commands', label: 'Commands' },
  { id: 'files', label: 'Files' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'hosts', label: 'Hosts' },
]
const PLACEHOLDER = { all: 'Run a command…', commands: 'Run a command…', files: 'Search files…', sessions: 'Go to session…', hosts: 'Connect to host…' }

const grants = new Map() // cwd -> Promise<root>
let F = { key: null, status: 'idle', items: [], timer: 0 }

export const paletteOpen = () => !!cur && cur.kind === 'palette'
export function closePalette() {
  if (cur && cur.kind === 'palette') cur.close()
}

function commandItems(pred) {
  return allCommands()
    .filter(pred)
    .map((c) => ({
      key: c.id,
      label: c.title || c.id,
      sub: c.sub,
      hint: c.hint,
      keys: c.keys,
      icon: c.icon,
      tile: c.tile,
      group: c.group || 'Commands',
      exec: () => runCommand(c.id),
    }))
}

function tabItems() {
  const out = []
  const st = app.state
  for (const s of st.sessions || []) {
    for (const t of s.tabs || []) {
      const pane = app.paneById(t.focus)
      const cwd = pane ? pane.cwd : ''
      const ref = { tabId: t.id }
      out.push({
        key: `tab:${s.id}:${t.id}`,
        label: tabLabel(t) || 'tab',
        sub: [s.name, shortPath(cwd)].filter(Boolean).join(' · '),
        icon: pane ? paneGlyph(pane) : 'terminal',
        tile: pane && isAgent(pane) ? { agent: pane.kind } : null,
        group: 'Sessions',
        current: s.id === st.activeSession && t.id === (s.activeTab || (s.tabs[0] && s.tabs[0].id)),
        acts: [
          { icon: 'edit', tip: 'Rename', run: () => runCommand('tab.rename', ref) },
          { icon: 'close', tip: 'Close', run: () => runCommand('tab.close', ref) },
        ],
        exec: () => runCommand('session.switch', { sessionId: s.id, tabId: t.id }),
      })
    }
  }
  return out
}

function hostItems() {
  const items = (app.settings.hosts || []).map((x) => ({
    key: `host:${x.id || x.address}`,
    label: x.name || x.address,
    sub: x.address && x.address !== x.name ? x.address : '',
    icon: 'server',
    group: 'Hosts',
    exec: () => runCommand('host.connect', { address: x.address }),
  }))
  items.push({ key: 'host:add', label: 'Add host…', icon: 'plus', group: 'Hosts', exec: () => runCommand('host.add') })
  return items
}

function joinPath(root, rel) {
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(rel)) return rel
  const sep = root.includes('\\') ? '\\' : '/'
  const base = root.replace(/[\\/]+$/, '')
  return base + sep + rel.replace(/[\\/]/g, sep)
}

function fileItems(res, root, query) {
  const arr = Array.isArray(res) ? res : res && Array.isArray(res.results) ? res.results : []
  const out = []
  for (const r of arr) {
    const raw = typeof r === 'string' ? r : r && r.path
    if (!raw) continue
    let rel = raw
    if (root && rel.startsWith(root) && /[\\/]/.test(rel.charAt(root.length) || '/')) rel = rel.slice(root.length).replace(/^[\\/]+/, '')
    rel = rel.replace(/\\/g, '/')
    const cut = rel.lastIndexOf('/')
    const base = rel.slice(cut + 1)
    const dir = cut >= 0 ? rel.slice(0, cut) : ''
    let hl
    if (r && Array.isArray(r.idx) && r.idx.length) hl = r.idx.map((n) => n - (cut + 1)).filter((n) => n >= 0 && n < base.length)
    if ((!hl || !hl.length) && query) {
      const m = fuzzy(query, base)
      hl = m ? m.idx : undefined
    }
    out.push({
      key: `file:${rel}`,
      label: base,
      sub: dir,
      icon: /\.(m?[jt]sx?|cjs|json|css|html?|py|rs|go|c|h|cpp|java|sh|ps1|ya?ml|toml)$/i.test(base) ? 'file-code' : 'file',
      group: 'Files',
      cls: 'file',
      hl,
      exec: () => runCommand('file.open', { path: joinPath(root, rel) }),
    })
  }
  return out
}

function wantFiles(ov, query) {
  const cwd = app.focusedCwd()
  const key = `${cwd}\0${query}`
  if (F.key === key) return
  F.key = key
  clearTimeout(F.timer)
  if (!cwd) {
    F.status = 'err'
    F.items = []
    return
  }
  F.status = 'loading'
  F.timer = setTimeout(async () => {
    let root = cwd
    try {
      let g = grants.get(cwd)
      if (!g) {
        g = Promise.resolve(app.d.block('files', 'grant', { path: cwd })).then((r) => (r && r.root) || cwd)
        grants.set(cwd, g)
        g.catch(() => grants.delete(cwd))
      }
      root = await g
      const res = await app.d.block('files', 'find', { root, query, limit: 50 })
      if (F.key !== key || ov.closed) return
      F.items = fileItems(res, root, query)
      F.status = 'ok'
    } catch {
      if (F.key !== key || ov.closed) return
      F.items = []
      F.status = 'err'
    }
    ov.update(true)
  }, 80)
}

function buildPalette(q, chip, ov) {
  const query = q.trim()
  const withRecent = (items) => {
    if (query) return groupBy(rank(items, query))
    const byId = new Map(items.map((it) => [it.key, it]))
    const rec = []
    for (const id of recentCommands()) {
      const it = byId.get(id)
      if (it && rec.length < 5) rec.push({ ...it, key: `r:${id}`, group: 'Recent' })
    }
    const used = new Set(rec.map((r) => r.key.slice(2)))
    return [...rec, ...groupBy(items.filter((it) => !used.has(it.key)))]
  }
  if (chip === 'commands') return withRecent(commandItems((c) => c.kind === 'command'))
  if (chip === 'sessions') return groupBy(rank([...tabItems(), ...commandItems((c) => c.kind === 'session')], query))
  if (chip === 'hosts') return groupBy(rank([...hostItems(), ...commandItems((c) => c.kind === 'host')], query))
  if (chip === 'files') {
    wantFiles(ov, query)
    if (F.items.length) return F.items
    const label = F.status === 'loading' ? 'Searching…' : 'No files'
    return [{ key: 'files:none', label, icon: 'file', disabled: true }]
  }
  // all
  const base = [...commandItems(() => true), ...tabItems()]
  const out = query ? groupBy(rank(base, query)) : withRecent(base)
  if (query.length >= 2) {
    wantFiles(ov, query)
    out.push(...F.items)
  }
  return out
}

export function openPalette({ scope = 'all', query = '' } = {}) {
  const chip = SCOPES.includes(scope) ? scope : 'all'
  if (cur && cur.kind === 'palette') {
    cur.input.value = query
    cur.query = query
    cur.setChip(chip)
    cur.update()
    cur.input.focus()
    return
  }
  F = { key: null, status: 'idle', items: [], timer: 0 }
  const ov = mountOverlay({
    kind: 'palette',
    cls: 'tn-cmdk',
    layerCls: '',
    width: 'min(640px, 100vw - 48px)',
    top: '12vh',
    listMax: 'min(460px, 58vh)',
    placeholder: PLACEHOLDER[chip],
    label: 'Command palette',
    query,
    chips: CHIPS,
    chip,
    footer: 'run',
    build: buildPalette,
    onChip: (c, o) => (o.input.placeholder = PLACEHOLDER[c]),
    onPick: (it) => it.exec(),
    onClose: () => clearTimeout(F.timer),
  })
  return ov
}

// ------------------------------------------------------------------ picker

function pickerItems(items, currentSet, current) {
  return (items || []).map((it) => ({
    ...it,
    key: it.id,
    current: currentSet && it.id === current,
    src: it,
  }))
}

export function openPicker({ placeholder = 'Search…', items = [], current, onHover, onPick, onClose, footer = false, width } = {}) {
  const hasCur = current !== undefined
  const all = pickerItems(items, hasCur, current)
  return mountOverlay({
    kind: 'picker',
    cls: 'tn-pk',
    layerCls: 'pk',
    width: typeof width === 'number' ? `min(${width}px, 100vw - 24px)` : width || 'min(540px, 100vw - 24px)',
    top: '12vh',
    listMax: 'min(320px, 44vh)',
    placeholder,
    label: placeholder,
    currentKey: hasCur ? current : undefined,
    footer: footer ? 'select' : '',
    build: (q) => groupBy(rank(all, q.trim())),
    onHover: onHover ? (it) => onHover(it ? it.src : null) : null,
    onPick: (it) => onPick && onPick(it.src),
    onClose,
  })
}

// ------------------------------------------------------------------ theme picker

function defaultSwatch() {
  return resolvedMode() === 'light'
    ? { bg: '#fcfcfb', fg: '#1f2126', dots: ['#cf3a3f', '#a86a00', '#1d8a5a', '#0f7f93', '#2f5fe0', '#8a4fd8', '#5a7f80'] }
    : { bg: '#060607', fg: '#e4e4e7', dots: ['#ff6166', '#f5b13d', '#3ecf8e', '#35c7e6', '#5b8dff', '#b98cff', '#5a8cff'] }
}

export function openThemePicker() {
  const cid = currentThemeId()
  const dflt = { key: null, id: null, label: 'Pager default', swatch: defaultSwatch(), current: cid === null }
  const themes = THEMES.map((t) => ({
    key: t.id,
    id: t.id,
    label: t.name,
    mode: t.mode,
    swatch: { bg: t.bg, fg: t.fg, dots: t.dots },
    current: t.id === cid,
  }))
  return mountOverlay({
    kind: 'theme',
    cls: 'tn-thm',
    layerCls: 'thm',
    width: 'min(440px, 100vw - 48px)',
    top: '10vh',
    listMax: 'min(430px, 56vh)',
    placeholder: 'Search themes…',
    label: 'Themes',
    chips: [
      { id: 'all', label: 'All' },
      { id: 'dark', label: 'Dark' },
      { id: 'light', label: 'Light' },
    ],
    chip: 'all',
    currentKey: cid,
    build: (q, chip) => rank([dflt, ...themes.filter((t) => chip === 'all' || t.mode === chip)], q.trim()),
    onHover: (it) => previewTheme(it ? (it.id === null ? 'default' : it.id) : null),
    onPick: (it) => {
      if (it.id === null) {
        app.set({ theme_dark: null, theme_light: null })
        previewTheme(null)
      } else pickTheme(it.id)
    },
  })
}
