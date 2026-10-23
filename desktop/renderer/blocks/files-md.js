// Rendered Markdown view of the Files block: a block-structured editor. The document is a lossless list of blocks (vendor md.js);
// every block shows rendered, and a click turns just that block into an auto-sizing source editor (heading marks hang in the margin),
// so the file is never rewritten beyond what you typed. Task lists toggle in place, callouts / math / mermaid / images render.
import { h, fromHTML } from '../ui/dom.js'
import { blockLabel, changedBlocks, countLines, langForFence, lineSpans, listContinuation, mapOffset, slug, toggleTask, CALLOUTS } from './files-util.js'
import { loadCM } from './files-code.js'

let mdP = null
const loadMD = () => (mdP ||= import('../vendor/files/md.js'))
let katexCss = false

const ICON_PLUS = '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5v9M3.5 8h9"/></svg>'
const CALLOUT_ICON = {
  note: 'M8 7.2v4M8 4.8v.1', info: 'M8 7.2v4M8 4.8v.1', tip: 'M6 12.2h4M6.4 10.4c-1.6-.9-2.4-2.3-2.1-3.9A3.8 3.8 0 0 1 12 7c.1 1.5-.6 2.8-2.4 3.4',
  important: 'M8 4v5M8 11.6v.1', warning: 'M8 5v4M8 11.4v.1', caution: 'M8 5v4M8 11.4v.1', danger: 'M9 2.8 4.5 9H8l-1 4.2L11.5 7H8z',
  success: 'M4.5 8.4 7 10.8l4.6-5.2', question: 'M6.4 6.4a1.7 1.7 0 1 1 2.5 1.5c-.6.4-.9.8-.9 1.4M8 11.6v.1', failure: 'M5.5 5.5l5 5M10.5 5.5l-5 5', bug: 'M8 6v5M5.5 8h5',
}

/**
 * @param {HTMLElement} host
 * @param {{text:string, resolveMedia:(rel:string)=>Promise<string|null>, onChange:(text:string)=>void,
 *   onCursor:(c:{label:string,line:number,col:number})=>void, onLink:(href:string)=>void, isDark:()=>boolean}} o
 */
export function createMarkdownView(host, o) {
  const root = h('div', { class: 'fb-md', tabIndex: -1 })
  const col = h('div', { class: 'fb-md-col' })
  const tail = h('div', { class: 'fb-md-tail', title: 'Click to add a paragraph' })
  root.append(col, tail)
  host.append(root)

  let src = ''
  let blocks = []
  let links = {}
  let ok = true
  let marks = []
  let edit = null // { i, ta, prefix, tail, before, after, wrap, phantom }
  let destroyed = false
  let lib = null

  const els = () => Array.from(col.children)
  const joinRaw = (a, z) => {
    let s = ''
    for (let k = a; k < z; k++) s += blocks[k].raw
    return s
  }
  const text = () => blocks.map((b) => b.raw).join('')

  // ------------------------------------------------------------------ rendering

  function relex(next) {
    src = next
    if (!lib) return
    const r = lib.lex(src)
    blocks = r.blocks
    links = r.links
    ok = r.ok
  }

  function renderBlockEl(b, i) {
    const body = h('div', { class: 'fb-mb-body' })
    body.innerHTML = lib.renderBlock(b, links)
    const el = h('div', { class: 'fb-mb t-' + b.type + (b.depth ? ' d' + b.depth : ''), dataset: { i } }, body,
      h('button', { class: 'fb-mb-add', title: 'Add a paragraph below', tabIndex: -1, html: ICON_PLUS }))
    decorate(body, b)
    return el
  }

  function decorate(body, b) {
    // callouts
    if (b.type === 'blockquote') {
      const p = body.querySelector('blockquote > p')
      const m = p && /^\s*\[!(\w+)\][+-]?[ \t]*([^\n<]*)(?:<br\s*\/?>|\n)?/.exec(p.innerHTML)
      if (m && CALLOUTS[m[1].toLowerCase()]) {
        const kind = m[1].toLowerCase()
        p.innerHTML = p.innerHTML.slice(m[0].length)
        const bq = p.parentElement
        const callout = h('div', { class: 'callout c-' + kind },
          h('div', { class: 'callout-title' },
            fromHTML(`<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="${CALLOUT_ICON[kind] || CALLOUT_ICON.note}"/></svg>`),
            h('span', null, m[2].trim() || CALLOUTS[kind])),
          h('div', { class: 'callout-body' }, ...Array.from(bq.childNodes).filter((n) => !(n === p && !p.textContent.trim() && !p.children.length))))
        bq.replaceWith(callout)
      }
    }
    for (const t of body.querySelectorAll('input.task')) t.removeAttribute('disabled')
    for (const img of body.querySelectorAll('img')) {
      const s = img.getAttribute('src') || ''
      if (s && !/^(?:[a-z][a-z0-9+.-]+:|\/\/|#)/i.test(s)) {
        img.removeAttribute('src')
        img.dataset.rel = decodeURI(s)
        o.resolveMedia(img.dataset.rel).then((url) => { if (url && !destroyed) img.src = url }).catch(() => {})
      }
      img.loading = 'lazy'
      img.addEventListener('error', () => img.classList.add('broken'), { once: true })
    }
    for (const a of body.querySelectorAll('a[href]')) a.removeAttribute('target')
    // fenced code: syntax colours (CodeMirror's parsers), lazy
    for (const pre of body.querySelectorAll('pre[data-lang]')) {
      const id = langForFence(pre.dataset.lang)
      const code = pre.firstElementChild
      if (!id || !code) continue
      const t = code.textContent
      if (t.length > 40000) continue
      loadCM().then((cm) => cm.highlightSegments(t, id)).then((segs) => {
        if (destroyed || !code.isConnected) return
        code.textContent = ''
        for (const [s, cls] of segs) code.append(cls ? h('span', { class: cls }, s) : s)
      }).catch(() => {})
    }
  }

  function numberHeadings() {
    const seen = new Map()
    for (const hd of col.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      let id = slug(hd.textContent)
      const n = seen.get(id) || 0
      seen.set(id, n + 1)
      if (n) id += '-' + n
      hd.id = id
    }
  }

  function typeset() {
    if (!lib) return
    if (!katexCss && col.querySelector('.math')) {
      katexCss = true
      document.head.append(h('link', { rel: 'stylesheet', href: new URL('../vendor/files/katex/katex.css', import.meta.url).href }))
    }
    lib.typeset(col, { dark: o.isDark() }).catch(() => {})
  }

  function applyMarks() {
    const idx = changedBlocks(lineSpans(blocks), marks)
    for (const el of els()) el.classList.toggle('changed', idx.has(+el.dataset.i))
  }

  function renderAll() {
    const keep = root.scrollTop
    col.textContent = ''
    blocks.forEach((b, i) => {
      if (b.type === 'space' || (b.type === 'paragraph' && b.phantom)) return
      col.append(renderBlockEl(b, i))
    })
    numberHeadings()
    applyMarks()
    typeset()
    root.scrollTop = keep
  }

  // ------------------------------------------------------------------ editing

  const nonSpace = (i) => blocks[i] && blocks[i].type !== 'space'
  const prevBlock = (i) => { for (let k = i - 1; k >= 0; k--) if (nonSpace(k)) return k; return -1 }
  const nextBlock = (i) => { for (let k = i + 1; k < blocks.length; k++) if (nonSpace(k)) return k; return -1 }

  function startOffset(i) { return joinRaw(0, i).length }
  function indexAtOffset(off) {
    let acc = 0
    for (let k = 0; k < blocks.length; k++) {
      const end = acc + blocks[k].raw.length
      if (off < end || (off === end && k === blocks.length - 1)) return nonSpace(k) ? k : nextBlock(k) >= 0 ? nextBlock(k) : prevBlock(k)
      acc = end
    }
    return blocks.length - 1
  }

  function autosize(ta) {
    ta.style.height = 'auto'
    ta.style.height = ta.scrollHeight + 'px'
  }

  function report() {
    if (!edit) return
    const ta = edit.ta
    const spans = lineSpans(blocks)
    const upto = ta.value.slice(0, ta.selectionStart)
    const pre = edit.prefix
    const start = spans[edit.i] ? spans[edit.i].start : 1
    const line = start + countLines(upto)
    const lastNl = upto.lastIndexOf('\n')
    const colN = lastNl === -1 ? pre.length + upto.length + 1 : upto.length - lastNl
    o.onCursor({ label: blockLabel(blocks[edit.i]), line, col: colN })
  }

  function liveUpdate() {
    const e = edit
    const raw = e.prefix + e.ta.value + e.tail
    blocks[e.i].raw = raw
    src = e.before + raw + e.after
    autosize(e.ta)
    applyMarks()
    o.onChange(src)
  }

  /** Start editing block `i` with the caret at `caret` (offset in the displayed textarea text; Infinity = end). */
  function startEdit(i, caret = 0) {
    if (!ok || !nonSpace(i)) return
    if (edit) { if (edit.i === i) { edit.ta.focus(); return } commit() }
    if (!nonSpace(i)) return
    const el = els().find((x) => +x.dataset.i === i) || null
    const b = blocks[i]
    const raw = b.raw
    const trail = /\s*$/.exec(raw)[0]
    let body = raw.slice(0, raw.length - trail.length)
    let prefix = ''
    if (b.type === 'heading') {
      const m = /^#{1,6}[ \t]+/.exec(body)
      if (m) { prefix = m[0]; body = body.slice(prefix.length) }
    }
    const ta = h('textarea', { class: 'fb-mb-edit', rows: 1, spellcheck: false, value: body, 'aria-label': 'Edit block' })
    const wrap = h('div', { class: 'fb-mb t-' + b.type + (b.depth ? ' d' + b.depth : '') + ' editing' + (b.phantom ? ' phantom' : ''), dataset: { i } },
      prefix ? h('span', { class: 'fb-mark' }, prefix.trim()) : null, ta)
    if (el) { wrap.classList.toggle('changed', el.classList.contains('changed')); el.replaceWith(wrap) }
    else {
      // phantom block: position it by order
      const after = els().filter((x) => +x.dataset.i < i).pop()
      if (after) after.after(wrap)
      else col.prepend(wrap)
    }
    edit = { i, ta, prefix, tail: trail, before: joinRaw(0, i), after: joinRaw(i + 1, blocks.length), wrap }
    ta.addEventListener('input', liveUpdate)
    ta.addEventListener('keydown', onEditKey)
    ta.addEventListener('keyup', report)
    ta.addEventListener('click', report)
    ta.addEventListener('select', report)
    ta.addEventListener('blur', () => {
      // A blur caused by a click inside the block (the mousedown handler) is handled there; anything else commits.
      setTimeout(() => { if (edit && edit.ta === ta && document.activeElement !== ta) commit() }, 0)
    })
    ta.focus()
    const c = caret === Infinity ? body.length : Math.max(0, Math.min(caret, body.length))
    ta.setSelectionRange(c, c)
    autosize(ta)
    wrap.scrollIntoView({ block: 'nearest' })
    report()
  }

  /** Leave edit mode: re-lex the whole text (the edit may have split or merged blocks) and re-render. */
  function commit() {
    if (!edit) return
    const e = edit
    edit = null
    const phantomEmpty = blocks[e.i].phantom && e.ta.value === ''
    if (phantomEmpty) {
      const ph = blocks[e.i]
      blocks.splice(e.i, 1)
      if (ph.undo) ph.undo()
      src = text()
    } else {
      src = e.before + e.prefix + e.ta.value + e.tail + e.after
    }
    const hadFocus = document.activeElement === e.ta
    relex(src)
    renderAll()
    if (hadFocus && !edit) root.focus({ preventScroll: true }) // the textarea is gone: keep keystrokes (Ctrl+S) inside the block
    o.onChange(src)
  }

  function onEditKey(ev) {
    const e = edit
    const ta = ev.target
    const mod = ev.ctrlKey || ev.metaKey
    const at0 = ta.selectionStart === 0 && ta.selectionEnd === 0
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length
    if (ev.key === 'Escape') { ev.preventDefault(); commit(); return }
    if (mod && !ev.shiftKey && !ev.altKey && 'bik'.includes(ev.key.toLowerCase())) {
      ev.preventDefault()
      wrapSelection(ta, ev.key.toLowerCase())
      return
    }
    if (ev.key === 'ArrowUp' && !ev.shiftKey && !mod && (at0 || !ta.value.slice(0, ta.selectionStart).includes('\n'))) {
      const p = prevBlock(e.i)
      if (p >= 0) { ev.preventDefault(); jump(p, Infinity) }
      return
    }
    if (ev.key === 'ArrowDown' && !ev.shiftKey && !mod && (atEnd || !ta.value.slice(ta.selectionEnd).includes('\n'))) {
      const n = nextBlock(e.i)
      if (n >= 0) { ev.preventDefault(); jump(n, 0) }
      return
    }
    if (ev.key === 'Backspace' && ta.value === '' && !ev.shiftKey) {
      const p = prevBlock(e.i)
      if (p >= 0 && e.prefix === '') { ev.preventDefault(); removeCurrentAndJump(p) }
      return
    }
    if (ev.key === 'Tab' && blocks[e.i].type === 'list') {
      ev.preventDefault()
      indentLines(ta, ev.shiftKey)
      return
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !mod && !ev.isComposing) {
      const b = blocks[e.i]
      if (b.type === 'heading' && atEnd) { ev.preventDefault(); insertParagraphAfter(e.i); return }
      if (b.type === 'list' || (b.type === 'paragraph' && /^\s*(?:[-*+]|\d+[.)])\s/.test(ta.value))) {
        const lineStart = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1
        const line = ta.value.slice(lineStart, ta.selectionStart)
        const cont = listContinuation(line)
        if (cont && atEndOfLine(ta)) {
          ev.preventDefault()
          if (cont.empty) {
            ta.setRangeText('', lineStart, ta.selectionStart, 'end')
            liveUpdate()
            if (ta.value.trim() === '') { insertParagraphAfter(e.i) } else { ta.value = ta.value.replace(/\n+$/, ''); liveUpdate(); insertParagraphAfter(e.i) }
          } else {
            ta.setRangeText('\n' + cont.prefix, ta.selectionStart, ta.selectionEnd, 'end')
            liveUpdate()
          }
          report()
          return
        }
      }
      if (b.type === 'paragraph' && atEnd && /\n$/.test(ta.value)) {
        ev.preventDefault()
        ta.value = ta.value.replace(/\n+$/, '')
        liveUpdate()
        insertParagraphAfter(e.i)
      }
    }
  }

  const atEndOfLine = (ta) => ta.selectionStart === ta.selectionEnd && (ta.value[ta.selectionStart] === undefined || ta.value[ta.selectionStart] === '\n')

  function wrapSelection(ta, key) {
    const [a, z] = [ta.selectionStart, ta.selectionEnd]
    const sel = ta.value.slice(a, z)
    let ins
    let c0
    let c1
    if (key === 'k') {
      ins = `[${sel}](url)`
      c0 = a + sel.length + 3
      c1 = c0 + 3
    } else {
      const m = key === 'b' ? '**' : '*'
      ins = m + sel + m
      c0 = a + m.length
      c1 = c0 + sel.length
    }
    ta.setRangeText(ins, a, z, 'end')
    ta.setSelectionRange(c0, c1)
    liveUpdate()
  }

  function indentLines(ta, out) {
    const a = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1
    let zEnd = ta.value.indexOf('\n', ta.selectionEnd)
    if (zEnd === -1) zEnd = ta.value.length
    const seg = ta.value.slice(a, zEnd).split('\n').map((l) => (out ? l.replace(/^(?: {1,2}|\t)/, '') : '  ' + l)).join('\n')
    const delta = seg.length - (zEnd - a)
    const s0 = ta.selectionStart
    ta.setRangeText(seg, a, zEnd, 'preserve')
    ta.setSelectionRange(Math.max(a, s0 + (out ? Math.max(delta, -2) : 2)), Math.max(a, ta.selectionEnd + delta))
    liveUpdate()
  }

  function jump(i, caret) {
    const off = startOffset(i)
    commit()
    const k = indexAtOffset(off)
    startEdit(k, caret)
  }

  function removeCurrentAndJump(p) {
    const e = edit
    const raw = blocks[e.i].raw
    edit = null
    // drop the (empty) block and the blank run before it
    let from = e.i
    while (from > 0 && blocks[from - 1].type === 'space') from--
    blocks.splice(from, e.i - from + 1)
    src = text()
    const off = startOffset(Math.min(p, blocks.length - 1))
    relex(src)
    renderAll()
    o.onChange(src)
    void raw
    startEdit(indexAtOffset(off), Infinity)
  }

  /** New empty paragraph after block `i` (a phantom: it only becomes part of the file once something is typed). */
  function insertParagraphAfter(i) {
    if (edit) {
      const off = startOffset(i)
      commit()
      i = indexAtOffset(off)
    }
    let k = i + 1
    const existing = blocks[k] && blocks[k].type === 'space' ? blocks[k] : null
    let sep = existing
    const oldRaw = existing ? existing.raw : ''
    if (!sep) {
      sep = { type: 'space', raw: '' }
      blocks.splice(k, 0, sep)
    }
    if ((sep.raw.match(/\n/g) || []).length < 2) sep.raw = '\n\n'
    k++
    const tailSep = k < blocks.length ? { type: 'space', raw: '\n\n' } : null // what follows must stay a separate block
    const phantom = {
      type: 'paragraph', raw: '', phantom: true,
      // an empty phantom leaves no trace: the separators it widened or created go back
      undo() {
        if (existing) existing.raw = oldRaw
        else { const at = blocks.indexOf(sep); if (at >= 0) blocks.splice(at, 1) }
        if (tailSep) { const at = blocks.indexOf(tailSep); if (at >= 0) blocks.splice(at, 1) }
      },
    }
    blocks.splice(k, 0, phantom, ...(tailSep ? [tailSep] : []))
    // rendered elements keep their old indexes: renumber them against the new block list
    const rendered = els()
    let r = 0
    blocks.forEach((b, idx) => { if (b.type !== 'space' && !b.phantom && rendered[r]) rendered[r++].dataset.i = idx })
    src = text()
    startEdit(k, 0)
  }

  // ------------------------------------------------------------------ events

  col.addEventListener('mousedown', (ev) => {
    if (!edit) return
    const blk = ev.target.closest('.fb-mb')
    if (!blk || blk.classList.contains('editing')) return
    if (ev.target.closest('a, input, button, summary')) { ev.preventDefault(); return } // keep the caret; the click still lands
    // Clicking another block while one is being edited: commit and edit the clicked one in the same gesture.
    ev.preventDefault()
    const i = +blk.dataset.i
    const off = startOffset(i)
    const caret = caretFor(blk, ev)
    commit()
    startEdit(indexAtOffset(off), caret)
  })

  function caretFor(blk, ev) {
    const body = blk.querySelector('.fb-mb-body')
    if (!body) return 0
    let range = null
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(ev.clientX, ev.clientY)
    else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(ev.clientX, ev.clientY)
      if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset) }
    }
    const b = blocks[+blk.dataset.i]
    let raw = b.raw.replace(/\s+$/, '')
    let skip = 0
    if (b.type === 'heading') { const m = /^#{1,6}[ \t]+/.exec(raw); if (m) { skip = m[0].length; raw = raw.slice(skip) } }
    if (!range || !body.contains(range.startContainer)) return Infinity
    const pre = document.createRange()
    pre.selectNodeContents(body)
    pre.setEnd(range.startContainer, range.startOffset)
    const plain = body.textContent
    return mapOffset(raw, plain, pre.toString().length)
  }

  col.addEventListener('click', (ev) => {
    const t = ev.target
    const add = t.closest('.fb-mb-add')
    if (add) {
      const blk = add.closest('.fb-mb')
      insertParagraphAfter(+blk.dataset.i)
      return
    }
    const a = t.closest('a[href]')
    if (a) {
      ev.preventDefault()
      const href = a.getAttribute('href')
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1))
        const target = col.querySelector('[id="' + CSS.escape(id) + '"]')
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else o.onLink(href)
      return
    }
    if (t.closest('input.task')) return
    const blk = t.closest('.fb-mb')
    if (!blk || blk.classList.contains('editing')) return
    if (t.closest('.mermaid-box.rendered svg, summary, button')) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && blk.contains(sel.anchorNode)) return
    startEdit(+blk.dataset.i, caretFor(blk, ev))
  })

  col.addEventListener('change', (ev) => {
    const t = ev.target
    if (!t.matches || !t.matches('input.task')) return
    const blk = t.closest('.fb-mb')
    const n = Array.from(blk.querySelectorAll('input.task')).indexOf(t)
    const off = startOffset(+blk.dataset.i)
    if (edit) commit()
    const k = indexAtOffset(off)
    blocks[k].raw = toggleTask(blocks[k].raw, n)
    relex(text())
    renderAll()
    o.onChange(src)
  })

  tail.addEventListener('click', () => {
    if (!ok) return
    const last = (() => { for (let k = blocks.length - 1; k >= 0; k--) if (nonSpace(k)) return k; return -1 })()
    if (last < 0) {
      relex('')
      blocks = [{ type: 'paragraph', raw: '', phantom: true }]
      startEdit(0, 0)
      return
    }
    const b = blocks[last]
    if (b.type === 'paragraph' && b.raw.trim() === '') startEdit(last, 0)
    else insertParagraphAfter(last)
  })

  // ------------------------------------------------------------------ api

  return {
    el: root,
    /** Resolves false when the source cannot round-trip through blocks (then the caller shows Source only). */
    async setText(next) {
      lib ||= await loadMD()
      if (destroyed) return true
      let again = null
      if (edit) {
        if (document.activeElement === edit.ta) again = { off: startOffset(edit.i), caret: edit.prefix.length + edit.ta.selectionStart }
        edit.ta.blur()
        edit = null
      }
      relex(next)
      renderAll()
      if (again && ok) {
        const k = indexAtOffset(again.off)
        const pre = blocks[k] && blocks[k].type === 'heading' ? (/^#{1,6}[ \t]+/.exec(blocks[k].raw) || [''])[0].length : 0
        if (k >= 0) startEdit(k, Math.max(0, again.caret - pre))
      }
      return ok
    },
    getText: () => (edit ? edit.before + edit.prefix + edit.ta.value + edit.tail + edit.after : src),
    setMarks(list) { marks = list || []; applyMarks() },
    commit,
    /** Caret into the first (or the block containing `line`) block. */
    focus(line) {
      if (!ok || !blocks.length) return
      let i = nextBlock(-1)
      if (i >= 0 && blocks[i].type === 'frontmatter') i = nextBlock(i)
      if (line) {
        const spans = lineSpans(blocks)
        const k = spans.findIndex((s, j) => nonSpace(j) && s.start <= line && s.end >= line)
        if (k >= 0) i = k
      }
      if (i >= 0) startEdit(i, 0)
    },
    scrollToLine(line) {
      const spans = lineSpans(blocks)
      const k = spans.findIndex((s, j) => nonSpace(j) && s.end >= line)
      const el = els().find((x) => +x.dataset.i === k)
      if (el) el.scrollIntoView({ block: 'start' })
    },
    retheme() {
      for (const box of col.querySelectorAll('.mermaid-box')) {
        delete box.dataset.done
        box.classList.remove('rendered', 'failed')
        box.innerHTML = ''
        box.append(h('pre', null, h('code', null, box.__src)))
      }
      typeset()
    },
    isEditing: () => !!edit,
    destroy() { destroyed = true; root.remove() },
  }
}
