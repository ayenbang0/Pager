// Markdown engine for the Files block, bundled by build.mjs into renderer/vendor/files/md.js.
// Lossless block model: `lex` returns the document as an ordered list of blocks whose `raw` strings concatenate to the source
// byte for byte, so one block can be edited (as source) and re-rendered without touching the rest of the file.
import { Marked } from 'marked'
import DOMPurify from 'dompurify'

const marked = new Marked({ gfm: true, breaks: false })

const mathBlock = {
  name: 'mathBlock',
  level: 'block',
  start: (src) => src.match(/^ {0,3}\$\$/m)?.index,
  tokenizer(src) {
    const m = /^ {0,3}\$\$[ \t]*\n?([\s\S]+?)\n? {0,3}\$\$[ \t]*(?:\n|$)/.exec(src)
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() }
    return undefined
  },
  renderer: (t) => `<div class="math math-block" data-tex="${esc(t.text)}" data-display="1"><code>${esc(t.text)}</code></div>\n`,
}
const mathInline = {
  name: 'mathInline',
  level: 'inline',
  start: (src) => src.indexOf('$'),
  tokenizer(src) {
    const m = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/.exec(src)
    if (m) return { type: 'mathInline', raw: m[0], text: m[1] }
    return undefined
  },
  renderer: (t) => `<span class="math" data-tex="${esc(t.text)}"><code>${esc(t.text)}</code></span>`,
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

marked.use({
  extensions: [mathBlock, mathInline],
  renderer: {
    checkbox({ checked }) {
      return `<input type="checkbox" class="task" data-task${checked ? ' checked' : ''}> `
    },
    code({ text, lang }) {
      const l = (lang || '').trim().split(/\s+/)[0].toLowerCase()
      if (l === 'mermaid') return `<div class="mermaid-box"><pre><code>${esc(text)}</code></pre></div>\n`
      return `<pre data-lang="${esc(l)}"><code>${esc(text)}</code></pre>\n`
    },
  },
})

/** Leading YAML front matter: returns its raw text (with the trailing newline) or ''. */
export function frontMatter(src) {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src)
  return m ? m[0] : ''
}

/**
 * Lex a document into blocks: { type, raw, depth?, lang?, task? } (`space` blocks are the blank runs between others).
 * `ok` is false when the blocks do not reproduce the source exactly (the caller then offers Source only).
 */
export function lex(src) {
  const fm = frontMatter(src)
  const tokens = marked.lexer(src.slice(fm.length))
  const blocks = []
  if (fm) blocks.push({ type: 'frontmatter', raw: fm })
  for (const t of tokens) {
    const b = { type: t.type, raw: t.raw, tok: t }
    if (t.type === 'heading') b.depth = t.depth
    if (t.type === 'code') b.lang = t.lang || ''
    if (t.type === 'list') b.ordered = !!t.ordered
    blocks.push(b)
  }
  let joined = ''
  for (const b of blocks) joined += b.raw
  return { blocks, links: tokens.links, ok: joined === src }
}

const PURIFY = {
  ADD_ATTR: ['data-tex', 'data-display', 'data-lang', 'data-task', 'checked'],
  ADD_TAGS: ['input'],
  FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style'],
}

/** Sanitised HTML of one block (front matter becomes a dim code card). */
export function renderBlock(block, links) {
  if (block.type === 'space') return ''
  if (block.type === 'frontmatter') return `<pre class="frontmatter"><code>${esc(block.raw.trimEnd())}</code></pre>`
  const arr = [block.tok]
  arr.links = links || {}
  return DOMPurify.sanitize(marked.parser(arr), PURIFY)
}

/** Inline HTML for short strings (callout titles, tooltips). */
export function renderInline(src) {
  return DOMPurify.sanitize(marked.parseInline(src), PURIFY)
}

let katexP = null
let mermaidP = null
let mermaidSeq = 0

/** Typeset the math and mermaid diagrams under `root` (both libraries load on first use). */
export async function typeset(root, { dark = true } = {}) {
  const maths = root.querySelectorAll('.math:not([data-done])')
  if (maths.length) {
    katexP ||= import('katex').then((m) => m.default || m)
    try {
      const katex = await katexP
      for (const el of maths) {
        try {
          katex.render(el.__tex ??= el.textContent, el, { displayMode: !!el.dataset.display, throwOnError: false, output: 'html', trust: false })
        } catch { /* leave the fallback code text */ }
        el.dataset.done = '1'
      }
    } catch { /* offline vendor missing: keep the plain tex */ }
  }
  const boxes = root.querySelectorAll('.mermaid-box:not([data-done])')
  if (boxes.length) {
    mermaidP ||= import('mermaid').then((m) => m.default || m)
    try {
      const mermaid = await mermaidP
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'Geist, system-ui, sans-serif' })
      for (const el of boxes) {
        el.dataset.done = '1'
        el.__src ??= el.textContent
        try {
          const { svg } = await mermaid.render('mmd' + ++mermaidSeq, el.__src)
          el.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'], HTML_INTEGRATION_POINTS: { foreignobject: true } })
          el.classList.add('rendered')
        } catch (e) {
          el.classList.add('failed')
          el.title = String((e && e.message) || e)
        }
      }
    } catch { /* mermaid chunk missing: keep the source */ }
  }
}
