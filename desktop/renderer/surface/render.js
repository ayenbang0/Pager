// Surface block renderers. Every untrusted string (diff text, tex, diagram source, html) ends up in exactly one of:
//   - a text node (diff lines, titles, error text, source previews),
//   - a sandboxed <iframe srcdoc sandbox=""> (mermaid's sanitized SVG, the html-sandbox kind): no scripts, no forms, no
//     popups, no same-origin, and a CSP that allows nothing but inline styles and data: images,
//   - KaTeX's own DOM output for math (trust:false, so no \href / \includegraphics / \url),
//   - an <img> whose src passed the png/jpeg/gif/webp data-URL check.
// Nothing here assigns innerHTML on untrusted data.
import { copyText, makeBuilder } from './dom.js'
import { highlightLine, langOf, pairHunk, parseUnifiedDiff } from './diff.js'
import { rowsOf, validateSurface } from './protocol.js'

export const KIND_LABEL = { mermaid: 'Diagram', math: 'Math', diff: 'Diff', image: 'Image', 'html-sandbox': 'Page' }
/** Rows of diff body drawn at once; the rest is summarised so a huge patch cannot freeze the window. */
export const MAX_RENDER_LINES = 4000

/** The only sandbox attribute any surface iframe gets: empty = every restriction on. */
export const IFRAME_SANDBOX = ''
export const IFRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

const safeCss = (v, fallback) => (/^[#0-9A-Za-z(),.%\s-]{1,40}$/.test(v) ? v : fallback)

/** A complete srcdoc: CSP first, then our base style, then `markup` (already trusted-or-sandboxed, never run). */
export function sandboxDocument(markup, theme = {}) {
  const fg = safeCss(theme.fg || '', '#ededed')
  const link = safeCss(theme.link || '', '#9dbcff')
  const scheme = theme.dark === false ? 'light' : 'dark'
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}">` +
    `<meta name="color-scheme" content="${scheme}"><style>:root{color-scheme:${scheme}}html,body{margin:0;height:100%}` +
    `body{color:${fg};font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;overflow:auto}a{color:${link}}${theme.css || ''}</style></head><body>` +
    markup +
    '</body></html>'
  )
}

let cssReady = false
function ensureStyles(doc) {
  if (cssReady || !doc.head) return
  cssReady = true
  const link = doc.createElement('link')
  link.rel = 'stylesheet'
  link.href = new URL('./surface.css', import.meta.url).href
  doc.head.append(link)
}

let katexCss = false
function ensureKatexCss(doc) {
  if (katexCss) return
  katexCss = true
  const link = doc.createElement('link')
  link.rel = 'stylesheet'
  link.href = new URL('../vendor/files/katex/katex.css', import.meta.url).href
  doc.head.append(link)
}

let libP = null
const loadLib = () => (libP ||= import('../vendor/files/md.js'))
let queue = Promise.resolve() // mermaid renders one at a time

/** Typeset one detached element with the vendored KaTeX / mermaid (mermaid securityLevel 'strict', output DOMPurify'd). */
function typesetOne(el, dark) {
  // typeset() looks for .math / .mermaid-box among the root's descendants, so give it a throwaway parent
  const wrap = el.ownerDocument.createElement('div')
  wrap.appendChild(el)
  const run = async () => (await loadLib()).typeset(wrap, { dark })
  const p = queue.then(run, run)
  queue = p.catch(() => {})
  return p
}

function themeOf(doc) {
  const root = doc.documentElement
  const cs = root && globalThis.getComputedStyle ? globalThis.getComputedStyle(root) : null
  const scheme = cs ? cs.colorScheme || '' : ''
  const dark = !(scheme.includes('light') && !scheme.includes('dark'))
  return { dark, fg: cs ? cs.getPropertyValue('--t1').trim() : '', link: cs ? cs.getPropertyValue('--accent-ink').trim() : '' }
}

// ---- diff view (DOM built through the text-only builder) ----

/** Colour runs for one code line, as spans holding text nodes. */
function codeCells(b, text, lang) {
  if (text === '') return b.h('span', { class: 'pgs-code' }, '\u200b')
  return b.h('span', { class: 'pgs-code' }, highlightLine(text, lang).map((r) => (r.cls ? b.h('span', { class: `pgs-t-${r.cls}` }, r.text) : r.text)))
}

const STATUS = { added: 'new', deleted: 'deleted', renamed: 'renamed', binary: 'binary' }

/**
 * @param b builder from makeBuilder
 * @param diff result of parseUnifiedDiff
 * @param state { mode: 'unified'|'split', closed: Set<string> } closed holds `f<i>` and `f<i>h<j>` keys
 * @param onChange called after a toggle so the caller can rebuild
 */
export function buildDiffView(b, diff, state, onChange) {
  const root = b.h('div', { class: `pgs-diff pgs-${state.mode}` })
  let budget = MAX_RENDER_LINES
  let hidden = 0
  diff.files.forEach((file, fi) => {
    const fkey = `f${fi}`
    const fclosed = state.closed.has(fkey)
    const lang = langOf(file.name)
    const head = b.h(
      'button',
      { type: 'button', class: 'pgs-fhead', 'aria-expanded': String(!fclosed), on: { click: () => { fclosed ? state.closed.delete(fkey) : state.closed.add(fkey); onChange() } } },
      b.icon('chev'),
      b.h('span', { class: 'pgs-fname' }, file.name || 'diff'),
      STATUS[file.status] ? b.h('span', { class: `pgs-chip pgs-chip-${file.status}` }, STATUS[file.status]) : null,
      file.status === 'renamed' && file.oldName ? b.h('span', { class: 'pgs-fold' }, `from ${file.oldName}`) : null,
      b.h('span', { class: 'pgs-stat pgs-stat-add' }, `+${file.additions}`),
      b.h('span', { class: 'pgs-stat pgs-stat-del' }, `\u2212${file.deletions}`),
    )
    const sec = b.h('section', { class: `pgs-file${fclosed ? ' closed' : ''}` }, head)
    root.appendChild(sec)
    if (fclosed) return
    if (!file.hunks.length) sec.appendChild(b.h('div', { class: 'pgs-note' }, file.status === 'binary' ? 'Binary file differs' : 'No line changes'))
    file.hunks.forEach((hunk, hi) => {
      const hkey = `f${fi}h${hi}`
      const hclosed = state.closed.has(hkey)
      sec.appendChild(
        b.h(
          'button',
          { type: 'button', class: 'pgs-hhead', 'aria-expanded': String(!hclosed), on: { click: () => { hclosed ? state.closed.delete(hkey) : state.closed.add(hkey); onChange() } } },
          b.icon('chev'),
          b.h('span', { class: 'pgs-hrange' }, `@@ \u2212${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
          hunk.section ? b.h('span', { class: 'pgs-hsec' }, hunk.section) : null,
          b.h('span', { class: 'pgs-hcount' }, `${hunk.lines.length} lines`),
        ),
      )
      if (hclosed) return
      const body = b.h('div', { class: 'pgs-lines' })
      sec.appendChild(body)
      const rows = state.mode === 'split' ? pairHunk(hunk) : hunk.lines
      for (const row of rows) {
        if (budget <= 0) { hidden++; continue }
        budget--
        body.appendChild(state.mode === 'split' ? splitRow(b, row, lang) : unifiedRow(b, row, lang))
      }
    })
  })
  if (!diff.files.length) root.appendChild(b.h('div', { class: 'pgs-note' }, 'No diff found in this text'))
  if (hidden || diff.truncated) root.appendChild(b.h('div', { class: 'pgs-note' }, hidden ? `${hidden} more lines are not drawn; copy the source to see them all` : 'The diff was cut at the line limit'))
  return root
}

const SIGN = { add: '+', del: '\u2212', ctx: ' ', note: '\\' }

function unifiedRow(b, l, lang) {
  if (l.type === 'note') return b.h('div', { class: 'pgs-row note' }, b.h('span', { class: 'pgs-no' }), b.h('span', { class: 'pgs-no' }), b.h('span', { class: 'pgs-sg' }, '\\'), b.h('span', { class: 'pgs-code' }, l.text))
  return b.h('div', { class: `pgs-row ${l.type}` }, b.h('span', { class: 'pgs-no' }, l.oldNo ?? ''), b.h('span', { class: 'pgs-no' }, l.newNo ?? ''), b.h('span', { class: 'pgs-sg' }, SIGN[l.type]), codeCells(b, l.text, lang))
}

function half(b, l, side, lang) {
  if (!l) return b.h('div', { class: 'pgs-half empty' }, b.h('span', { class: 'pgs-no' }), b.h('span', { class: 'pgs-code' }))
  if (l.type === 'note') return b.h('div', { class: 'pgs-half note' }, b.h('span', { class: 'pgs-no' }), b.h('span', { class: 'pgs-code' }, l.text))
  return b.h('div', { class: `pgs-half ${l.type}` }, b.h('span', { class: 'pgs-no' }, (side === 'l' ? l.oldNo : l.newNo) ?? ''), codeCells(b, l.text, lang))
}

function splitRow(b, pair, lang) {
  return b.h('div', { class: 'pgs-srow' }, half(b, pair.left, 'l', lang), half(b, pair.right, 'r', lang))
}

// ---- mounting ----

function parseViewBox(svg) {
  const m = /viewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/.exec(svg)
  return m ? { w: Math.round(+m[1]), h: Math.round(+m[2]) } : null
}

/**
 * Mount one surface block into `host` and return { el, dispose }.
 * opts: { openInPane?(msg), fill?: boolean, doc?: Document, onCopy?() }
 */
export function mountSurface(host, input, opts = {}) {
  const doc = opts.doc || host.ownerDocument
  ensureStyles(doc)
  const b = makeBuilder(doc)
  const v = validateSurface(input)
  const msg = v.ok ? v.msg : null
  const kind = msg ? msg.kind : 'html-sandbox'
  let disposed = false
  let copyTimer = 0

  const meta = b.h('span', { class: 'pgs-meta' })
  const body = b.h('div', { class: 'pgs-body' })
  const actions = b.h('div', { class: 'pgs-actions' })
  const root = b.h(
    'div',
    { class: `pgs pgs-k-${kind}${opts.fill ? ' pgs-fill' : ''}`, 'data-kind': kind, 'data-id': msg ? msg.id : '' },
    b.h('div', { class: 'pgs-head' }, b.h('span', { class: 'pgs-kind' }, b.icon(kind), b.h('span', null, KIND_LABEL[kind] || kind)), b.h('span', { class: 'pgs-title' }, msg && msg.title ? msg.title : ''), meta, actions),
    body,
  )
  host.appendChild(root)

  const button = (label, iconName, fn, text) => {
    const el = b.h('button', { type: 'button', class: 'pgs-btn', title: label, 'aria-label': label, on: { click: fn } }, b.icon(iconName), text ? b.h('span', null, text) : null)
    actions.appendChild(el)
    return el
  }
  const fail = (text, source) => {
    const shown = []
    shown.push(b.h('div', { class: 'pgs-err' }, text))
    if (source) shown.push(b.h('pre', { class: 'pgs-src' }, source.length > 2000 ? `${source.slice(0, 2000)}\n\u2026` : source))
    body.replaceChildren(...shown)
    root.classList.add('failed')
  }

  if (!msg) {
    fail(`This surface was refused: ${v.error}`)
    return { el: root, dispose: () => root.remove() }
  }

  const dark = themeOf(doc)
  const loading = () => body.replaceChildren(b.h('div', { class: 'pgs-loading' }, b.h('span', { class: 'pgs-spin' }), 'Rendering\u2026'))
  const frame = (markup, extraCss) =>
    b.h('iframe', { class: 'pgs-frame', sandbox: IFRAME_SANDBOX, referrerpolicy: 'no-referrer', loading: 'eager', title: msg.title || KIND_LABEL[kind], srcdoc: sandboxDocument(markup, { ...dark, css: extraCss }) })

  let diffUi = null
  if (kind === 'diff') {
    const parsed = parseUnifiedDiff(msg.source)
    const state = { mode: 'unified', closed: new Set() }
    const allKeys = () => {
      const keys = []
      parsed.files.forEach((f, fi) => f.hunks.forEach((_, hi) => keys.push(`f${fi}h${hi}`)))
      return keys
    }
    const redraw = () => {
      const top = body.scrollTop
      body.replaceChildren(buildDiffView(b, parsed, state, redraw))
      body.scrollTop = top
      seg.unified.classList.toggle('on', state.mode === 'unified')
      seg.split.classList.toggle('on', state.mode === 'split')
      seg.unified.setAttribute('aria-pressed', String(state.mode === 'unified'))
      seg.split.setAttribute('aria-pressed', String(state.mode === 'split'))
      fold.title = state.closed.size ? 'Expand all hunks' : 'Collapse all hunks'
      fold.setAttribute('aria-label', fold.title)
    }
    const adds = parsed.files.reduce((n, f) => n + f.additions, 0)
    const dels = parsed.files.reduce((n, f) => n + f.deletions, 0)
    meta.append(b.h('span', { class: 'pgs-stat pgs-stat-add' }, `+${adds}`), b.h('span', { class: 'pgs-stat pgs-stat-del' }, `\u2212${dels}`), b.h('span', { class: 'pgs-fold' }, `${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'}`))
    const seg = {
      unified: b.h('button', { type: 'button', class: 'pgs-seg on', 'aria-pressed': 'true', on: { click: () => { state.mode = 'unified'; redraw() } } }, 'Unified'),
      split: b.h('button', { type: 'button', class: 'pgs-seg', 'aria-pressed': 'false', on: { click: () => { state.mode = 'split'; redraw() } } }, 'Split'),
    }
    actions.appendChild(b.h('span', { class: 'pgs-segs', role: 'group', 'aria-label': 'Diff layout' }, seg.unified, seg.split))
    const fold = button('Collapse all hunks', 'fold', () => {
      if (state.closed.size) state.closed.clear()
      else for (const k of allKeys()) state.closed.add(k)
      redraw()
    })
    diffUi = redraw
  }

  button('Copy source', 'copy', async (ev) => {
    const ok = await copyText(msg.source)
    const btn = ev.currentTarget
    btn.classList.toggle('done', ok)
    btn.title = ok ? 'Copied' : 'Copy failed'
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { btn.classList.remove('done'); btn.title = 'Copy source' }, 1400)
    if (opts.onCopy) opts.onCopy(ok)
  })
  if (opts.openInPane) button('Open in a pane', 'pane', () => opts.openInPane(msg))

  switch (kind) {
    case 'diff':
      diffUi()
      break
    case 'image': {
      const img = b.h('img', { class: 'pgs-img', src: msg.source, alt: msg.title || 'image', draggable: 'false' })
      img.addEventListener('load', () => { meta.replaceChildren(`${img.naturalWidth}\u00d7${img.naturalHeight}`) })
      img.addEventListener('error', () => fail('This image could not be decoded', ''))
      img.addEventListener('click', () => body.classList.toggle('actual'))
      body.appendChild(b.h('div', { class: 'pgs-imgwrap' }, img))
      break
    }
    case 'html-sandbox':
      body.appendChild(frame(msg.source))
      // the page ignores the pointer (so the wheel scrolls the terminal) until it is clicked; leaving the block ends that
      body.addEventListener('click', () => root.classList.add('live'))
      root.addEventListener('mouseleave', () => root.classList.remove('live'))
      break
    case 'math': {
      loading()
      ensureKatexCss(doc)
      const el = b.h('div', { class: 'math', 'data-display': '1' }, msg.source)
      typesetOne(el, dark.dark).then(
        () => {
          if (disposed) return
          if (!el.querySelector('.katex')) return fail('KaTeX could not render this expression', msg.source)
          body.replaceChildren(b.h('div', { class: 'pgs-math' }, el))
        },
        (e) => !disposed && fail(`Math could not be rendered: ${e && e.message ? e.message : e}`, msg.source),
      )
      break
    }
    case 'mermaid': {
      loading()
      const box = b.h('div', { class: 'mermaid-box' }, msg.source)
      typesetOne(box, dark.dark).then(
        () => {
          if (disposed) return
          const svg = box.classList.contains('rendered') ? box.querySelector('svg') : null
          for (const stray of doc.querySelectorAll('body > [id^="dmmd"], body > #d-mmd')) stray.remove()
          if (!svg) return fail(box.title ? `Mermaid could not render this diagram: ${box.title.split('\n')[0]}` : 'Mermaid could not render this diagram', msg.source)
          const size = parseViewBox(svg.outerHTML.slice(0, 600))
          const css = `body{display:flex;align-items:center;justify-content:center;overflow:hidden}svg{width:${size ? size.w + 'px' : 'auto'};max-width:100%;max-height:100%;height:auto}`
          if (size) meta.replaceChildren(`${size.w}\u00d7${size.h}`)
          body.replaceChildren(frame(svg.outerHTML, css))
        },
        (e) => !disposed && fail(`Mermaid could not be loaded: ${e && e.message ? e.message : e}`, msg.source),
      )
      break
    }
  }

  return {
    el: root,
    rows: rowsOf(msg),
    dispose() {
      disposed = true
      clearTimeout(copyTimer)
      root.remove()
    },
  }
}
