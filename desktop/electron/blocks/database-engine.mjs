// SQLite engine for the Database block (Node's built-in node:sqlite, no native addon).
// Runs inside database-worker.mjs, a child process of the bundled node.exe, so the Electron main thread never blocks on SQL.
//
// Safety rules (see database.test.mjs):
//  * every database opens read-only unless the caller asks for edit mode (open({readOnly:false}) / setMode);
//  * user values are ALWAYS bound parameters; the only text spliced into SQL are identifiers, and those go through
//    quoteIdent() after being matched against sqlite_schema / table_xinfo, and PRAGMA names/values from fixed allowlists;
//  * pages are capped at MAX_ROWS rows, results at MAX_ROWS rows, cells at CELL_TEXT_LIMIT characters on the wire.
import { DatabaseSync, constants as SQ } from 'node:sqlite'
import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs'
import { basename, resolve } from 'node:path'

export const MAX_ROWS = 10_000
export const DEFAULT_PAGE = 100
export const CELL_TEXT_LIMIT = 5000
export const BLOB_PREVIEW = 32
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

export class DbError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.code = code
    if (extra) Object.assign(this, extra)
  }
}

/** Quote one SQL identifier ("..." with embedded quotes doubled). The only way an identifier may reach SQL text. */
export function quoteIdent(name) {
  if (typeof name !== 'string') throw new DbError('BAD_IDENT', 'An identifier must be a string.')
  if (name.length === 0) throw new DbError('BAD_IDENT', 'An identifier cannot be empty.')
  if (name.includes('\0')) throw new DbError('BAD_IDENT', 'An identifier cannot contain a NUL character.')
  return '"' + name.replaceAll('"', '""') + '"'
}

const hex = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')

const EXPORT_OK = new Set(['select', 'with', 'values', 'pragma', 'explain'])

/** CSV field per RFC 4180: quote when it holds a comma, quote, CR or LF (or leading/trailing space), double embedded quotes. */
export function csvField(s) {
  return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s
}

/** A raw SQLite value as CSV text: NULL is empty, a BLOB is X'HEX'. */
function exportText(v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Uint8Array) return `X'${hex(v)}'`
  return String(v)
}

/** A raw SQLite value as a JSON literal. Integers keep every digit; non-finite reals become null; a BLOB is the string X'HEX'. */
function exportJson(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (v instanceof Uint8Array) return JSON.stringify(`X'${hex(v)}'`)
  return JSON.stringify(String(v))
}

/** Make column names unique for JSON object keys: a, a_2, a_3. */
function uniqueNames(cols) {
  const seen = new Map()
  return cols.map((c) => {
    const n = (seen.get(c) ?? 0) + 1
    seen.set(c, n)
    return n === 1 ? c : `${c}_${n}`
  })
}

/** A SQLite value as JSON. Plain strings, safe numbers and null stay plain; the rest are tagged objects. */
export function encodeValue(v, opts = {}) {
  if (v === null || v === undefined) return null
  const limit = opts.full ? Infinity : (opts.textLimit ?? CELL_TEXT_LIMIT)
  switch (typeof v) {
    case 'string':
      return v.length > limit ? { t: 'text', v: v.slice(0, limit), n: v.length } : v
    case 'number':
      return Number.isFinite(v) ? v : { t: 'real', v: String(v) }
    case 'bigint':
      return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : { t: 'int', v: v.toString() }
    case 'object':
      if (v instanceof Uint8Array) {
        const n = v.byteLength
        const take = opts.full ? n : Math.min(n, opts.blobPreview ?? BLOB_PREVIEW)
        return { t: 'blob', n, hex: hex(v.subarray(0, take)) }
      }
  }
  return String(v)
}

/** The inverse for values coming from the UI. Integers become BigInt (a JS number binds as REAL). */
export function decodeValue(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isInteger(v) && Number.isSafeInteger(v) ? BigInt(v) : v
  if (typeof v === 'boolean') return v ? 1n : 0n
  if (typeof v === 'object') {
    if (v.t === 'int') {
      if (!/^-?\d{1,19}$/.test(String(v.v))) throw new DbError('BAD_VALUE', 'Not an integer: ' + v.v)
      return BigInt(v.v)
    }
    if (v.t === 'real') return Number(v.v)
    if (v.t === 'text') {
      if (v.n !== undefined && v.n > String(v.v).length) throw new DbError('BAD_VALUE', 'The text was truncated; load the full cell first.')
      return String(v.v)
    }
    if (v.t === 'blob') {
      if (typeof v.hex !== 'string' || v.hex.length % 2 || /[^0-9a-f]/i.test(v.hex)) throw new DbError('BAD_VALUE', 'A BLOB needs an even number of hex digits.')
      if (v.n !== undefined && v.n * 2 > v.hex.length) throw new DbError('BAD_VALUE', 'The BLOB was truncated; load the full cell first.')
      return new Uint8Array(Buffer.from(v.hex, 'hex'))
    }
  }
  throw new DbError('BAD_VALUE', 'Unsupported value.')
}

/** Split a SQL script into statements, honouring strings, quoted identifiers, comments and CREATE TRIGGER bodies. */
export function splitStatements(sql) {
  const out = []
  const n = sql.length
  let i = 0
  let start = 0
  let hasContent = false
  let firstWords = []
  let inTrigger = false
  let caseDepth = 0
  let sawEnd = false
  let line = 1
  let startLine = 1
  const flush = (end) => {
    const text = sql.slice(start, end).trim()
    if (hasContent && text) out.push({ text, line: startLine })
    start = end + 1
    hasContent = false
    firstWords = []
    inTrigger = false
    caseDepth = 0
    sawEnd = false
  }
  const content = () => {
    if (!hasContent) {
      hasContent = true
      startLine = line
    }
  }
  while (i < n) {
    const c = sql[i]
    if (c === '\n') { line++; i++; continue }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { if (sql[i] === '\n') line++; i++ }
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      content(); sawEnd = false
      i++
      while (i < n) {
        if (sql[i] === '\n') line++
        if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue } break }
        i++
      }
      i++
      continue
    }
    if (c === '[') {
      content(); sawEnd = false
      while (i < n && sql[i] !== ']') i++
      i++
      continue
    }
    if (c === ';') {
      if (inTrigger && !sawEnd) { i++; continue }
      flush(i)
      i++
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++
      const word = sql.slice(i, j).toLowerCase()
      content()
      if (firstWords.length < 4) {
        firstWords.push(word)
        if (!inTrigger && firstWords[0] === 'create' && firstWords.slice(1, 3).includes('trigger')) inTrigger = true
      }
      if (word === 'case') { caseDepth++; sawEnd = false }
      else if (word === 'end') { if (caseDepth > 0) caseDepth--; else sawEnd = true }
      else sawEnd = false
      i = j
      continue
    }
    content(); sawEnd = false
    i++
  }
  flush(n)
  return out
}

function sniff(path) {
  let st
  try { st = statSync(path) } catch (e) { throw new DbError('NOT_FOUND', `Cannot open ${path}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`) }
  if (!st.isFile()) throw new DbError('NOT_FILE', `${path} is not a file.`)
  if (st.size === 0) return st
  const fd = openSync(path, 'r')
  try {
    const b = Buffer.alloc(16)
    readSync(fd, b, 0, 16, 0)
    if (b.toString('latin1') !== 'SQLite format 3\0') throw new DbError('NOT_SQLITE', `${basename(path)} is not a SQLite database file.`)
  } finally { closeSync(fd) }
  return st
}

// ---------- DB4S-style column filters ----------
const NUM_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/
const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m)

function bindNumeric(text) {
  if (NUM_RE.test(text)) return text.includes('.') ? Number(text) : (text.length < 19 ? BigInt(text) : text)
  return text
}

/** One filter box → { sql, params } for a quoted column. null for an empty filter. Values are bound, never spliced. */
export function filterClause(quotedCol, raw) {
  const f = String(raw ?? '').trim()
  if (!f) return null
  const up = f.toUpperCase()
  if (up === 'NULL') return { sql: `${quotedCol} IS NULL`, params: [] }
  if (up === '!NULL' || up === 'NOT NULL') return { sql: `${quotedCol} IS NOT NULL`, params: [] }
  if (f === '""') return { sql: `${quotedCol} = ''`, params: [] }
  const re = /^\/(.+)\/$/.exec(f)
  if (re) return { sql: `${quotedCol} REGEXP ?`, params: [re[1]] }
  const op = /^(==|=|<>|!=|<=|>=|<|>)(.*)$/s.exec(f)
  if (op) {
    const sqlOp = op[1] === '==' ? '=' : op[1] === '!=' ? '<>' : op[1]
    const val = op[2].trim()
    if (val === '') return null
    return { sql: `${quotedCol} ${sqlOp} ?`, params: [bindNumeric(val)] }
  }
  const btw = /^(.+)~(.+)$/.exec(f)
  if (btw) return { sql: `${quotedCol} BETWEEN ? AND ?`, params: [bindNumeric(btw[1].trim()), bindNumeric(btw[2].trim())] }
  return { sql: `CAST(${quotedCol} AS TEXT) LIKE ? ESCAPE '\\'`, params: ['%' + likeEscape(f) + '%'] }
}

// ---------- pragmas ----------
const bool = (name, label, desc, extra) => ({ name, label, desc, kind: 'bool', ...extra })
const choice = (name, label, desc, options, extra) => ({ name, label, desc, kind: 'enum', options, ...extra })
const int = (name, label, desc, extra) => ({ name, label, desc, kind: 'int', ...extra })
const ro = (name, label, desc, extra) => ({ name, label, desc, kind: 'readonly', ...extra })

/** The pragmas the page may read and set. Names and enum tokens here are the ONLY text that reaches a PRAGMA statement. */
export const PRAGMAS = [
  bool('foreign_keys', 'Foreign keys', 'Enforce FOREIGN KEY constraints on this connection. Off again for a new connection unless set here.', { group: 'Integrity', connection: true, noTx: true }),
  bool('recursive_triggers', 'Recursive triggers', 'Let triggers fire themselves.', { group: 'Integrity', connection: true }),
  bool('automatic_index', 'Automatic indexes', 'Let the planner build a temporary index for a join.', { group: 'Integrity', connection: true }),
  bool('query_only', 'Query only', 'Refuse every write on this connection, even in edit mode.', { group: 'Integrity', connection: true }),
  choice('journal_mode', 'Journal mode', 'How the rollback journal works. WAL lets readers run beside a writer.', ['delete', 'truncate', 'persist', 'memory', 'wal', 'off'], { group: 'Storage', write: true, noTx: true }),
  choice('synchronous', 'Synchronous', 'How hard SQLite waits for the disk before moving on.', [['0', 'OFF'], ['1', 'NORMAL'], ['2', 'FULL'], ['3', 'EXTRA']], { group: 'Storage', connection: true, noTx: true }),
  choice('locking_mode', 'Locking mode', 'EXCLUSIVE keeps the file locked between transactions.', ['normal', 'exclusive'], { group: 'Storage', connection: true }),
  choice('temp_store', 'Temp store', 'Where temporary tables and indexes live.', [['0', 'Default'], ['1', 'File'], ['2', 'Memory']], { group: 'Storage', connection: true }),
  choice('secure_delete', 'Secure delete', 'Overwrite deleted content with zeros.', [['0', 'Off'], ['1', 'On'], ['2', 'Fast']], { group: 'Storage', connection: true }),
  choice('auto_vacuum', 'Auto vacuum', 'Reclaim free pages automatically. Changing it takes effect after a VACUUM.', [['0', 'None'], ['1', 'Full'], ['2', 'Incremental']], { group: 'Storage', write: true, noTx: true }),
  choice('page_size', 'Page size', 'Bytes per page. Changing it takes effect after a VACUUM.', [['512', '512'], ['1024', '1024'], ['2048', '2048'], ['4096', '4096'], ['8192', '8192'], ['16384', '16384'], ['32768', '32768'], ['65536', '65536']], { group: 'Storage', write: true, noTx: true }),
  int('cache_size', 'Cache size', 'Pages kept in memory; a negative number is KiB.', { group: 'Performance', connection: true, min: -2_000_000, max: 2_000_000 }),
  int('mmap_size', 'Memory map size', 'Bytes of the file to map (0 = off).', { group: 'Performance', connection: true, min: 0, max: 2 ** 40 }),
  int('busy_timeout', 'Busy timeout', 'Milliseconds to wait on a locked database.', { group: 'Performance', connection: true, min: 0, max: 600_000 }),
  int('wal_autocheckpoint', 'WAL auto-checkpoint', 'Pages in the WAL that trigger a checkpoint.', { group: 'Performance', connection: true, min: 0, max: 1_000_000 }),
  int('user_version', 'User version', 'A number the application keeps in the file header.', { group: 'Application', write: true, min: -2147483648, max: 2147483647 }),
  int('application_id', 'Application ID', 'A number that tells what kind of file this is.', { group: 'Application', write: true, min: -2147483648, max: 2147483647 }),
  ro('encoding', 'Encoding', 'Text encoding of the database.', { group: 'Information' }),
  ro('page_count', 'Page count', 'Pages in the file.', { group: 'Information' }),
  ro('freelist_count', 'Free pages', 'Pages on the free list.', { group: 'Information' }),
  ro('schema_version', 'Schema version', 'Counts schema changes.', { group: 'Information' }),
  ro('data_version', 'Data version', 'Changes when another connection writes.', { group: 'Information' }),
]
const PRAGMA_BY_NAME = new Map(PRAGMAS.map((p) => [p.name, p]))
const CHECKS = new Set(['integrity_check', 'quick_check', 'foreign_key_check'])

const normOption = (o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : { value: o, label: o })
const FIRST_WORD = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*([A-Za-z]+)/
// Statements that must not be wrapped in the pending transaction.
const NO_TX = new Set(['select', 'explain', 'pragma', 'vacuum', 'attach', 'detach', 'begin', 'commit', 'end', 'rollback', 'savepoint', 'release', 'values'])

export class Engine {
  constructor() {
    this.db = null
    this.path = null
    this.readOnly = true
    this.pending = 0
  }

  // ----- session -----
  open({ path, readOnly = true, create = false } = {}) {
    if (typeof path !== 'string' || !path) throw new DbError('BAD_ARGS', 'A database path is required.')
    this.close()
    if (create) {
      try { statSync(path); throw new DbError('EXISTS', `${basename(path)} already exists.`) } catch (e) { if (e instanceof DbError) throw e }
      readOnly = false
    } else sniff(path)
    const db = new DatabaseSync(path, { readOnly: !!readOnly, timeout: 2000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false })
    try {
      db.enableDefensive(true)
      db.function('regexp', { deterministic: true }, (pattern, value) => {
        if (value === null || value === undefined || pattern === null) return null
        try { return new RegExp(String(pattern), 'u').test(String(value)) ? 1 : 0 } catch { return null }
      })
      if (readOnly) db.setAuthorizer((action) => (action === SQ.SQLITE_ATTACH ? SQ.SQLITE_DENY : SQ.SQLITE_OK))
      db.prepare('SELECT count(*) FROM sqlite_schema').get() // surfaces "file is not a database" now, not on first browse
    } catch (e) {
      try { db.close() } catch {}
      throw e
    }
    this.db = db
    this.path = path
    this.readOnly = !!readOnly
    this.pending = 0
    return this.status()
  }

  close() {
    if (this.db) {
      try { if (this.db.isTransaction) this.db.exec('ROLLBACK') } catch {}
      try { this.db.close() } catch {}
    }
    this.db = null
    this.path = null
    this.pending = 0
    return { open: false }
  }

  need() {
    if (!this.db) throw new DbError('NOT_OPEN', 'No database is open.')
    return this.db
  }

  needWrite() {
    this.need()
    if (this.readOnly) throw new DbError('READ_ONLY', 'The database is open read-only. Turn on Edit mode to change it.')
  }

  status() {
    if (!this.db) return { open: false }
    let size = 0
    try { size = statSync(this.path).size } catch {}
    return {
      open: true,
      path: this.path,
      name: basename(this.path),
      size,
      readOnly: this.readOnly,
      pending: this.pending,
      inTransaction: this.db.isTransaction,
      version: this.db.prepare('SELECT sqlite_version() v').get().v,
    }
  }

  setMode({ readOnly } = {}) {
    const path = this.path
    this.need()
    if (this.db.isTransaction && this.pending > 0) throw new DbError('PENDING', 'Write or revert the pending changes first.')
    return this.open({ path, readOnly: !!readOnly })
  }

  commit() {
    const db = this.need()
    if (db.isTransaction) db.exec('COMMIT')
    this.pending = 0
    return this.status()
  }

  revert() {
    const db = this.need()
    if (db.isTransaction) db.exec('ROLLBACK')
    this.pending = 0
    return this.status()
  }

  ensureTx() {
    const db = this.db
    if (!db.isTransaction) db.exec('BEGIN')
  }

  stmt(sql) {
    const s = this.need().prepare(sql)
    s.setReadBigInts(true)
    s.setReturnArrays(true)
    return s
  }

  // ----- schema -----
  objects() {
    return this.stmt(`SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name`).all()
      .map(([type, name, tbl, sql]) => ({ type, name, table: tbl, sql }))
  }

  /** The table or view `name` from sqlite_schema, or a NOT_FOUND error. This is what makes identifiers safe to quote. */
  object(name, types = ['table', 'view']) {
    if (typeof name !== 'string') throw new DbError('BAD_ARGS', 'A table name is required.')
    const row = this.stmt(`SELECT type, name, sql FROM sqlite_schema WHERE name = ?1 COLLATE NOCASE AND type IN (SELECT value FROM json_each(?2))`).get(name, JSON.stringify(types))
    if (!row) throw new DbError('NOT_FOUND', `No ${types.join(' or ')} named ${name}.`)
    return { type: row[0], name: row[1], sql: row[2] }
  }

  columns(name) {
    return this.stmt(`SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?1)`).all(name)
      .map(([cid, cname, type, notnull, dflt, pk, hidden]) => ({
        cid: Number(cid), name: cname, type: type || '', notnull: Number(notnull) === 1, dflt: dflt ?? null,
        pk: Number(pk), hidden: Number(hidden), generated: Number(hidden) >= 2,
      }))
  }

  tableFlags(name) {
    const r = this.stmt(`SELECT type, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?1`).get(name)
    return r ? { kind: String(r[0]), withoutRowid: Number(r[1]) === 1, strict: Number(r[2]) === 1 } : { kind: 'table', withoutRowid: false, strict: false }
  }

  schema() {
    const db = this.need()
    const objs = this.objects()
    const tooBig = (() => { try { return statSync(this.path).size > 512 * 1024 * 1024 } catch { return false } })()
    const tables = []
    const views = []
    const indexes = []
    const triggers = []
    for (const o of objs) {
      const internal = o.name.startsWith('sqlite_')
      if (o.type === 'table' || o.type === 'view') {
        const columns = this.columns(o.name).filter((c) => c.hidden !== 1)
        const base = { name: o.name, ident: quoteIdent(o.name), sql: o.sql, internal, columns }
        if (o.type === 'view') { views.push(base); continue }
        const flags = this.tableFlags(o.name)
        let rows = null
        if (!tooBig) { try { rows = Number(this.stmt(`SELECT count(*) FROM ${quoteIdent(o.name)}`).get()[0]) } catch { rows = null } }
        const fks = this.stmt(`SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?1) ORDER BY id, seq`).all(o.name)
          .map(([id, seq, t, from, to, upd, del]) => ({ id: Number(id), seq: Number(seq), table: t, from, to, onUpdate: upd, onDelete: del }))
        tables.push({ ...base, kind: flags.kind, withoutRowid: flags.withoutRowid, strict: flags.strict, autoincrement: /\bautoincrement\b/i.test(o.sql || ''), rows, foreignKeys: fks })
      } else if (o.type === 'index') {
        indexes.push({ name: o.name, table: o.table, sql: o.sql, internal: internal || o.sql === null })
      } else if (o.type === 'trigger') {
        triggers.push({ name: o.name, table: o.table, sql: o.sql })
      }
    }
    for (const t of tables) {
      t.indexes = this.stmt(`SELECT name, "unique", origin, partial FROM pragma_index_list(?1)`).all(t.name).map(([name, unique, origin, partial]) => ({
        name, unique: Number(unique) === 1, origin, partial: Number(partial) === 1,
        columns: this.stmt(`SELECT name FROM pragma_index_info(?1) ORDER BY seqno`).all(name).map((r) => r[0] ?? '<expression>'),
        sql: indexes.find((i) => i.name === name)?.sql ?? null,
      }))
      t.triggers = triggers.filter((tr) => tr.table === t.name).map((tr) => tr.name)
    }
    for (const ix of indexes) {
      const t = tables.find((x) => x.name === ix.table)
      const meta = t?.indexes.find((i) => i.name === ix.name)
      ix.unique = meta?.unique ?? false
      ix.partial = meta?.partial ?? false
      ix.columns = meta?.columns ?? []
    }
    return { version: db.prepare('SELECT sqlite_version() v').get().v, tables, views, indexes, triggers }
  }

  // ----- browse -----
  /** How rows of this object are addressed for edits. */
  keying(obj, cols) {
    if (obj.type !== 'table') return { mode: 'none' }
    const flags = this.tableFlags(obj.name)
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk)
    if (!flags.withoutRowid) {
      const taken = new Set(cols.map((c) => c.name.toLowerCase()))
      const alias = ['rowid', '_rowid_', 'oid'].find((a) => !taken.has(a))
      if (alias) return { mode: 'rowid', alias }
    }
    return pk.length ? { mode: 'pk', pk: pk.map((c) => c.name) } : { mode: 'none' }
  }

  where(cols, filters) {
    const parts = []
    const params = []
    for (const [name, text] of Object.entries(filters || {})) {
      const col = cols.find((c) => c.name === name)
      if (!col) throw new DbError('BAD_COLUMN', `No column named ${name}.`)
      const clause = filterClause(quoteIdent(col.name), text)
      if (clause) { parts.push(clause.sql); params.push(...clause.params) }
    }
    return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params }
  }

  /** ORDER BY terms from [{col, dir}], each column matched against the table's real columns. */
  orderClause(cols, sort) {
    return (Array.isArray(sort) ? sort : []).slice(0, 8).map((s) => {
      const col = cols.find((c) => c.name === s?.col)
      if (!col) throw new DbError('BAD_COLUMN', `No column named ${s?.col}.`)
      return `${quoteIdent(col.name)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`
    })
  }

  browse({ table, offset = 0, limit = DEFAULT_PAGE, filters = {}, sort = [] } = {}) {
    const obj = this.object(table)
    const all = this.columns(obj.name)
    const cols = all.filter((c) => c.hidden !== 1)
    const key = this.keying(obj, all)
    const q = quoteIdent(obj.name)
    const { sql: where, params } = this.where(cols, filters)
    const order = this.orderClause(cols, sort)
    if (order.length && key.mode === 'rowid') order.push(key.alias)
    const lim = Math.max(1, Math.min(MAX_ROWS, Math.floor(Number(limit)) || DEFAULT_PAGE))
    const off = Math.max(0, Math.floor(Number(offset)) || 0)
    const select = []
    if (key.mode === 'rowid') select.push(key.alias)
    select.push(...cols.map((c) => quoteIdent(c.name)))
    if (key.mode === 'pk') select.push(...key.pk.map((n) => quoteIdent(n)))
    const sql = `SELECT ${select.join(', ')} FROM ${q}${where}${order.length ? ' ORDER BY ' + order.join(', ') : ''} LIMIT ? OFFSET ?`
    const total = Number(this.stmt(`SELECT count(*) FROM ${q}${where}`).get(...params)[0])
    const rows = this.stmt(sql).all(...params, BigInt(lim), BigInt(off))
    const skip = key.mode === 'rowid' ? 1 : 0
    const out = []
    const keys = []
    for (const r of rows) {
      out.push(cols.map((_, i) => encodeValue(r[i + skip])))
      if (key.mode === 'rowid') keys.push(encodeValue(r[0], { full: true }))
      else if (key.mode === 'pk') keys.push(key.pk.map((_, i) => encodeValue(r[skip + cols.length + i], { full: true })))
    }
    return {
      table: obj.name, type: obj.type, columns: cols, keyMode: key.mode, keyColumns: key.pk ?? null,
      editable: key.mode !== 'none', total, offset: off, limit: lim, rows: out, keys,
    }
  }

  keyWhere(obj, key) {
    const k = this.keying(obj, this.columns(obj.name))
    if (k.mode === 'rowid') return { sql: `${k.alias} = ?`, params: [decodeValue(key)] }
    if (k.mode === 'pk') {
      if (!Array.isArray(key) || key.length !== k.pk.length) throw new DbError('BAD_KEY', 'The row key does not match the primary key.')
      return { sql: k.pk.map((n) => `${quoteIdent(n)} IS ?`).join(' AND '), params: key.map(decodeValue) }
    }
    throw new DbError('NO_KEY', `${obj.name} has no rowid or primary key, so its rows cannot be edited.`)
  }

  editableColumn(obj, name) {
    const col = this.columns(obj.name).find((c) => c.name === name)
    if (!col) throw new DbError('BAD_COLUMN', `No column named ${name}.`)
    if (col.generated) throw new DbError('GENERATED', `${name} is a generated column.`)
    return col
  }

  /** The full value of one cell (text up to 2 MiB, BLOB preview of 256 bytes). */
  cell({ table, key, column }) {
    const obj = this.object(table, ['table', 'view'])
    const col = this.columns(obj.name).find((c) => c.name === column)
    if (!col) throw new DbError('BAD_COLUMN', `No column named ${column}.`)
    const w = this.keyWhere(obj, key)
    const r = this.stmt(`SELECT ${quoteIdent(col.name)} FROM ${quoteIdent(obj.name)} WHERE ${w.sql}`).get(...w.params)
    if (!r) throw new DbError('ROW_NOT_FOUND', 'That row no longer exists.')
    return encodeValue(r[0], { textLimit: 2 * 1024 * 1024, blobPreview: 256 })
  }

  update({ table, key, column, value }) {
    this.needWrite()
    const obj = this.object(table, ['table'])
    const col = this.editableColumn(obj, column)
    const w = this.keyWhere(obj, key)
    this.ensureTx()
    const info = this.stmt(`UPDATE ${quoteIdent(obj.name)} SET ${quoteIdent(col.name)} = ? WHERE ${w.sql}`).run(decodeValue(value), ...w.params)
    if (Number(info.changes) !== 1) throw new DbError('ROW_NOT_FOUND', 'That row no longer exists.')
    this.pending++
    const r = this.stmt(`SELECT ${quoteIdent(col.name)} FROM ${quoteIdent(obj.name)} WHERE ${w.sql}`).get(...w.params)
    return { cell: encodeValue(r ? r[0] : null), ...this.brief() }
  }

  insert({ table, values } = {}) {
    this.needWrite()
    const obj = this.object(table, ['table'])
    const entries = Object.entries(values || {})
    this.ensureTx()
    let info
    if (entries.length === 0) info = this.stmt(`INSERT INTO ${quoteIdent(obj.name)} DEFAULT VALUES`).run()
    else {
      const cols = entries.map(([name]) => quoteIdent(this.editableColumn(obj, name).name))
      info = this.stmt(`INSERT INTO ${quoteIdent(obj.name)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...entries.map(([, v]) => decodeValue(v)))
    }
    this.pending++
    return { rowid: encodeValue(info.lastInsertRowid), ...this.brief() }
  }

  deleteRows({ table, keys } = {}) {
    this.needWrite()
    const obj = this.object(table, ['table'])
    if (!Array.isArray(keys) || keys.length === 0) throw new DbError('BAD_ARGS', 'No rows to delete.')
    if (keys.length > MAX_ROWS) throw new DbError('BAD_ARGS', `Delete at most ${MAX_ROWS} rows at a time.`)
    this.ensureTx()
    let changes = 0
    for (const key of keys) {
      const w = this.keyWhere(obj, key)
      changes += Number(this.stmt(`DELETE FROM ${quoteIdent(obj.name)} WHERE ${w.sql}`).run(...w.params).changes)
    }
    this.pending++
    return { changes, ...this.brief() }
  }

  brief() {
    return { pending: this.pending, inTransaction: this.db.isTransaction }
  }

  // ----- execute -----
  execute({ sql, maxRows = MAX_ROWS } = {}) {
    const db = this.need()
    if (typeof sql !== 'string' || !sql.trim()) throw new DbError('BAD_ARGS', 'There is no SQL to run.')
    const cap = Math.max(1, Math.min(MAX_ROWS, Math.floor(Number(maxRows)) || MAX_ROWS))
    const statements = splitStatements(sql)
    if (statements.length === 0) throw new DbError('BAD_ARGS', 'There is no SQL to run.')
    const t0 = performance.now()
    const res = { statements: 0, total: statements.length, columns: null, rows: null, rowCount: 0, truncated: false, changes: null, lastInsertRowid: null, ms: 0, lastMs: 0, error: null }
    let writeScope = false
    const pendingBefore = this.pending
    // In edit mode a whole run is one savepoint: an error undoes the run, earlier pending edits stay.
    const guarded = !this.readOnly && statements.some((s) => !NO_TX.has((FIRST_WORD.exec(s.text)?.[1] ?? '').toLowerCase()))
    if (guarded) {
      this.ensureTx()
      db.exec('SAVEPOINT pager_run')
      writeScope = true
    }
    try {
      for (const st of statements) {
        const word = (FIRST_WORD.exec(st.text)?.[1] ?? '').toLowerCase()
        const s0 = performance.now()
        if (!this.readOnly) {
          const rest = st.text.replace(/;\s*$/, '')
          if (/^(commit|end)\b/i.test(rest)) { if (writeScope) { db.exec('RELEASE pager_run'); writeScope = false } this.commit(); res.statements++; res.columns = null; res.rows = null; res.changes = 0; res.lastMs = performance.now() - s0; continue }
          if (/^rollback\b(?!\s+(transaction\s+)?to\b)/i.test(rest)) { if (writeScope) { db.exec('RELEASE pager_run'); writeScope = false } this.revert(); res.statements++; res.columns = null; res.rows = null; res.changes = 0; res.lastMs = performance.now() - s0; continue }
          if (/^begin\b/i.test(rest)) { res.statements++; res.columns = null; res.rows = null; res.changes = 0; res.lastMs = performance.now() - s0; continue }
        }
        if (!this.readOnly && writeScope === false && !NO_TX.has(word) && !db.isTransaction) this.ensureTx()
        try {
          const stmt = this.stmt(st.text)
          const cols = stmt.columns()
          if (cols.length) {
            const names = cols.map((c) => c.name)
            const rows = []
            let truncated = false
            for (const r of stmt.iterate()) {
              if (rows.length >= cap) { truncated = true; break }
              rows.push(r.map((v) => encodeValue(v)))
            }
            res.columns = names; res.rows = rows; res.rowCount = rows.length; res.truncated = truncated; res.changes = null; res.query = st.text
          } else {
            const info = stmt.run()
            res.columns = null; res.rows = null; res.rowCount = 0; res.truncated = false
            res.changes = Number(info.changes)
            res.lastInsertRowid = info.lastInsertRowid ? encodeValue(info.lastInsertRowid) : null
            if (!this.readOnly && !NO_TX.has(word)) this.pending++
          }
          res.statements++
          res.lastMs = performance.now() - s0
        } catch (e) {
          res.error = { message: e.message, code: e.code, errcode: e.errcode, statement: res.statements + 1, line: st.line, sql: st.text.length > 300 ? st.text.slice(0, 300) + '…' : st.text }
          throw res.error
        }
      }
      if (writeScope) { db.exec('RELEASE pager_run'); writeScope = false }
    } catch (e) {
      if (writeScope) { try { db.exec('ROLLBACK TO pager_run'); db.exec('RELEASE pager_run') } catch {} this.pending = pendingBefore }
      if (e !== res.error) throw e
    }
    res.ms = performance.now() - t0
    return { ...res, ...this.brief() }
  }

  // ----- pragmas -----
  pragmaValue(def) {
    const r = this.stmt(`PRAGMA ${def.name}`).get()
    const v = r ? r[0] : null
    return v === null ? null : typeof v === 'bigint' ? Number(v) : v
  }

  pragmas() {
    this.need()
    const list = PRAGMAS.map((def) => {
      let value = null
      let error = null
      try { value = this.pragmaValue(def) } catch (e) { error = e.message }
      const out = { name: def.name, group: def.group, label: def.label, desc: def.desc, kind: def.kind, persistent: !def.connection && def.kind !== 'readonly', needsWrite: !!def.write, value, error }
      if (def.kind === 'enum') {
        out.options = def.options.map(normOption)
        out.value = out.options.find((o) => o.value === String(value).toLowerCase())?.value ?? String(value)
      }
      if (def.kind === 'bool') out.value = Number(value) ? 1 : 0
      if (def.kind === 'int') { out.min = def.min; out.max = def.max }
      return out
    })
    return { pragmas: list, ...this.brief(), readOnly: this.readOnly }
  }

  setPragma({ name, value } = {}) {
    const def = PRAGMA_BY_NAME.get(name)
    if (!def || def.kind === 'readonly') throw new DbError('BAD_PRAGMA', `${name} cannot be set here.`)
    this.need()
    if (def.write) this.needWrite()
    if (def.noTx && this.db.isTransaction) throw new DbError('PENDING', `Write or revert the pending changes before changing ${name}.`)
    let token
    if (def.kind === 'bool') token = value === true || value === 1 || value === '1' || value === 'on' ? '1' : '0'
    else if (def.kind === 'int') {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (!Number.isSafeInteger(n) || n < def.min || n > def.max) throw new DbError('BAD_VALUE', `${def.label} must be a whole number from ${def.min} to ${def.max}.`)
      token = String(n)
    } else {
      const opt = def.options.map(normOption).find((o) => o.value === String(value).toLowerCase())
      if (!opt) throw new DbError('BAD_VALUE', `${String(value)} is not an option for ${def.label}.`)
      token = opt.value
    }
    this.stmt(`PRAGMA ${def.name} = ${token}`).all()
    const now = this.pragmas().pragmas.find((p) => p.name === name)
    return { ...now, applied: String(now.value).toLowerCase() === token.toLowerCase(), ...this.brief() }
  }

  check({ kind } = {}) {
    if (!CHECKS.has(kind)) throw new DbError('BAD_ARGS', `Unknown check ${kind}.`)
    this.need()
    const rows = this.stmt(`PRAGMA ${kind}`).all().slice(0, 1000)
    const lines = rows.map((r) => r.map((v) => (v === null ? 'NULL' : String(v))).join(' | '))
    const ok = kind === 'foreign_key_check' ? lines.length === 0 : lines.length === 1 && lines[0] === 'ok'
    return { kind, ok, lines: ok && kind === 'foreign_key_check' ? ['No foreign key violations.'] : lines }
  }

  // ----- export (CSV / JSON written straight from SQLite, so cells are never truncated) -----
  /** Export the one row-returning statement in `query`. It is prepared under a read-only authorizer, so it cannot write even in edit mode. */
  exportQuery({ query, path, format } = {}) {
    this.need()
    const list = typeof query === 'string' ? splitStatements(query) : []
    if (list.length !== 1) throw new DbError('BAD_ARGS', 'Save results needs exactly one statement.')
    const word = (FIRST_WORD.exec(list[0].text)?.[1] ?? '').toLowerCase()
    if (!EXPORT_OK.has(word)) throw new DbError('NOT_SELECT', 'Only a statement that returns rows can be saved.')
    return this.exportStatement(list[0].text, [], path, format)
  }

  /** Export a table or view as browsed: same filters and sort as browse(), no paging. */
  exportTable({ table, filters = {}, sort = [], path, format } = {}) {
    const obj = this.object(table)
    const cols = this.columns(obj.name).filter((c) => c.hidden !== 1)
    const { sql: where, params } = this.where(cols, filters)
    const order = this.orderClause(cols, sort)
    const sql = `SELECT ${cols.map((c) => quoteIdent(c.name)).join(', ')} FROM ${quoteIdent(obj.name)}${where}${order.length ? ' ORDER BY ' + order.join(', ') : ''}`
    return this.exportStatement(sql, params, path, format)
  }

  exportStatement(sql, params, path, format) {
    const db = this.need()
    if (format !== 'csv' && format !== 'json') throw new DbError('BAD_ARGS', `Unknown export format ${format}.`)
    if (typeof path !== 'string' || !path) throw new DbError('BAD_ARGS', 'A file path is required.')
    if (resolve(path) === resolve(this.path)) throw new DbError('BAD_ARGS', 'Cannot save results over the open database.')
    const lock = (action, a1, a2) => {
      if (action === SQ.SQLITE_SELECT || action === SQ.SQLITE_READ || action === SQ.SQLITE_FUNCTION || action === SQ.SQLITE_RECURSIVE) return SQ.SQLITE_OK
      if (action === SQ.SQLITE_PRAGMA && (a2 === null || a2 === undefined)) return SQ.SQLITE_OK
      return SQ.SQLITE_DENY
    }
    let stmt
    db.setAuthorizer(lock)
    try { stmt = this.stmt(sql) } finally {
      db.setAuthorizer(this.readOnly ? (action) => (action === SQ.SQLITE_ATTACH ? SQ.SQLITE_DENY : SQ.SQLITE_OK) : null)
    }
    const cols = stmt.columns().map((c) => c.name)
    if (!cols.length) throw new DbError('NOT_SELECT', 'That statement returns no rows.')
    const names = uniqueNames(cols)
    let out = ''
    let bytes = 0
    const fd = openSync(path, 'w')
    const flush = () => { if (out) { bytes += writeSync(fd, out); out = '' } }
    let rows = 0
    try {
      if (format === 'csv') out += names.map(csvField).join(',') + '\r\n'
      else out += '[\n'
      for (const r of stmt.iterate(...params)) {
        if (format === 'csv') out += r.map((v) => csvField(exportText(v))).join(',') + '\r\n'
        else out += (rows ? ',\n' : '') + '  {' + r.map((v, i) => JSON.stringify(names[i]) + ':' + exportJson(v)).join(',') + '}'
        rows++
        if (out.length > 65536) flush()
      }
      if (format === 'json') out += rows ? '\n]\n' : ']\n'
      flush()
    } finally { closeSync(fd) }
    return { path, format, rows, bytes }
  }
}

/** Methods the worker exposes (everything else on Engine is internal). */
export const METHODS = new Set(['open', 'close', 'status', 'setMode', 'commit', 'revert', 'schema', 'browse', 'cell', 'update', 'insert', 'deleteRows', 'execute', 'pragmas', 'setPragma', 'check', 'exportQuery', 'exportTable'])
