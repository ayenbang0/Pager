// The git block's diff view: hunks with line numbers, unified or side by side, light syntax colouring, and (for working-tree
// diffs) per-line and per-hunk staging. Pure view: it never talks to git. It reports what the user picked through
// `onApply(kind, diff, selection)` and the owner rebuilds the patch (gitpatch.buildPatch) and shows the refreshed diff again.
// Every piece of text from the repository (paths, lines) goes in as a text node, never as markup.
import { h } from '../ui/dom.js'
import { isImagePath } from './gitmodel.js'
import { changeCount, diffStat, lineTotal, splitRows } from './gitpatch.js'
import { icon } from './giticons.js'
import { langOf, tokenize } from './gitsyntax.js'

/** Lines rendered before the "Show all" button appears. */
export const RENDER_LIMIT = 4000
/** Above this the "Show all" button warns that rendering will be slow. */
export const HUGE = 20000
/** The side-by-side view needs this much width; narrower panes fall back to the unified view. */
const SPLIT_MIN = 620
const VIEW_KEY = 'pager.git.diffview'

const readView = () => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

/** A code cell's children: the line as coloured spans (text nodes only). */
function codeNodes(text, lang) {
  if (text === '') return [' ']
  if (lang === 'none') return [text]
  const out = []
  for (const t of tokenize(text, lang)) out.push(t.k ? h('span', { class: `sx-${t.k}` }, t.s) : t.s)
  return out
}

/**
 * @param {{ onApply?: (kind: 'stage'|'unstage', diff: object, selection: {hunk:number, lines:number[]|null}[]) => void,
 *           onReload?: () => void }} opts  `onReload` is called when a view option that changes git's output (whitespace) flips
 */
export function createDiffView({ onApply, onReload } = {}) {
  const bar = h('div', { class: 'gt-diff-bar' })
  const body = h('div', { class: 'gt-diff-body', tabIndex: -1 })
  const el = h('div', { class: 'gt-diff' }, bar, body)

  let cur = null // { diff, mode, path, lang }
  /** hunk index -> Set(line index) */
  let picked = new Map()
  let rows = [] // rows[hunk][lineIndex] -> element
  let anchor = null // { hunk, line } of the last plain click, for shift-click ranges
  let drag = null // { hunk, to: boolean }
  let showAll = false
  let view = readView()
  let ws = false
  let nav = null // { index, total, prev, next }
  let rendered = null // 'unified' | 'split': what the body currently shows

  const isChange = (l) => l.t === '+' || l.t === '-'
  const count = () => {
    let n = 0
    for (const s of picked.values()) n += s.size
    return n
  }
  const editable = () => !!cur && (cur.mode === 'worktree' || cur.mode === 'staged') && !cur.diff.binary
  const wantSplit = () => view === 'split' && body.clientWidth >= SPLIT_MIN

  function setLine(hi, li, on) {
    let set = picked.get(hi)
    if (on) {
      if (!set) picked.set(hi, (set = new Set()))
      set.add(li)
    } else if (set) {
      set.delete(li)
      if (!set.size) picked.delete(hi)
    }
    const row = rows[hi] && rows[hi][li]
    if (row) row.classList.toggle('sel', on)
  }

  function refreshHunkBoxes() {
    for (const hh of body.querySelectorAll('.gt-hh')) {
      const hi = +hh.dataset.h
      const hunk = cur.diff.hunks[hi]
      const total = changeCount(hunk)
      const n = picked.get(hi)?.size ?? 0
      const box = hh.querySelector('.gt-box')
      if (box) {
        box.classList.toggle('on', n === total && total > 0)
        box.classList.toggle('some', n > 0 && n < total)
      }
    }
    renderBar()
  }

  function applyKind() {
    return cur.mode === 'staged' ? 'unstage' : 'stage'
  }

  function fire(selection) {
    if (!onApply || !cur || !selection.length) return
    onApply(applyKind(), cur.diff, selection)
  }

  function fireSelected() {
    const sel = []
    for (const [hi, set] of picked) sel.push({ hunk: hi, lines: [...set].sort((a, b) => a - b) })
    fire(sel)
  }

  function setView(next) {
    if (view === next) return
    view = next
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      /* storage unavailable */
    }
    if (cur && rendered) render(true)
    renderBar()
  }

  function viewSwitch() {
    const narrow = view === 'split' && !wantSplit()
    const seg = (id, ico, label) =>
      h('button', { class: 'gt-seg-b' + (view === id ? ' on' : ''), type: 'button', title: id === 'split' && narrow ? 'Side by side (needs a wider pane)' : label, 'aria-pressed': view === id, onClick: () => setView(id) }, icon(ico))
    return h('span', { class: 'gt-seg sm', role: 'group', 'aria-label': 'Diff layout' }, seg('unified', 'rows', 'Unified'), seg('split', 'columns', 'Side by side'))
  }

  function renderBar() {
    bar.replaceChildren()
    if (!cur) return
    const { diff, path, mode } = cur
    const st = diffStat(diff)
    const parts = path.split('/')
    const file = parts.pop()
    bar.append(
      h('div', { class: 'gt-diff-path', title: path }, parts.length ? h('span', { class: 'dim' }, parts.join(' / ') + ' / ') : null, h('b', {}, file)),
      h('span', { class: 'gt-stat' }, st.add ? h('i', { class: 'add' }, `+${st.add}`) : null, st.del ? h('i', { class: 'del' }, `\u2212${st.del}`) : null),
      h('span', { class: 'gt-grow' }),
    )
    if (editable() && diff.hunks.length) {
      const n = count()
      const verb = applyKind() === 'stage' ? 'Stage' : 'Unstage'
      if (n) {
        bar.append(
          h('button', { class: 'gt-btn quiet sm', onClick: clear }, 'Clear'),
          h('button', { class: 'gt-btn accent sm', title: `${verb} the ${n} selected line${n === 1 ? '' : 's'}`, onClick: fireSelected }, `${verb} ${n} line${n === 1 ? '' : 's'}`),
        )
      } else {
        bar.append(
          h('span', { class: 'gt-hint' }, 'Click line numbers to pick lines'),
          h('button', { class: 'gt-btn sm', onClick: () => fire(diff.hunks.map((_, i) => ({ hunk: i, lines: null }))) }, `${verb} all`),
        )
      }
    } else if (mode === 'commit' && st.add + st.del) {
      bar.append(h('span', { class: 'gt-hint' }, `${diff.hunks.length} hunk${diff.hunks.length === 1 ? '' : 's'}`))
    }
    if (diff.hunks.length) bar.append(viewSwitch())
    bar.append(h('button', { class: 'gt-ibtn' + (ws ? ' on' : ''), type: 'button', title: ws ? 'Whitespace changes are hidden: click to show them' : 'Hide whitespace-only changes', 'aria-pressed': ws, onClick: toggleWs }, icon('ws')))
    if (nav && nav.total > 1) {
      bar.append(
        h('span', { class: 'gt-nav' },
          h('button', { class: 'gt-ibtn', type: 'button', title: 'Previous file', disabled: nav.index <= 0, onClick: () => nav.prev() }, icon('chevD', 'up')),
          h('span', { class: 'gt-nav-n' }, `${nav.index + 1}/${nav.total}`),
          h('button', { class: 'gt-ibtn', type: 'button', title: 'Next file', disabled: nav.index >= nav.total - 1, onClick: () => nav.next() }, icon('chevD')),
        ),
      )
    }
  }

  function toggleWs() {
    ws = !ws
    renderBar()
    if (onReload) onReload()
  }

  function clear() {
    for (const [hi, set] of [...picked]) for (const li of [...set]) setLine(hi, li, false)
    anchor = null
    refreshHunkBoxes()
  }

  function lineRow(hi, li, l) {
    const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '\\' ? 'meta' : 'ctx'
    const mark = l.t === '\\' ? '' : l.t === ' ' ? ' ' : l.t
    return h(
      'div',
      { class: `gt-dl ${cls}`, dataset: { h: hi, i: li } },
      h('span', { class: 'gt-pick' }, isChange(l) && editable() ? h('span', { class: 'gt-tick' }, icon('check')) : null),
      h('span', { class: 'gt-no' }, l.oldNo ?? ''),
      h('span', { class: 'gt-no' }, l.newNo ?? ''),
      h('span', { class: 'gt-mk' }, mark),
      h('span', { class: 'gt-code' }, ...(l.t === '\\' ? [l.text] : codeNodes(l.text, cur.lang))),
    )
  }

  /** One side of a side-by-side row (the old side shows old numbers, the new side new ones). */
  function sideCell(hi, cell, side) {
    if (!cell) return h('div', { class: 'gt-sl empty' })
    const { li, line: l } = cell
    const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'
    return h(
      'div',
      { class: `gt-dl gt-sl ${cls}`, dataset: { h: hi, i: li } },
      h('span', { class: 'gt-pick' }, isChange(l) && editable() ? h('span', { class: 'gt-tick' }, icon('check')) : null),
      h('span', { class: 'gt-no' }, (side === 'l' ? l.oldNo : l.newNo) ?? ''),
      h('span', { class: 'gt-mk' }, l.t === ' ' ? ' ' : l.t),
      h('span', { class: 'gt-code' }, ...codeNodes(l.text, cur.lang)),
    )
  }

  function hunkHead(hunk, hi) {
    const total = changeCount(hunk)
    return h(
      'div',
      { class: 'gt-hh', dataset: { h: hi } },
      editable() && total ? h('button', { class: 'gt-box', title: 'Pick every line of this hunk', onClick: () => toggleHunk(hi) }, icon('check')) : h('span', { class: 'gt-box-gap' }),
      h('span', { class: 'gt-hh-range' }, `@@ \u2212${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
      hunk.section ? h('span', { class: 'gt-hh-sec' }, hunk.section) : null,
      h('span', { class: 'gt-grow' }),
      editable() && total ? h('button', { class: 'gt-btn sm quiet gt-hh-btn', onClick: () => fire([{ hunk: hi, lines: null }]) }, applyKind() === 'stage' ? 'Stage hunk' : 'Unstage hunk') : null,
    )
  }

  function render(keepScroll) {
    const top = keepScroll ? body.scrollTop : 0
    const left = keepScroll ? body.scrollLeft : 0
    body.replaceChildren()
    rows = []
    const split = wantSplit()
    rendered = split ? 'split' : 'unified'
    body.classList.toggle('split', split)
    const { diff } = cur
    let budget = showAll ? Infinity : RENDER_LIMIT
    let cut = false
    diff.hunks.forEach((hunk, hi) => {
      const out = (rows[hi] = [])
      const wrap = h('section', { class: 'gt-hunk' })
      wrap.append(hunkHead(hunk, hi))
      if (split) {
        for (const r of splitRows(hunk)) {
          if (budget-- <= 0) {
            cut = true
            break
          }
          if (r.meta) {
            wrap.append(h('div', { class: 'gt-sr meta' }, h('span', { class: 'gt-code' }, r.meta.line.text)))
            continue
          }
          const l = sideCell(hi, r.l, 'l')
          const rr = sideCell(hi, r.r, 'r')
          if (r.l) out[r.l.li] = l
          if (r.r && !(r.l && r.l.li === r.r.li)) out[r.r.li] = rr
          wrap.append(h('div', { class: 'gt-sr' }, l, rr))
        }
        for (const [li, set] of Object.entries(out)) if (picked.get(hi)?.has(+li)) set.classList.add('sel')
      } else {
        for (let li = 0; li < hunk.lines.length; li++) {
          if (budget-- <= 0) {
            cut = true
            break
          }
          const row = lineRow(hi, li, hunk.lines[li])
          if (picked.get(hi)?.has(li)) row.classList.add('sel')
          out[li] = row
          wrap.append(row)
        }
      }
      body.append(wrap)
    })
    if (cut) {
      const total = lineTotal(diff)
      body.append(
        h(
          'div',
          { class: 'gt-more' },
          h('span', {}, `Showing the first ${RENDER_LIMIT.toLocaleString()} of ${total.toLocaleString()} lines.`),
          h('button', { class: 'gt-btn sm', onClick: () => ((showAll = true), render(true)) }, total > HUGE ? 'Show all (slow)' : 'Show all'),
        ),
      )
    }
    refreshHunkBoxes()
    if (keepScroll) {
      body.scrollTop = top
      body.scrollLeft = left
    }
  }

  function toggleHunk(hi) {
    const hunk = cur.diff.hunks[hi]
    const total = changeCount(hunk)
    const all = (picked.get(hi)?.size ?? 0) === total
    hunk.lines.forEach((l, li) => isChange(l) && setLine(hi, li, !all))
    refreshHunkBoxes()
  }

  // Line picking: click toggles, shift-click extends inside the hunk, dragging paints.
  body.addEventListener('pointerdown', (e) => {
    if (!editable() || e.button !== 0) return
    const pick = e.target.closest('.gt-pick, .gt-no')
    const row = e.target.closest('.gt-dl')
    if (!pick || !row) return
    const hi = +row.dataset.h
    const li = +row.dataset.i
    const line = cur.diff.hunks[hi].lines[li]
    if (!isChange(line)) return
    e.preventDefault()
    const was = picked.get(hi)?.has(li) ?? false
    if (e.shiftKey && anchor && anchor.hunk === hi) {
      const [a, b] = anchor.line < li ? [anchor.line, li] : [li, anchor.line]
      cur.diff.hunks[hi].lines.forEach((l, i) => i >= a && i <= b && isChange(l) && setLine(hi, i, true))
      refreshHunkBoxes()
      return
    }
    drag = { hunk: hi, to: !was }
    anchor = { hunk: hi, line: li }
    setLine(hi, li, !was)
    refreshHunkBoxes()
    try { body.setPointerCapture(e.pointerId) } catch { /* synthetic events have no active pointer */ }
  })
  body.addEventListener('pointermove', (e) => {
    if (!drag) return
    const t = document.elementFromPoint(e.clientX, e.clientY)
    const row = t && t.closest && t.closest('.gt-dl')
    if (!row || +row.dataset.h !== drag.hunk) return
    const li = +row.dataset.i
    if (!isChange(cur.diff.hunks[drag.hunk].lines[li])) return
    if ((picked.get(drag.hunk)?.has(li) ?? false) !== drag.to) {
      setLine(drag.hunk, li, drag.to)
      refreshHunkBoxes()
    }
  })
  const endDrag = () => {
    drag = null
  }
  body.addEventListener('pointerup', endDrag)
  body.addEventListener('pointercancel', endDrag)

  // The side-by-side view needs room: re-render when the pane crosses the threshold.
  if (typeof ResizeObserver !== 'undefined') {
    let raf = 0
    new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (cur && rendered && !cur.card && (wantSplit() ? 'split' : 'unified') !== rendered) render(true)
        else if (cur) renderBar()
      })
    }).observe(body)
  }

  /** A centred card instead of a diff (binary, image, too large, conflicts). */
  function card(ico, title, text, actions = []) {
    rows = []
    rendered = null
    body.classList.remove('split')
    body.replaceChildren(h('div', { class: 'gt-card gt-diff-card' }, h('span', { class: 'gt-card-ico' }, icon(ico)), h('div', { class: 'gt-card-title' }, title), text ? h('div', { class: 'gt-card-text' }, text) : null, actions.length ? h('div', { class: 'gt-card-actions' }, ...actions) : null))
  }

  return {
    el,
    /**
     * @param {object} diff parsed by gitpatch.parseDiff
     * @param {{ path: string, mode: 'worktree'|'staged'|'commit', keepScroll?: boolean, notice?: string, actions?: Node[] }} info
     */
    show(diff, info) {
      const same = cur && cur.path === info.path && cur.mode === info.mode
      cur = { diff, mode: info.mode, path: info.path, lang: langOf(info.path), card: false }
      if (!same || !info.keepScroll) {
        picked = new Map()
        anchor = null
        showAll = false
      } else {
        // Keep picks that still point at the same changed line.
        const next = new Map()
        for (const [hi, set] of picked) {
          const hunk = diff.hunks[hi]
          if (!hunk) continue
          const keep = new Set([...set].filter((li) => hunk.lines[li] && isChange(hunk.lines[li])))
          if (keep.size) next.set(hi, keep)
        }
        picked = next
      }
      if (info.notice || diff.binary || !diff.hunks.length) {
        cur.card = true
        renderBar()
        if (info.notice) card('alert', info.noticeTitle || 'Nothing to show', info.notice, info.actions)
        else if (isImagePath(info.path)) card('image', diff.isNew ? 'New image' : diff.isDeleted ? 'Image deleted' : 'Image changed', 'Pixel changes are not shown in the diff. Open the file to see the image itself.', info.actions)
        else if (diff.binary) card('file', diff.isNew ? 'New binary file' : diff.isDeleted ? 'Binary file deleted' : 'Binary file changed', 'Binary content is not shown in the diff.', info.actions)
        else card('check', 'No textual changes', cur.mode === 'commit' ? 'Only the file mode or its name changed.' : 'This file has no changes in this view.', info.actions)
        return
      }
      render(!!info.keepScroll && same)
    },
    /** Empty state with a message. */
    message(text) {
      cur = null
      picked = new Map()
      rows = []
      rendered = null
      body.classList.remove('split')
      bar.replaceChildren()
      body.replaceChildren(h('div', { class: 'gt-diff-note' }, text))
    },
    /** Hide-whitespace flag the owner passes to `git diff -w`. */
    get ignoreWhitespace() {
      return ws
    },
    /** Previous/next-file buttons: { index, total, prev(), next() } or null. */
    setNav(n) {
      nav = n
      renderBar()
    },
    pickedCount: count,
    clear,
  }
}
