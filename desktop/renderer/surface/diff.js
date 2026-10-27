// Unified diff text -> files / hunks / numbered lines, split-view pairing, and a small single-line syntax colourer.
// Pure functions over plain strings and objects: the DOM side (render.js) only ever puts these strings in text nodes.

export const MAX_DIFF_LINES = 20000

/**
 * @typedef {{ type: 'ctx'|'add'|'del'|'note', text: string, oldNo?: number, newNo?: number }} DiffLine
 * @typedef {{ header: string, section: string, oldStart: number, oldLines: number, newStart: number, newLines: number, lines: DiffLine[] }} Hunk
 * @typedef {{ oldName: string, newName: string, name: string, status: 'modified'|'added'|'deleted'|'renamed'|'binary', meta: string[], hunks: Hunk[], additions: number, deletions: number }} DiffFile
 */

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+ ?(.*)$/
const GIT = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/

const unquote = (s) => {
  let name = s.trim()
  if (name.startsWith('"') && name.endsWith('"') && name.length > 1) name = name.slice(1, -1)
  const tab = name.indexOf('\t') // `--- a/file<TAB>timestamp`
  if (tab >= 0) name = name.slice(0, tab)
  return name
}
const stripPrefix = (n) => (n === '/dev/null' ? n : n.replace(/^[ab]\//, ''))

function newFile(oldName = '', newName = '') {
  return { oldName, newName, name: newName || oldName, status: 'modified', meta: [], hunks: [], additions: 0, deletions: 0 }
}

/**
 * Parse unified diff text (git or plain `diff -u`). Text before the first file or hunk is ignored; a bare hunk list
 * becomes one unnamed file. Stops after MAX_DIFF_LINES body lines and reports `truncated`.
 * @returns {{ files: DiffFile[], truncated: boolean, lineCount: number }}
 */
export function parseUnifiedDiff(text) {
  const rows = String(text).replace(/\r\n?/g, '\n').split('\n')
  if (rows.length && rows[rows.length - 1] === '') rows.pop()
  /** @type {DiffFile[]} */
  const files = []
  /** @type {DiffFile|null} */
  let file = null
  /** @type {Hunk|null} */
  let hunk = null
  let oldNo = 0
  let newNo = 0
  let left = 0 // old/new lines the current hunk still owes by its header
  let right = 0
  let count = 0
  let truncated = false

  const open = (o, n) => {
    file = newFile(o, n)
    files.push(file)
    hunk = null
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (hunk && (left > 0 || right > 0 || row.startsWith('\\')) && (row === '' || ' +-\\'.includes(row[0]))) {
      // body of a hunk; the header counts decide where it ends, so a `-- ` / `++ ` payload line is not mistaken for a file header
      const c = row[0]
      if (count >= MAX_DIFF_LINES) { truncated = true; break }
      count++
      if (c === '\\') hunk.lines.push({ type: 'note', text: row.slice(1).trim() })
      else if (c === '+') { hunk.lines.push({ type: 'add', text: row.slice(1), newNo: newNo++ }); right--; file.additions++ }
      else if (c === '-') { hunk.lines.push({ type: 'del', text: row.slice(1), oldNo: oldNo++ }); left--; file.deletions++ }
      else { hunk.lines.push({ type: 'ctx', text: c === ' ' ? row.slice(1) : row, oldNo: oldNo++, newNo: newNo++ }); left--; right-- }
      continue
    }
    let m
    if ((m = GIT.exec(row))) {
      open(m[1], m[2])
    } else if (row.startsWith('--- ') && (rows[i + 1] ?? '').startsWith('+++ ')) {
      const o = stripPrefix(unquote(row.slice(4)))
      const n = stripPrefix(unquote(rows[i + 1].slice(4)))
      if (!file || file.hunks.length) open(o === '/dev/null' ? '' : o, n === '/dev/null' ? '' : n)
      else { file.oldName = o === '/dev/null' ? '' : o; file.newName = n === '/dev/null' ? '' : n }
      if (o === '/dev/null') file.status = 'added'
      else if (n === '/dev/null') file.status = 'deleted'
      file.name = file.newName || file.oldName
      i++
      hunk = null
    } else if ((m = HUNK.exec(row))) {
      if (!file) open()
      oldNo = +m[1]
      newNo = +m[3]
      left = m[2] === undefined ? 1 : +m[2]
      right = m[4] === undefined ? 1 : +m[4]
      hunk = { header: row, section: m[5] || '', oldStart: oldNo, oldLines: left, newStart: newNo, newLines: right, lines: [] }
      file.hunks.push(hunk)
    } else if (file) {
      hunk = null
      if (row.startsWith('new file mode')) file.status = 'added'
      else if (row.startsWith('deleted file mode')) file.status = 'deleted'
      else if (row.startsWith('rename from ')) { file.status = 'renamed'; file.oldName = row.slice(12) }
      else if (row.startsWith('rename to ')) { file.status = 'renamed'; file.newName = row.slice(10); file.name = file.newName }
      else if (/^Binary files .* differ$|^GIT binary patch/.test(row)) file.status = 'binary'
      if (row !== '') file.meta.push(row)
    }
  }
  return { files, truncated, lineCount: count }
}

/**
 * Pair a hunk's lines for side-by-side display: runs of deletions line up with the additions that follow them.
 * @param {Hunk} hunk
 * @returns {{ left: DiffLine|null, right: DiffLine|null }[]}
 */
export function pairHunk(hunk) {
  const out = []
  const ls = hunk.lines
  for (let i = 0; i < ls.length; ) {
    const l = ls[i]
    if (l.type === 'ctx') { out.push({ left: l, right: l }); i++ }
    else if (l.type === 'note') { out.push({ left: l, right: l }); i++ }
    else {
      const dels = []
      const adds = []
      while (i < ls.length && ls[i].type === 'del') dels.push(ls[i++])
      while (i < ls.length && ls[i].type === 'add') adds.push(ls[i++])
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null })
    }
  }
  return out
}

// ---- light syntax colouring ----

const KW = {
  c: 'if else for while do switch case break continue return function const let var class new this typeof instanceof import export from default async await try catch finally throw extends super static public private protected interface type enum implements void null undefined true false in of fn pub use mod struct impl trait match mut self where loop def lambda None True False and or not pass raise with as is yield del global print elif except package func go defer chan range map select int string bool float double char long unsigned signed sizeof typedef namespace template using include define'.split(' '),
  sh: 'if then else elif fi for while do done case esac function in return export local echo cd exit set unset source alias'.split(' '),
  sql: 'select from where insert into values update set delete create table drop alter add join left right inner outer on group by order having limit and or not null as distinct union primary key index'.split(' '),
  json: ['true', 'false', 'null'],
}
const SETS = Object.fromEntries(Object.entries(KW).map(([k, v]) => [k, new Set(v)]))

const EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', java: 'js', c: 'js', h: 'js', cc: 'js', cpp: 'js', hpp: 'js', cs: 'js', go: 'js', rs: 'js', swift: 'js', kt: 'js', php: 'js', css: 'js', scss: 'js',
  py: 'py', rb: 'py', pl: 'py', r: 'py', yaml: 'py', yml: 'py', toml: 'py', ini: 'py', conf: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh', json: 'json', sql: 'sql', lua: 'sql',
}
const LINE_COMMENT = { js: '//', py: '#', sh: '#', sql: '--', json: '' }

/** The colouring family for a file name, '' when it has none. */
export function langOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '')
  return (m && EXT[m[1].toLowerCase()]) || ''
}

/**
 * Split one line into `{ cls, text }` runs (cls: '', 'kw', 'str', 'num', 'com'). Single-line only: strings and block
 * comments that span lines are coloured per line, which is all a diff view needs. Runs always concatenate to `line`.
 * @returns {{ cls: string, text: string }[]}
 */
export function highlightLine(line, lang) {
  if (!lang || line.length > 600) return [{ cls: '', text: line }]
  const set = lang === 'js' || lang === 'py' ? SETS.c : SETS[lang]
  const lc = LINE_COMMENT[lang]
  const out = []
  let plain = ''
  const flush = () => { if (plain) { out.push({ cls: '', text: plain }); plain = '' } }
  const push = (cls, text) => { flush(); out.push({ cls, text }) }
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (lc && line.startsWith(lc, i)) { push('com', line.slice(i)); i = line.length; break }
    if (lang === 'js' && c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      const stop = end < 0 ? line.length : end + 2
      push('com', line.slice(i, stop))
      i = stop
      continue
    }
    if (c === '"' || c === "'" || (c === '`' && lang !== 'json')) {
      let j = i + 1
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1
      const stop = Math.min(j + 1, line.length)
      push('str', line.slice(i, stop))
      i = stop
      continue
    }
    if (/[0-9]/.test(c) && !/[A-Za-z0-9_$]/.test(line[i - 1] ?? '')) {
      let j = i + 1
      while (j < line.length && /[0-9A-Za-z_.]/.test(line[j])) j++
      push('num', line.slice(i, j))
      i = j
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j])) j++
      const word = line.slice(i, j)
      if (set && set.has(lang === 'sql' ? word.toLowerCase() : word)) push('kw', word)
      else plain += word
      i = j
      continue
    }
    plain += c
    i++
  }
  flush()
  return out
}
