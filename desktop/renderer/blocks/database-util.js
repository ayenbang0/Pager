// Pure helpers for the Database block (no DOM): SQL tokenising for the editor, cell display and input parsing,
// paging, sort cycling. Tested in desktop/electron/blocks/database.test.mjs.

const KEYWORDS = new Set(`abort action add after all alter always analyze and as asc attach autoincrement before begin between by cascade case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp database default deferrable deferred delete desc detach distinct do drop each else end escape except exclusive exists explain fail filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null nulls of offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex release rename replace restrict returning right rollback row rows savepoint select set strict table temp temporary then ties to transaction trigger unbounded union unique update using vacuum values view virtual when where window with without`.split(/\s+/))

const isIdStart = (c) => /[A-Za-z_\u0080-\uffff]/.test(c)
const isIdPart = (c) => /[A-Za-z0-9_$\u0080-\uffff]/.test(c)

/** Split SQL into tokens { t, s }; t is kw | fn | id | str | num | com | param | op | ws. The tokens always concatenate back to `sql`. */
export function tokenizeSql(sql) {
  const out = []
  const n = sql.length
  let i = 0
  const push = (t, j) => { out.push({ t, s: sql.slice(i, j) }); i = j }
  while (i < n) {
    const c = sql[i]
    if (/\s/.test(c)) { let j = i + 1; while (j < n && /\s/.test(sql[j])) j++; push('ws', j); continue }
    if (c === '-' && sql[i + 1] === '-') { let j = i; while (j < n && sql[j] !== '\n') j++; push('com', j); continue }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); push('com', e < 0 ? n : e + 2); continue }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue } j++; break } j++ }
      push(c === "'" ? 'str' : 'id', j)
      continue
    }
    if (c === '[') { const e = sql.indexOf(']', i + 1); push('id', e < 0 ? n : e + 1); continue }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      let j = i + 1
      if (c === '0' && /[xX]/.test(sql[j] || '')) { j++; while (j < n && /[0-9a-fA-F]/.test(sql[j])) j++ }
      else {
        while (j < n && /[0-9._]/.test(sql[j])) j++
        if (/[eE]/.test(sql[j] || '') && /[0-9+-]/.test(sql[j + 1] || '')) { j += 2; while (j < n && /[0-9]/.test(sql[j])) j++ }
      }
      push('num', j)
      continue
    }
    if ((c === 'x' || c === 'X') && sql[i + 1] === "'") {
      const e = sql.indexOf("'", i + 2)
      push('str', e < 0 ? n : e + 1)
      continue
    }
    if (isIdStart(c)) {
      let j = i + 1
      while (j < n && isIdPart(sql[j])) j++
      const word = sql.slice(i, j)
      let k = j
      while (k < n && (sql[k] === ' ' || sql[k] === '\t')) k++
      push(KEYWORDS.has(word.toLowerCase()) ? 'kw' : sql[k] === '(' ? 'fn' : 'id', j)
      continue
    }
    if (c === '?' || c === ':' || c === '@' || c === '$') {
      let j = i + 1
      while (j < n && isIdPart(sql[j])) j++
      push(j > i + 1 || c === '?' ? 'param' : 'op', j)
      continue
    }
    push('op', i + 1)
  }
  return out
}

// ---------- values ----------
/** 'null' | 'int' | 'real' | 'text' | 'blob' for a wire value (see encodeValue in database-engine.mjs). */
export function valueKind(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'real'
  if (typeof v === 'string') return 'text'
  if (typeof v === 'object') return v.t === 'int' ? 'int' : v.t === 'real' ? 'real' : v.t === 'blob' ? 'blob' : 'text'
  return 'text'
}

const spacedHex = (hex, max) => (hex.slice(0, max * 2).match(/../g) || []).join(' ')

/** What a grid cell shows: { kind, text, title }. Long text is clipped in the grid; the whole value lives in the cell inspector. */
export function displayValue(v) {
  const kind = valueKind(v)
  if (kind === 'null') return { kind, text: 'NULL', title: '' }
  if (kind === 'blob') {
    const shown = spacedHex(v.hex, 12)
    return { kind, text: `BLOB ${formatBytes(v.n)}`, title: `${v.n} bytes: ${shown}${v.n > 12 ? ' …' : ''}` }
  }
  const raw = typeof v === 'object' ? String(v.v) : String(v)
  const oneLine = raw.replace(/\s*[\r\n]+\s*/g, ' ⏎ ')
  const clip = oneLine.length > 400 ? oneLine.slice(0, 400) + '…' : oneLine
  return { kind, text: clip, title: typeof v === 'object' && v.n ? `${v.n} characters` : '' }
}

/** The editable text of a text/number cell, or null when the value cannot be edited as text (BLOB, truncated text). */
export function editText(v) {
  const kind = valueKind(v)
  if (kind === 'null') return ''
  if (kind === 'blob') return null
  if (typeof v === 'object') return v.n !== undefined && v.n > String(v.v).length ? null : String(v.v)
  return String(v)
}

/** SQLite column affinity from a declared type (https://sqlite.org/datatype3.html#determination_of_column_affinity). */
export function affinityOf(type) {
  const t = String(type || '').toUpperCase()
  if (t.includes('INT')) return 'integer'
  if (/CHAR|CLOB|TEXT/.test(t)) return 'text'
  if (t === '' || t.includes('BLOB')) return 'none'
  if (/REAL|FLOA|DOUB/.test(t)) return 'real'
  return 'numeric'
}

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const INT = /^[+-]?\d+$/

/** Text typed in a cell → wire value for `update`. TEXT columns keep text; numeric columns and typeless columns take numbers. */
export function parseCellInput(text, type) {
  const aff = affinityOf(type)
  const s = text.trim()
  if (aff === 'text') return text
  if (INT.test(s)) {
    const big = BigInt(s)
    return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : { t: 'int', v: big.toString() }
  }
  if (NUM.test(s)) return aff === 'none' || aff === 'numeric' || aff === 'real' ? { t: 'real', v: s } : text
  return text
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`
}

export function formatMs(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

// ---------- paging and sorting ----------
/** '1 – 8 of 12'. */
export function pageLabel(offset, count, total) {
  if (!total || !count) return `0 of ${total.toLocaleString('en-US')}`
  return `${(offset + 1).toLocaleString('en-US')} – ${(offset + count).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`
}

/** Offsets for first / previous / next / last page. */
export function pageOffsets(offset, limit, total) {
  const last = Math.max(0, Math.floor((Math.max(total, 1) - 1) / limit) * limit)
  return { first: 0, prev: Math.max(0, offset - limit), next: Math.min(last, offset + limit), last, hasPrev: offset > 0, hasNext: offset + limit < total }
}

/** 'Go to row' (1-based) → the offset of the page that holds it. */
export function offsetForRow(row, limit, total) {
  const r = Math.min(Math.max(1, Math.floor(Number(row)) || 1), Math.max(1, total))
  return Math.floor((r - 1) / limit) * limit
}

/** Header click: none → asc → desc → none. Ctrl/Shift adds the column to the sort instead of replacing it. */
export function nextSort(sort, col, additive) {
  const cur = sort.find((s) => s.col === col)
  const next = !cur ? 'asc' : cur.dir === 'asc' ? 'desc' : null
  const rest = additive ? sort.filter((s) => s.col !== col) : []
  if (!next) return additive ? rest : []
  if (!additive) return [{ col, dir: next }]
  return cur ? sort.map((s) => (s.col === col ? { col, dir: next } : s)) : [...rest, { col, dir: next }]
}

// ---------- clipboard ----------
const tsvCell = (v) => {
  const k = valueKind(v)
  if (k === 'null') return ''
  if (k === 'blob') return `X'${v.hex}'`
  return (typeof v === 'object' ? String(v.v) : String(v)).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
}
export const rowsToTsv = (rows) => rows.map((r) => r.map(tsvCell).join('\t')).join('\n')

/** Constraint chips for a column of the Structure tab. */
export function columnChips(col, table) {
  const chips = []
  if (col.pk) chips.push({ label: 'PK', title: 'Primary key' })
  if (col.pk && table?.autoincrement) chips.push({ label: 'AI', title: 'AUTOINCREMENT' })
  if (col.notnull) chips.push({ label: 'NN', title: 'NOT NULL' })
  if (col.generated) chips.push({ label: 'GEN', title: 'Generated column' })
  for (const fk of table?.foreignKeys || []) if (fk.from === col.name) chips.push({ label: `→ ${fk.table}${fk.to ? '.' + fk.to : ''}`, title: `References ${fk.table}`, fk: true })
  for (const ix of table?.indexes || []) if (ix.unique && ix.origin === 'u' && ix.columns.length === 1 && ix.columns[0] === col.name) chips.push({ label: 'UNQ', title: 'UNIQUE' })
  return chips
}
