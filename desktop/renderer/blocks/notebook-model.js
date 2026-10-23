// Pure helpers of the notebook block: nbformat text/stream/output handling, kernel event reduction, ANSI runs, a Python
// highlighter and a small Markdown renderer. No DOM, no I/O: unit-tested in notebook-model.test.mjs.

export const joinText = (v) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '')

export function splitLines(text) {
  if (!text) return []
  return text.match(/[^\n]*\n|[^\n]+$/g) || []
}

/** The cell source as one string. */
export const sourceOf = (raw) => joinText(raw.source)

/** Store edited text back, leaving the original array/string representation untouched when nothing changed. */
export function setSource(raw, text) {
  if (joinText(raw.source) === text) return false
  raw.source = splitLines(text)
  return true
}

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;')

export function formatDuration(ms) {
  if (!(ms >= 0)) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// ---------------------------------------------------------------------------------------------------------------
// Stream text: carriage returns and backspaces overwrite, like a terminal (tqdm redraws its bar with "\r").

function overwrite(prev, next) {
  return next + (prev.length > next.length ? prev.slice(next.length) : '')
}

/** Collapse "\r" and "\b" in a stream. A trailing "\r" is kept so the next chunk still overwrites that line. */
export function normalizeStream(text) {
  text = text.replace(/\r+\n/g, '\n')
  if (!text.includes('\r') && !text.includes('\b')) return text
  for (;;) {
    const next = text.replace(/[^\n\x08]\x08/g, '')
    if (next === text) break
    text = next
  }
  const lines = text.split('\n')
  const last = lines.length - 1
  return lines
    .map((line, i) => {
      if (!line.includes('\r')) return line
      const segs = line.split('\r')
      let out = segs[0]
      for (let k = 1; k < segs.length; k++) out = overwrite(out, segs[k])
      return i === last && segs[segs.length - 1] === '' ? out + '\r' : out
    })
    .join('\n')
}

export const STREAM_CAP = 2 << 20

/** prev + add, normalised, and kept under `cap` characters (the oldest lines go, with a note). */
export function appendStream(prev, add, cap = STREAM_CAP) {
  let text = normalizeStream(prev + add)
  if (text.length > cap) {
    const cut = text.indexOf('\n', text.length - cap)
    text = '… earlier output truncated …\n' + (cut >= 0 ? text.slice(cut + 1) : text.slice(-cap))
  }
  return text
}

// ---------------------------------------------------------------------------------------------------------------
// Kernel events -> nbformat outputs

export function newRun() {
  return { displays: new Map(), clearPending: false }
}

export const MIME_ORDER = ['text/html', 'text/markdown', 'image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'text/latex', 'application/json', 'text/plain']

export function pickMime(data) {
  if (!data) return null
  for (const mime of MIME_ORDER) if (data[mime] !== undefined && data[mime] !== null) return mime
  const other = Object.keys(data).find((m) => m.startsWith('text/'))
  return other || null
}

function pushOutput(raw, st, out) {
  let cleared = false
  if (st.clearPending) {
    raw.outputs = []
    st.displays.clear()
    st.clearPending = false
    cleared = true
  }
  if (!Array.isArray(raw.outputs)) raw.outputs = []
  raw.outputs.push(out)
  return { type: cleared ? 'reset' : 'append', index: raw.outputs.length - 1 }
}

/**
 * Apply one kernel event of a running cell to its raw nbformat cell. Returns what changed so the view can patch
 * cheaply: { type: 'reset' } | { type: 'append', index } | { type: 'stream', index } | { type: 'done', status, ms, count } | null.
 */
export function applyEvent(raw, st, ev) {
  switch (ev.type) {
    case 'started':
      raw.outputs = []
      st.displays.clear()
      st.clearPending = false
      raw.execution_count = ev.count || null
      return { type: 'reset' }
    case 'stream': {
      const name = ev.name === 'stderr' ? 'stderr' : 'stdout'
      if (st.clearPending) {
        raw.outputs = []
        st.clearPending = false
      }
      if (!Array.isArray(raw.outputs)) raw.outputs = []
      const last = raw.outputs[raw.outputs.length - 1]
      if (last && last.output_type === 'stream' && last.name === name) {
        last.text = appendStream(joinText(last.text), ev.text || '')
        return { type: 'stream', index: raw.outputs.length - 1 }
      }
      raw.outputs.push({ output_type: 'stream', name, text: appendStream('', ev.text || '') })
      return { type: 'append', index: raw.outputs.length - 1 }
    }
    case 'display': {
      const out = { output_type: 'display_data', data: ev.data || {}, metadata: ev.metadata || {} }
      const change = pushOutput(raw, st, out)
      if (ev.display_id) st.displays.set(ev.display_id, out)
      return change
    }
    case 'result':
      return pushOutput(raw, st, { output_type: 'execute_result', execution_count: ev.count ?? null, data: ev.data || {}, metadata: ev.metadata || {} })
    case 'error':
      return pushOutput(raw, st, { output_type: 'error', ename: ev.ename || 'Error', evalue: ev.evalue || '', traceback: Array.isArray(ev.traceback) ? ev.traceback : [] })
    case 'kernel_error':
      return pushOutput(raw, st, { output_type: 'error', ename: 'KernelError', evalue: 'the kernel hit an internal error', traceback: String(ev.text || '').split('\n') })
    case 'clear':
      if (ev.wait) {
        st.clearPending = true
        return null
      }
      raw.outputs = []
      st.displays.clear()
      return { type: 'reset' }
    case 'done':
      if (ev.status !== 'aborted' && ev.count) raw.execution_count = ev.count
      return { type: 'done', status: ev.status, ms: ev.ms, count: ev.count }
    default:
      return null
  }
}

/** Replace a display_data output in place (display_id update). */
export function updateDisplay(out, ev) {
  out.data = ev.data || {}
  out.metadata = ev.metadata || {}
}

// ---------------------------------------------------------------------------------------------------------------
// ANSI

const PALETTE_256 = (() => {
  const levels = [0, 95, 135, 175, 215, 255]
  const list = []
  for (let i = 16; i < 232; i++) {
    const n = i - 16
    list[i] = `rgb(${levels[Math.floor(n / 36)]},${levels[Math.floor(n / 6) % 6]},${levels[n % 6]})`
  }
  for (let i = 232; i < 256; i++) {
    const v = 8 + (i - 232) * 10
    list[i] = `rgb(${v},${v},${v})`
  }
  return list
})()

const colorFor = (n) => (n < 16 ? n : PALETTE_256[n] || null)

/** Split text carrying SGR escapes into runs { text, fg, bg, bold, dim, italic, underline }. fg/bg: 0-15 (theme slot), css string, or null. */
export function ansiRuns(text) {
  const runs = []
  let st = {}
  let at = 0
  const re = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]/g
  const push = (t) => {
    if (!t) return
    const prev = runs[runs.length - 1]
    if (prev && prev.fg === (st.fg ?? null) && prev.bg === (st.bg ?? null) && !prev.bold === !st.bold && !prev.dim === !st.dim && !prev.italic === !st.italic && !prev.underline === !st.underline) prev.text += t
    else runs.push({ text: t, fg: st.fg ?? null, bg: st.bg ?? null, bold: !!st.bold, dim: !!st.dim, italic: !!st.italic, underline: !!st.underline })
  }
  let m
  while ((m = re.exec(text))) {
    push(text.slice(at, m.index))
    at = m.index + m[0].length
    if (m[1] === undefined) continue
    const codes = m[1] === '' ? [0] : m[1].split(/[;:]/).map((c) => (c === '' ? 0 : parseInt(c, 10)))
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0) st = {}
      else if (c === 1) st.bold = true
      else if (c === 2) st.dim = true
      else if (c === 3) st.italic = true
      else if (c === 4) st.underline = true
      else if (c === 22) st.bold = st.dim = false
      else if (c === 23) st.italic = false
      else if (c === 24) st.underline = false
      else if (c >= 30 && c <= 37) st.fg = c - 30
      else if (c >= 90 && c <= 97) st.fg = c - 90 + 8
      else if (c >= 40 && c <= 47) st.bg = c - 40
      else if (c >= 100 && c <= 107) st.bg = c - 100 + 8
      else if (c === 39) st.fg = null
      else if (c === 49) st.bg = null
      else if (c === 38 || c === 48) {
        const key = c === 38 ? 'fg' : 'bg'
        if (codes[i + 1] === 5) {
          st[key] = colorFor(codes[i + 2] ?? 0)
          i += 2
        } else if (codes[i + 1] === 2) {
          st[key] = `rgb(${codes[i + 2] | 0},${codes[i + 3] | 0},${codes[i + 4] | 0})`
          i += 4
        }
      }
    }
  }
  push(text.slice(at))
  return runs
}

// ---------------------------------------------------------------------------------------------------------------
// Python highlighter -> HTML

const KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '),
)
const BUILTINS = new Set(
  'abs all any bool bytes dict dir enumerate filter float format frozenset getattr hasattr id input int isinstance iter len list map max min next object open print range repr reversed round set setattr slice sorted str sum super tuple type vars zip self cls'.split(' '),
)
const PY_TOKEN =
  /((?<![^\n])[ \t]*[%!][^\n]*)|(#[^\n]*)|((?:[rRbBuUfF]{1,2})?(?:'''[\s\S]*?(?:'''|$)|"""[\s\S]*?(?:"""|$)|'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?))|(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)|(@[A-Za-z_][\w.]*)|([A-Za-z_]\w*)|(\n)|([\s\S])/y

/** Tokens [class, text] for a Python source (consecutive tokens of one class merged). */
export function pythonTokens(text) {
  const out = []
  const put = (cls, t) => {
    const last = out[out.length - 1]
    if (last && last[0] === cls) last[1] += t
    else out.push([cls, t])
  }
  PY_TOKEN.lastIndex = 0
  let m
  let defNext = ''
  while (PY_TOKEN.lastIndex < text.length && (m = PY_TOKEN.exec(text))) {
    const t = m[0]
    if (m[1] !== undefined) {
      put('mg', t)
    } else if (m[2] !== undefined) put('cm', t)
    else if (m[3] !== undefined) put('st', t)
    else if (m[4] !== undefined) put('nu', t)
    else if (m[5] !== undefined) put('dc', t)
    else if (m[6] !== undefined) {
      if (defNext) {
        put(defNext, t)
        defNext = ''
      } else if (KEYWORDS.has(t)) {
        put(t === 'True' || t === 'False' || t === 'None' ? 'nu' : 'kw', t)
        if (t === 'def') defNext = 'fn'
        else if (t === 'class') defNext = 'cl'
      } else if (BUILTINS.has(t)) put('bi', t)
      else if (text[PY_TOKEN.lastIndex] === '(') put('fn', t)
      else put('', t)
    } else put('', t)
  }
  return out
}

export function highlightPython(text) {
  return pythonTokens(text)
    .map(([cls, t]) => (cls ? `<span class="nb-${cls}">${escapeHtml(t)}</span>` : escapeHtml(t)))
    .join('')
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown -> HTML (raw HTML is passed through; the view sanitises the result)

function inline(src) {
  const stash = []
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`
  let s = src
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>$])/g, (_, c) => keep(escapeHtml(c)))
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) => keep(`<code>${escapeHtml(code.trim())}</code>`))
  s = s.replace(/<((?:https?|mailto):[^<>\s]+)>/g, (_, u) => keep(`<a href="${escapeAttr(u)}">${escapeHtml(u)}</a>`))
  s = s.replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*?)?\/?>/g, (m) => keep(m))
  s = s.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_, alt, url, title) => keep(`<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}"${title ? ` title="${escapeAttr(title)}"` : ''}>`))
  s = s.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_, text, url, title) => keep(`<a href="${escapeAttr(url)}"${title ? ` title="${escapeAttr(title)}"` : ''}>${inline(text)}</a>`))
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, pre, url) => `${pre}${keep(`<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`)}`)
  s = s.replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(?<![A-Za-z0-9_])__(?=\S)([\s\S]+?)(?<=\S)__(?![A-Za-z0-9_])/g, '<strong>$1</strong>')
  s = s.replace(/\*(?=[^\s*])([\s\S]+?)(?<=[^\s*])\*/g, '<em>$1</em>')
  s = s.replace(/(?<![A-Za-z0-9_])_(?=[^\s_])([\s\S]+?)(?<=[^\s_])_(?![A-Za-z0-9_])/g, '<em>$1</em>')
  s = s.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<del>$1</del>')
  s = s.replace(/(?: {2,}|\\)\n/g, '<br>\n')
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[i])
  return s
}

const HR = /^ {0,3}([-*_])(?: *\1){2,} *$/
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)(.*)$/
const ATX = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const HTML_BLOCK = /^ {0,3}<(?:!--|\/?(?:address|article|aside|blockquote|body|center|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|html|iframe|li|main|menu|nav|ol|p|pre|section|style|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b)/i
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const blank = (l) => /^\s*$/.test(l)

function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function startsBlock(line, next) {
  return (
    FENCE.test(line) ||
    ATX.test(line) ||
    HR.test(line) ||
    /^ {0,3}>/.test(line) ||
    HTML_BLOCK.test(line) ||
    (() => {
      const m = LIST.exec(line)
      return !!m && m[4].trim() !== '' && (!/\d/.test(m[2]) || m[2].startsWith('1'))
    })() ||
    (line.includes('|') && next !== undefined && TABLE_DELIM.test(next) && next.includes('-'))
  )
}

function renderList(lines, start) {
  let i = start
  const first = LIST.exec(lines[i])
  const ordered = /\d/.test(first[2])
  const startNum = ordered ? parseInt(first[2], 10) : 1
  const items = []
  let cur = null
  let loose = false
  while (i < lines.length) {
    const l = lines[i]
    const lm = LIST.exec(l)
    if (cur && lm && !HR.test(l) && lm[1].length < cur.indent && /\d/.test(lm[2]) === ordered) {
      cur = null
    } else if (cur && lm && lm[1].length >= cur.indent) {
      /* nested item: belongs to the current one */
    } else if (lm && !HR.test(l) && !cur && /\d/.test(lm[2]) === ordered) {
      /* first / next sibling */
    } else if (cur) {
      if (blank(l)) {
        let k = i + 1
        while (k < lines.length && blank(lines[k])) k++
        if (k >= lines.length) break
        const nl = lines[k]
        const nm = LIST.exec(nl)
        const nIndent = nl.length - nl.trimStart().length
        if (nIndent >= cur.indent) {
          cur.lines.push('')
          loose = true
          i++
          continue
        }
        if (nm && !HR.test(nl) && /\d/.test(nm[2]) === ordered && nm[1].length < cur.indent) {
          loose = true
          i = k
          continue
        }
        break
      }
      const ind = l.length - l.trimStart().length
      if (ind >= cur.indent) cur.lines.push(l.slice(cur.indent))
      else if (cur.lines.length && !blank(cur.lines[cur.lines.length - 1]) && !startsBlock(l)) cur.lines.push(l.trim())
      else break
      i++
      continue
    } else break
    if (!cur) {
      if (!lm) break
      const gap = lm[3].length > 0 && lm[3].length <= 4 ? lm[3].length : 1
      cur = { indent: lm[1].length + lm[2].length + gap, lines: [lm[4]] }
      items.push(cur)
      i++
      continue
    }
    // nested content line (a list marker indented under the current item)
    cur.lines.push(l.slice(cur.indent))
    i++
  }
  const tag = ordered ? 'ol' : 'ul'
  const body = items
    .map((it) => {
      let text = it.lines.join('\n')
      let box = ''
      const t = /^\[([ xX])\]\s+/.exec(text)
      if (t) {
        box = `<input type="checkbox" disabled${t[1] === ' ' ? '' : ' checked'}> `
        text = text.slice(t[0].length)
      }
      let html = blocks(text.split('\n'))
      if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>\n?/, '$1')
      return `<li${t ? ' class="task"' : ''}>${box}${html}</li>`
    })
    .join('')
  return { html: `<${tag}${ordered && startNum !== 1 ? ` start="${startNum}"` : ''}>${body}</${tag}>`, next: i }
}

function blocks(lines) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (blank(line)) {
      i++
      continue
    }
    let m
    if ((m = FENCE.exec(line))) {
      const fence = m[1]
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
      const body = []
      i++
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++])
      i++
      out.push(`<pre class="nb-md-code"><code${m[2] ? ` class="language-${escapeAttr(m[2])}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    if ((m = ATX.exec(line))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`)
      i++
      continue
    }
    if (HR.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if (/^ {0,3}>/.test(line)) {
      const q = []
      while (i < lines.length && !blank(lines[i]) && (/^ {0,3}>/.test(lines[i]) || (q.length && !startsBlock(lines[i], lines[i + 1])))) {
        q.push(lines[i].replace(/^ {0,3}> ?/, ''))
        i++
      }
      out.push(`<blockquote>${blocks(q)}</blockquote>`)
      continue
    }
    if (HTML_BLOCK.test(line)) {
      const h = []
      while (i < lines.length && !blank(lines[i])) h.push(lines[i++])
      out.push(h.join('\n'))
      continue
    }
    if ((m = LIST.exec(line)) && !HR.test(line)) {
      const r = renderList(lines, i)
      out.push(r.html)
      i = r.next
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line)
      const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''))
      const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</${tag}>`
      let html = `<table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>`
      i += 2
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
        const row = splitRow(lines[i++])
        html += `<tr>${head.map((_, k) => cell('td', row[k] ?? '', k)).join('')}</tr>`
      }
      out.push(html + '</tbody></table>')
      continue
    }
    if (/^( {4}|\t)/.test(line)) {
      const code = []
      while (i < lines.length && (blank(lines[i]) || /^( {4}|\t)/.test(lines[i]))) code.push(lines[i++].replace(/^( {4}|\t)/, ''))
      while (code.length && blank(code[code.length - 1])) code.pop()
      out.push(`<pre class="nb-md-code"><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    const para = []
    let heading = 0
    while (i < lines.length && !blank(lines[i])) {
      if (para.length && /^ {0,3}=+\s*$/.test(lines[i])) {
        heading = 1
        i++
        break
      }
      if (para.length && /^ {0,3}-+\s*$/.test(lines[i])) {
        heading = 2
        i++
        break
      }
      if (para.length && startsBlock(lines[i], lines[i + 1])) break
      para.push(lines[i].replace(/^\s+/, ''))
      i++
    }
    out.push(heading ? `<h${heading}>${inline(para.join('\n'))}</h${heading}>` : `<p>${inline(para.join('\n'))}</p>`)
  }
  return out.join('\n')
}

export function renderMarkdown(src) {
  return blocks(String(src).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'))
}

// ---------------------------------------------------------------------------------------------------------------
// Editing helpers

/** Indentation to carry onto a new line after `before` (the text before the caret on its line). */
export function autoIndent(before) {
  const lead = /^[ \t]*/.exec(before)[0]
  const stripped = before.replace(/#.*$/, '').trimEnd()
  return /[:([{]$/.test(stripped) ? lead + '    ' : lead
}

/** Is the caret after something completable? (Tab completes there, otherwise it indents.) */
export function wantsCompletion(before) {
  const line = before.slice(before.lastIndexOf('\n') + 1)
  return /[A-Za-z0-9_.]$/.test(line) && line.trim() !== ''
}

/** A fresh nbformat code/markdown cell. */
export function newCell(kind, id) {
  const cell = { cell_type: kind, id, metadata: {}, source: [] }
  if (kind === 'code') {
    cell.execution_count = null
    cell.outputs = []
  }
  return cell
}

export function cellId() {
  const b = new Uint8Array(4)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
