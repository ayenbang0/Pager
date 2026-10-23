// Pure helpers of the Files block (no DOM, no I/O): unit-tested in files-util.test.mjs.

const BY_EXT = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', ipynb: 'json', webmanifest: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html', xhtml: 'html', xml: 'xml', svg: 'xml', xsl: 'xml', xsd: 'xml', plist: 'xml', csproj: 'xml',
  props: 'xml', targets: 'xml', md: 'markdown', markdown: 'markdown', mdx: 'markdown', mdown: 'markdown',
  py: 'python', pyi: 'python', pyw: 'python', rs: 'rust', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
  java: 'java', cs: 'csharp', go: 'go', php: 'php', sql: 'sql', yaml: 'yaml', yml: 'yaml', kt: 'kotlin', kts: 'kotlin', scala: 'scala', dart: 'dart',
  m: 'objectivec', mm: 'objectivec', glsl: 'shader', frag: 'shader', vert: 'shader', hlsl: 'shader', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ksh: 'shell', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', toml: 'toml', rb: 'ruby', rake: 'ruby', gemspec: 'ruby', lua: 'lua',
  swift: 'swift', diff: 'diff', patch: 'diff', ini: 'properties', properties: 'properties', cfg: 'properties', conf: 'properties', env: 'properties',
  editorconfig: 'properties', cmake: 'cmake', r: 'r', pl: 'perl', pm: 'perl', groovy: 'groovy', gradle: 'groovy', hs: 'haskell', erl: 'erlang',
  clj: 'clojure', cljs: 'clojure', lisp: 'lisp', el: 'lisp', proto: 'protobuf', tcl: 'tcl', jl: 'julia',
}
const BY_NAME = {
  dockerfile: 'dockerfile', makefile: 'shell', gnumakefile: 'shell', 'cmakelists.txt': 'cmake', '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell',
  '.gitignore': 'properties', '.gitattributes': 'properties', '.npmrc': 'properties', '.env': 'properties', 'nginx.conf': 'nginx', gemfile: 'ruby',
  rakefile: 'ruby', 'package.json': 'json', 'tsconfig.json': 'json',
}

export const baseOf = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
export const dirOf = (p) => {
  const s = String(p || '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i <= 0 ? (i === 0 ? s.slice(0, 1) : '') : s.slice(0, i)
}
export const extOf = (p) => {
  const b = baseOf(p).toLowerCase()
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i + 1)
}

/** CodeMirror language id for a path, or null (plain text). */
export function langForPath(p) {
  const b = baseOf(p).toLowerCase()
  if (BY_NAME[b]) return BY_NAME[b]
  if (b.startsWith('dockerfile.')) return 'dockerfile'
  return BY_EXT[extOf(p)] || null
}

const FENCE_NAMES = {
  javascript: 'javascript', typescript: 'typescript', python: 'python', rust: 'rust', golang: 'go', bash: 'shell', shell: 'shell', console: 'shell',
  powershell: 'powershell', pwsh: 'powershell', 'c++': 'cpp', 'c#': 'csharp', csharp: 'csharp', jsonc: 'json', yml: 'yaml', dockerfile: 'dockerfile',
}
/** Language id for a Markdown code fence info string (`ts`, `bash`, `c++`…), or null. */
export function langForFence(info) {
  const l = String(info || '').trim().split(/\s+/)[0].toLowerCase()
  return l ? FENCE_NAMES[l] || BY_EXT[l] || null : null
}

export const isMarkdownPath = (p) => ['md', 'markdown', 'mdx', 'mdown'].includes(extOf(p))
/** Which files have a Rendered / Source toggle. */
export const hasRendered = (p) => isMarkdownPath(p) || extOf(p) === 'svg'

/** `path`, `path:12`, `path:12:3` -> { path, line, col }. A Windows drive colon (`C:\x`, `C:/x`) is never a position. */
export function parsePathSpec(spec) {
  let s = String(spec || '').trim()
  if (s.length > 1 && s[0] === '"' && s.endsWith('"')) s = s.slice(1, -1)
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(s)
  let p = m[1]
  let line = m[2] ? +m[2] : undefined
  let col = m[3] ? +m[3] : undefined
  if (/^[A-Za-z]$/.test(p)) { p = s; line = undefined; col = undefined } // "C:12" never means drive + line
  return { path: p, line, col }
}

/** Breadcrumb of `file` below `root`: [{ name, path }] with the file last; falls back to the last three segments. */
export function breadcrumb(file, root) {
  const f = String(file || '').replace(/\\/g, '/')
  let base = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const win = /^[A-Za-z]:/.test(f)
  const eq = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b)
  let parts
  let head = ''
  if (base && f.length > base.length && eq(f.slice(0, base.length), base) && f[base.length] === '/') {
    parts = f.slice(base.length + 1).split('/')
    head = base
  } else {
    parts = f.split('/').filter((x, i) => x !== '' || i === 0)
    if (parts.length > 3) { head = parts.slice(0, parts.length - 3).join('/'); parts = parts.slice(-3) }
  }
  let acc = head
  return parts.map((name) => {
    acc = acc ? acc + '/' + name : name
    return { name, path: acc }
  })
}

/** Path of `abs` relative to `base` (forward slashes); `abs` itself when it is outside. */
export function relPath(abs, base) {
  const a = String(abs || '').replace(/\\/g, '/')
  const b = String(base || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!b) return a
  const win = /^[A-Za-z]:/.test(a)
  const head = a.slice(0, b.length)
  if (a.length > b.length && (win ? head.toLowerCase() === b.toLowerCase() : head === b) && a[b.length] === '/') return a.slice(b.length + 1)
  return a
}

/** Resolve a link target relative to the directory of `fromFile`. Returns an absolute-looking path (forward slashes). */
export function resolveLink(fromFile, target) {
  const t = decodeURI(target.split('#')[0].split('?')[0])
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(t)) return t.replace(/\\/g, '/')
  const dir = dirOf(String(fromFile).replace(/\\/g, '/'))
  const out = dir.split('/')
  for (const seg of t.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (out.length > 1) out.pop() } else out.push(seg)
  }
  return out.join('/')
}

export const isExternalUrl = (u) => /^[a-z][a-z0-9+.-]+:/i.test(u)

/** 0-based offset -> { line, col } (both 1-based). */
export function lineCol(text, offset) {
  let line = 1
  let last = -1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) { line++; last = i }
  return { line, col: offset - last }
}

/** Number of line breaks in `s`. */
export function countLines(s) {
  let n = 0
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++
  return n
}

/** Blocks -> [{ start, end }] 1-based, inclusive source line range of each block (end excludes the trailing blank run). */
export function lineSpans(blocks) {
  let line = 1
  return blocks.map((b) => {
    const start = line
    const body = b.raw.replace(/\s+$/, '')
    const end = start + countLines(body)
    line = start + countLines(b.raw)
    return { start, end }
  })
}

/** Indexes of the blocks overlapped by a git gutter mark ({kind:'added'|'modified', start, end} | {kind:'removed', line}). */
export function changedBlocks(spans, marks) {
  const hit = new Set()
  for (const m of marks || []) {
    const a = m.kind === 'removed' ? m.line : m.start
    const z = m.kind === 'removed' ? m.line + 1 : m.end
    spans.forEach((s, i) => {
      if (s.end >= a && s.start <= Math.max(a, z)) hit.add(i)
    })
  }
  return hit
}

/** Toggle the n-th task-list checkbox (document order, fenced code skipped) of a block's source. */
export function toggleTask(raw, n) {
  const lines = raw.split('\n')
  let fence = null
  let seen = -1
  for (let i = 0; i < lines.length; i++) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (f) {
      if (!fence) fence = f[1][0]
      else if (f[1][0] === fence) fence = null
      continue
    }
    if (fence) continue
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(lines[i])
    if (m && ++seen === n) {
      lines[i] = m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3] + lines[i].slice(m[0].length)
      return lines.join('\n')
    }
  }
  return raw
}

/** Status label of a block under the caret. */
export function blockLabel(b) {
  switch (b.type) {
    case 'heading': return 'Heading ' + b.depth
    case 'paragraph': return 'Paragraph'
    case 'list': return /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(b.raw) ? 'Task list' : b.ordered ? 'Numbered list' : 'List'
    case 'code': return 'Code' + (b.lang ? ' · ' + b.lang : '')
    case 'blockquote': return /^>\s*\[!\w+\]/.test(b.raw) ? 'Callout' : 'Quote'
    case 'table': return 'Table'
    case 'hr': return 'Rule'
    case 'mathBlock': return 'Math'
    case 'html': return 'HTML'
    case 'frontmatter': return 'Front matter'
    default: return 'Text'
  }
}

/** Map a caret offset in a block's rendered text back to an offset in its source (markup characters are skipped). */
export function mapOffset(raw, plain, n) {
  let i = 0
  let j = 0
  while (j < n && i < raw.length) {
    if (raw[i] === plain[j] || (raw[i] === '\n' && /\s/.test(plain[j] || ''))) j++
    i++
  }
  return Math.min(i, raw.length)
}

/** GitHub-style heading slug. */
export const slug = (s) => String(s).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')

/** `> [!NOTE] title` first line -> { kind, title } for the callout kinds GitHub and Obsidian share. */
export const CALLOUTS = {
  note: 'Note', info: 'Info', tip: 'Tip', hint: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution', danger: 'Danger',
  success: 'Success', question: 'Question', failure: 'Failure', bug: 'Bug', example: 'Example', quote: 'Quote', abstract: 'Abstract', todo: 'To do',
}
export function calloutOf(text) {
  const m = /^\s*\[!(\w+)\][+-]?[ \t]*([^\n]*)/.exec(text)
  if (!m) return null
  const kind = m[1].toLowerCase()
  if (!CALLOUTS[kind]) return null
  return { kind, title: m[2].trim() || CALLOUTS[kind], rest: text.slice(m[0].length).replace(/^\n/, '') }
}

/** Enter on a list line: the marker the next line starts with, or `empty` when the item has no text (Enter then ends the list). */
export function listContinuation(line) {
  const m = /^(\s*)((?:[-*+]|\d+[.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(line)
  if (!m) return null
  const [, indent, marker, gap, task, text] = m
  if (text === '') return { empty: true, prefix: '' }
  let next = marker
  const num = /^(\d+)([.)])$/.exec(marker)
  if (num) next = +num[1] + 1 + num[2]
  return { empty: false, prefix: indent + next + gap + (task ? '[ ] ' : '') }
}

/** One hex-dump row: offset, 16 hex bytes (gap after 8), ASCII. */
export function hexRow(bytes, start, offset) {
  const n = Math.min(16, bytes.length - start)
  let hex = ''
  let asc = ''
  for (let i = 0; i < 16; i++) {
    if (i < n) {
      const b = bytes[start + i]
      hex += (b < 16 ? '0' : '') + b.toString(16) + ' '
      asc += b >= 32 && b < 127 ? String.fromCharCode(b) : '·'
    } else hex += '   '
    if (i === 7) hex += ' '
  }
  return { off: offset.toString(16).padStart(8, '0'), hex, asc }
}

export const ENCODINGS = [
  { id: 'utf8', label: 'UTF-8' },
  { id: 'utf16le', label: 'UTF-16 LE' },
  { id: 'utf16be', label: 'UTF-16 BE' },
  { id: 'latin1', label: 'Windows-1252' },
]
export const encodingLabel = (id, bom) => {
  const e = ENCODINGS.find((x) => x.id === id)
  return (e ? e.label : String(id || 'UTF-8')) + (bom && id === 'utf8' ? ' with BOM' : '')
}

export function humanSize(n) {
  if (n < 1024) return n + ' B'
  const u = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i]
}

/** Guess the indentation of a text: { tab: true } or { tab: false, size }; null when nothing is indented. Looks at the first 2000 lines. */
export function detectIndent(text) {
  const lines = text.split('\n', 2000)
  let tabs = 0
  let spaces = 0
  const diffs = new Map()
  let prev = 0
  for (const l of lines) {
    if (!l.trim()) continue
    if (l[0] === '\t') { tabs++; continue }
    const n = /^ */.exec(l)[0].length
    if (n > 0) spaces++
    const d = Math.abs(n - prev)
    if (n > 0 && d > 0 && d <= 8) diffs.set(d, (diffs.get(d) || 0) + 1)
    prev = n
  }
  if (!tabs && !spaces) return null
  if (tabs > spaces) return { tab: true, size: 4 }
  let best = 4
  let bc = 0
  for (const [d, c] of diffs) if ((d === 2 || d === 4 || d === 8 || d === 3) && c > bc) { best = d; bc = c }
  return { tab: false, size: best }
}
