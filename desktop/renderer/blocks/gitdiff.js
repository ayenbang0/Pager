// The git block's diff view: hunks with line numbers, and (for working-tree diffs) per-line and per-hunk staging.
// Pure view: it never talks to git. It reports what the user picked through `onApply(kind, diff, selection)` and the
// owner rebuilds the patch (gitpatch.buildPatch) and shows the refreshed diff again.
import { h } from '../ui/dom.js'
import { changeCount, diffStat } from './gitpatch.js'
import { icon } from './giticons.js'

/** Lines rendered before the "Show all" button appears. */
const RENDER_LIMIT = 4000

/**
 * @param {{ onApply?: (kind: 'stage'|'unstage', diff: object, selection: {hunk:number, lines:number[]|null}[]) => void }} opts
 */
export function createDiffView({ onApply } = {}) {
  const bar = h('div', { class: 'gt-diff-bar' })
  const body = h('div', { class: 'gt-diff-body', tabIndex: -1 })
  const el = h('div', { class: 'gt-diff' }, bar, body)

  let cur = null // { diff, mode, path }
  /** hunk index -> Set(line index) */
  let picked = new Map()
  let rows = [] // rows[hunk][lineIndex] -> element
  let anchor = null // { hunk, line } of the last plain click, for shift-click ranges
  let drag = null // { hunk, to: boolean }
  let showAll = false

  const isChange = (l) => l.t === '+' || l.t === '-'
  const count = () => {
    let n = 0
    for (const s of picked.values()) n += s.size
    return n
  }
  const editable = () => !!cur && (cur.mode === 'worktree' || cur.mode === 'staged') && !cur.diff.binary

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
  }

  function clear() {
    for (const [hi, set] of [...picked]) for (const li of [...set]) setLine(hi, li, false)
    anchor = null
    refreshHunkBoxes()
  }

  function lineRow(hi, li, l) {
    const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '\\' ? 'meta' : 'ctx'
    const mark = l.t === '\\' ? '' : l.t === ' ' ? ' ' : l.t
    const row = h(
      'div',
      { class: `gt-dl ${cls}`, dataset: { h: hi, i: li } },
      h('span', { class: 'gt-pick' }, isChange(l) && editable() ? h('span', { class: 'gt-tick' }, icon('check')) : null),
      h('span', { class: 'gt-no' }, l.oldNo ?? ''),
      h('span', { class: 'gt-no' }, l.newNo ?? ''),
      h('span', { class: 'gt-mk' }, mark),
      h('span', { class: 'gt-code' }, l.t === '\\' ? l.text : l.text === '' ? ' ' : l.text),
    )
    return row
  }

  function render(keepScroll) {
    const top = keepScroll ? body.scrollTop : 0
    const left = keepScroll ? body.scrollLeft : 0
    body.replaceChildren()
    rows = []
    const { diff } = cur
    let budget = showAll ? Infinity : RENDER_LIMIT
    let cut = false
    diff.hunks.forEach((hunk, hi) => {
      const out = (rows[hi] = [])
      const wrap = h('section', { class: 'gt-hunk' })
      const total = changeCount(hunk)
      wrap.append(
        h(
          'div',
          { class: 'gt-hh', dataset: { h: hi } },
          editable() && total ? h('button', { class: 'gt-box', title: 'Pick every line of this hunk', onClick: () => toggleHunk(hi) }, icon('check')) : h('span', { class: 'gt-box-gap' }),
          h('span', { class: 'gt-hh-range' }, `@@ \u2212${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
          hunk.section ? h('span', { class: 'gt-hh-sec' }, hunk.section) : null,
          h('span', { class: 'gt-grow' }),
          editable() && total
            ? h('button', { class: 'gt-btn sm quiet gt-hh-btn', onClick: () => fire([{ hunk: hi, lines: null }]) }, applyKind() === 'stage' ? 'Stage hunk' : 'Unstage hunk')
            : null,
        ),
      )
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
      body.append(wrap)
    })
    if (cut) {
      const total = diff.hunks.reduce((a, x) => a + x.lines.length, 0)
      body.append(
        h(
          'div',
          { class: 'gt-more' },
          h('span', {}, `Showing the first ${RENDER_LIMIT.toLocaleString()} of ${total.toLocaleString()} lines.`),
          h('button', { class: 'gt-btn sm', onClick: () => ((showAll = true), render(true)) }, 'Show all'),
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

  return {
    el,
    /**
     * @param {object} diff parsed by gitpatch.parseDiff
     * @param {{ path: string, mode: 'worktree'|'staged'|'commit', keepScroll?: boolean, notice?: string }} info
     */
    show(diff, info) {
      const same = cur && cur.path === info.path && cur.mode === info.mode
      cur = { diff, mode: info.mode, path: info.path }
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
        rows = []
        renderBar()
        body.replaceChildren(h('div', { class: 'gt-diff-note' }, info.notice || (diff.binary ? 'Binary file: nothing to show.' : cur.mode === 'commit' ? 'No textual changes (mode or rename only).' : 'No changes.')))
        return
      }
      render(!!info.keepScroll && same)
    },
    /** Empty state with a message. */
    message(text) {
      cur = null
      picked = new Map()
      rows = []
      bar.replaceChildren()
      body.replaceChildren(h('div', { class: 'gt-diff-note' }, text))
    },
    pickedCount: count,
    clear,
  }
}
