// node --test desktop/electron/blocks/database.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Engine, csvField, filterClause, quoteIdent, splitStatements } from './database-engine.mjs'

const require = createRequire(import.meta.url)
const dir = mkdtempSync(join(tmpdir(), 'pager-db-test-'))
test.after(async () => {
  await new Promise((r) => setTimeout(r, 300)) // let killed workers release their file handles on Windows
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const EVIL = 'x"; DROP TABLE people;--'
let n = 0
function makeDb() {
  const file = join(dir, `t${++n}.db`)
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, note TEXT, pic BLOB);
    CREATE TABLE ${quoteIdent(EVIL)} (a, "b""c");
    CREATE TABLE pairs (a TEXT, b TEXT, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
    CREATE VIEW adults AS SELECT * FROM people WHERE age >= 18;
    INSERT INTO ${quoteIdent(EVIL)} VALUES (1, 2);
    INSERT INTO pairs VALUES ('k', '1', 'one'), ('k', '2', 'two');
  `)
  const ins = db.prepare('INSERT INTO people (name, age, note, pic) VALUES (?, ?, ?, ?)')
  for (let i = 1; i <= 12; i++) ins.run(`Person ${i}`, i * 5, i % 3 === 0 ? null : `note, with "quotes" ${i}`, i === 1 ? new Uint8Array([1, 2, 3, 255]) : null)
  db.close()
  return file
}

test('quoteIdent doubles quotes and rejects junk', () => {
  assert.equal(quoteIdent('plain'), '"plain"')
  assert.equal(quoteIdent('a"b'), '"a""b"')
  assert.equal(quoteIdent(EVIL), '"x""; DROP TABLE people;--"')
  assert.throws(() => quoteIdent(''), { code: 'BAD_IDENT' })
  assert.throws(() => quoteIdent('a\0b'), { code: 'BAD_IDENT' })
  assert.throws(() => quoteIdent(5), { code: 'BAD_IDENT' })
})

test('filters bind their values and never splice them', () => {
  assert.deepEqual(filterClause('"c"', "x' OR 1=1 --"), { sql: `CAST("c" AS TEXT) LIKE ? ESCAPE '\\'`, params: ["%x' OR 1=1 --%"] })
  assert.deepEqual(filterClause('"c"', '100%'), { sql: `CAST("c" AS TEXT) LIKE ? ESCAPE '\\'`, params: ['%100\\%%'] })
  assert.deepEqual(filterClause('"c"', '>=5'), { sql: '"c" >= ?', params: [5n] })
  assert.deepEqual(filterClause('"c"', 'NULL'), { sql: '"c" IS NULL', params: [] })
  assert.equal(filterClause('"c"', '   '), null)
  assert.equal(filterClause('"c"', '>'), null)
})

test('splitStatements keeps strings, comments and trigger bodies whole', () => {
  const s = splitStatements("SELECT ';'; -- x;\nCREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; SELECT CASE WHEN 1 THEN 2 END; END; SELECT 3")
  assert.equal(s.length, 3)
  assert.match(s[1].text, /CREATE TRIGGER[\s\S]*END$/)
})

test('browse pages: 1 - 8 of 12, then the last 4', () => {
  const e = new Engine()
  e.open({ path: makeDb() })
  const a = e.browse({ table: 'people', offset: 0, limit: 8 })
  assert.equal(a.total, 12)
  assert.equal(a.rows.length, 8)
  assert.equal(a.keyMode, 'rowid')
  assert.equal(a.editable, true)
  const b = e.browse({ table: 'people', offset: 8, limit: 8 })
  assert.equal(b.rows.length, 4)
  assert.equal(b.rows[0][1], 'Person 9')
  const f = e.browse({ table: 'people', filters: { name: 'Person 1' } })
  assert.equal(f.total, 4) // Person 1, 10, 11, 12
  const sorted = e.browse({ table: 'people', sort: [{ col: 'age', dir: 'desc' }], limit: 2 })
  assert.deepEqual(sorted.rows.map((r) => r[2]), [60, 55])
  assert.deepEqual(e.browse({ table: 'people', limit: 1 }).rows[0][4], { t: 'blob', n: 4, hex: '010203ff' })
  e.close()
})

test('hostile identifiers and filter text are inert', () => {
  const e = new Engine()
  const file = makeDb()
  e.open({ path: file })
  const r = e.browse({ table: EVIL, filters: { 'b"c': "' OR 1=1 --" } })
  assert.equal(r.total, 0)
  assert.equal(e.browse({ table: EVIL }).total, 1)
  assert.throws(() => e.browse({ table: 'people"; DROP TABLE people;--' }), { code: 'NOT_FOUND' })
  assert.throws(() => e.browse({ table: 'people', filters: { 'name" OR 1=1 --': 'x' } }), { code: 'BAD_COLUMN' })
  assert.throws(() => e.browse({ table: 'people', sort: [{ col: 'name; DROP TABLE people', dir: 'asc' }] }), { code: 'BAD_COLUMN' })
  assert.equal(e.browse({ table: 'people' }).total, 12)
  e.close()
})

test('read-only is the default and is enforced', () => {
  const e = new Engine()
  const file = makeDb()
  const st = e.open({ path: file })
  assert.equal(st.readOnly, true)
  assert.throws(() => e.update({ table: 'people', key: 1, column: 'name', value: 'X' }), { code: 'READ_ONLY' })
  assert.throws(() => e.insert({ table: 'people', values: { name: 'X' } }), { code: 'READ_ONLY' })
  assert.throws(() => e.deleteRows({ table: 'people', keys: [1] }), { code: 'READ_ONLY' })
  assert.throws(() => e.setPragma({ name: 'user_version', value: 3 }), { code: 'READ_ONLY' })
  const w = e.execute({ sql: "INSERT INTO people (name) VALUES ('Z')" })
  assert.match(w.error.message, /readonly/i)
  const a = e.execute({ sql: `ATTACH '${join(dir, 'other.db').replaceAll("'", "''")}' AS o` })
  assert.ok(a.error, 'ATTACH is denied')
  assert.equal(e.browse({ table: 'people' }).total, 12)
  e.close()
  // a fresh connection must see the file unchanged
  const raw = new DatabaseSync(file, { readOnly: true })
  assert.equal(raw.prepare('SELECT count(*) c FROM people').get().c, 12)
  raw.close()
})

test('edit round trip: update, revert, update, write, reopen', () => {
  const e = new Engine()
  const file = makeDb()
  e.open({ path: file })
  assert.equal(e.setMode({ readOnly: false }).readOnly, false)
  const first = e.browse({ table: 'people', limit: 1 })
  const key = first.keys[0]
  const u = e.update({ table: 'people', key, column: 'name', value: 'Renamed' })
  assert.equal(u.cell, 'Renamed')
  assert.equal(u.pending, 1)
  assert.throws(() => e.setMode({ readOnly: true }), { code: 'PENDING' })
  assert.equal(e.revert().pending, 0)
  assert.equal(e.browse({ table: 'people', limit: 1 }).rows[0][1], 'Person 1')
  e.update({ table: 'people', key, column: 'name', value: 'Kept' })
  e.update({ table: 'people', key, column: 'age', value: null })
  const ins = e.insert({ table: 'people', values: { name: 'New one', age: 7 } })
  assert.equal(ins.rowid, 13)
  assert.equal(e.deleteRows({ table: 'people', keys: [2] }).changes, 1)
  assert.equal(e.commit().pending, 0)
  e.close()
  e.open({ path: file })
  const r = e.browse({ table: 'people', limit: 100 })
  assert.equal(r.total, 12)
  assert.equal(r.rows[0][1], 'Kept')
  assert.equal(r.rows[0][2], null)
  assert.ok(r.rows.some((row) => row[1] === 'New one'))
  assert.ok(!r.rows.some((row) => row[1] === 'Person 2'))
  e.close()
})

test('composite primary keys and a bad statement inside a run', () => {
  const e = new Engine()
  e.open({ path: makeDb(), readOnly: false })
  const b = e.browse({ table: 'pairs' })
  assert.equal(b.keyMode, 'pk')
  e.update({ table: 'pairs', key: b.keys[1], column: 'v', value: 'TWO' })
  assert.equal(e.browse({ table: 'pairs' }).rows[1][2], 'TWO')
  const pendingBefore = e.status().pending
  const run = e.execute({ sql: "UPDATE people SET name = 'gone'; SELECT nope FROM nowhere" })
  assert.ok(run.error)
  assert.equal(run.error.statement, 2)
  assert.equal(e.pending, pendingBefore) // the whole run was undone
  assert.equal(e.browse({ table: 'people', limit: 1 }).rows[0][1], 'Person 1')
  assert.equal(e.browse({ table: 'pairs' }).rows[1][2], 'TWO') // earlier pending edit survives
  e.close()
})

test('execute reports columns, rows and timing', () => {
  const e = new Engine()
  e.open({ path: makeDb() })
  const r = e.execute({ sql: 'SELECT name, age FROM people ORDER BY age LIMIT 3' })
  assert.deepEqual(r.columns, ['name', 'age'])
  assert.equal(r.rowCount, 3)
  assert.equal(typeof r.ms, 'number')
  assert.equal(r.query, 'SELECT name, age FROM people ORDER BY age LIMIT 3')
  e.close()
})

test('save results: CSV quoting and JSON, written from SQLite', () => {
  const e = new Engine()
  e.open({ path: makeDb() })
  const csv = join(dir, 'out.csv')
  const r = e.exportQuery({ query: "SELECT id, note, pic FROM people WHERE id IN (1, 3, 4) ORDER BY id", path: csv, format: 'csv' })
  assert.equal(r.rows, 3)
  assert.equal(readFileSync(csv, 'utf8'), 'id,note,pic\r\n1,"note, with ""quotes"" 1",X\'010203ff\'\r\n3,,\r\n4,"note, with ""quotes"" 4",\r\n')
  const json = join(dir, 'out.json')
  e.exportTable({ table: 'people', filters: { id: '<=2' }, sort: [{ col: 'id', dir: 'desc' }], path: json, format: 'json' })
  const parsed = JSON.parse(readFileSync(json, 'utf8'))
  assert.deepEqual(parsed.map((x) => x.id), [2, 1])
  assert.equal(parsed[1].pic, "X'010203ff'")
  assert.equal(csvField('a\nb'), '"a\nb"')
  assert.throws(() => e.exportQuery({ query: "DELETE FROM people", path: join(dir, 'x.csv'), format: 'csv' }), { code: 'NOT_SELECT' })
  assert.throws(() => e.exportQuery({ query: 'SELECT 1; SELECT 2', path: join(dir, 'x.csv'), format: 'csv' }), { code: 'BAD_ARGS' })
  e.close()
})

test('save results cannot write, even in edit mode', () => {
  const e = new Engine()
  const file = makeDb()
  e.open({ path: file, readOnly: false })
  assert.throws(() => e.exportQuery({ query: "WITH x AS (DELETE FROM people RETURNING id) SELECT id FROM x", path: join(dir, 'w.csv'), format: 'csv' }))
  assert.throws(() => e.exportQuery({ query: 'SELECT 1', path: file, format: 'csv' }), { code: 'BAD_ARGS' })
  assert.equal(e.browse({ table: 'people' }).total, 12)
  e.close()
})

test('pragmas: only allow-listed names reach SQL', () => {
  const e = new Engine()
  e.open({ path: makeDb(), readOnly: false })
  assert.throws(() => e.setPragma({ name: 'journal_mode; DROP TABLE people', value: 'wal' }), { code: 'BAD_PRAGMA' })
  assert.throws(() => e.setPragma({ name: 'user_version', value: '1; DROP TABLE people' }), { code: 'BAD_VALUE' })
  assert.throws(() => e.setPragma({ name: 'synchronous', value: 'x' }), { code: 'BAD_VALUE' })
  const p = e.setPragma({ name: 'user_version', value: 42 })
  assert.equal(p.value, 42)
  assert.equal(e.check({ kind: 'integrity_check' }).ok, true)
  assert.throws(() => e.check({ kind: 'integrity_check; DROP TABLE people' }), { code: 'BAD_ARGS' })
  e.close()
})

test('worker process: open, browse, edit, and Stop kills a runaway query', async () => {
  const mod = require('./database.cjs')
  const emitted = []
  const ctx = { node: process.execPath, emit: (ev, p) => emitted.push([ev, p]) }
  const sid = 'test-session'
  const m = mod.methods
  const file = makeDb()
  try {
    const st = await m.open({ sid, path: file }, ctx)
    assert.equal(st.readOnly, true)
    const schema = await m.schema({ sid }, ctx)
    assert.ok(schema.tables.some((t) => t.name === 'people' && t.rows === 12))
    const page = await m.browse({ sid, table: 'people', offset: 8, limit: 8 }, ctx)
    assert.equal(page.rows.length, 4)
    await assert.rejects(m.update({ sid, table: 'people', key: 1, column: 'name', value: 'x' }, ctx), /read-only/i)
    await m.setMode({ sid, readOnly: false }, ctx)
    await m.update({ sid, table: 'people', key: 1, column: 'name', value: 'Worker' }, ctx)
    assert.equal((await m.commit({ sid }, ctx)).pending, 0)
    const slow = m.execute({ sid, sql: 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r' }, ctx)
    setTimeout(() => m.interrupt({ sid }), 300)
    await assert.rejects(slow, { code: 'INTERRUPTED' })
    await assert.rejects(m.status({ sid }, ctx), { code: 'NOT_OPEN' })
    await m.open({ sid, path: file }, ctx)
    assert.equal((await m.browse({ sid, table: 'people', limit: 1 }, ctx)).rows[0][1], 'Worker')
    const scan = await m.scan({ dir })
    assert.ok(scan.files.some((f) => f.path === file))
  } finally {
    await mod.dispose()
  }
})

// ---------- renderer helpers ----------
const util = await import('../../renderer/blocks/database-util.js')

test('tokenizer round-trips and classifies', () => {
  const sql = "SELECT count(*), 'it''s' AS \"a b\" -- c\nFROM t /* x */ WHERE n >= 0x1F AND x = :p"
  const toks = util.tokenizeSql(sql)
  assert.equal(toks.map((t) => t.s).join(''), sql)
  const kinds = Object.fromEntries(toks.filter((t) => t.t !== 'ws' && t.t !== 'op').map((t) => [t.s, t.t]))
  assert.equal(kinds.SELECT, 'kw')
  assert.equal(kinds.count, 'fn')
  assert.equal(kinds["'it''s'"], 'str')
  assert.equal(kinds['"a b"'], 'id')
  assert.equal(kinds['-- c'], 'com')
  assert.equal(kinds['0x1F'], 'num')
  assert.equal(kinds[':p'], 'param')
  assert.equal(util.tokenizeSql("'unterminated").map((t) => t.s).join(''), "'unterminated")
})

test('paging math and labels', () => {
  assert.equal(util.pageLabel(0, 8, 12), '1 – 8 of 12')
  assert.equal(util.pageLabel(8, 4, 12), '9 – 12 of 12')
  assert.equal(util.pageLabel(0, 0, 0), '0 of 0')
  assert.deepEqual(util.pageOffsets(0, 8, 12), { first: 0, prev: 0, next: 8, last: 8, hasPrev: false, hasNext: true })
  assert.deepEqual(util.pageOffsets(8, 8, 12), { first: 0, prev: 0, next: 8, last: 8, hasPrev: true, hasNext: false })
  assert.equal(util.offsetForRow(10, 8, 12), 8)
  assert.equal(util.offsetForRow(999, 8, 12), 8)
  assert.equal(util.offsetForRow('x', 8, 12), 0)
})

test('sort cycles asc, desc, off; additive keeps others', () => {
  let s = util.nextSort([], 'a', false)
  assert.deepEqual(s, [{ col: 'a', dir: 'asc' }])
  s = util.nextSort(s, 'a', false)
  assert.deepEqual(s, [{ col: 'a', dir: 'desc' }])
  assert.deepEqual(util.nextSort(s, 'a', false), [])
  assert.deepEqual(util.nextSort(s, 'b', true), [{ col: 'a', dir: 'desc' }, { col: 'b', dir: 'asc' }])
})

test('cell input follows column affinity', () => {
  assert.equal(util.parseCellInput('007', 'TEXT'), '007')
  assert.equal(util.parseCellInput('42', 'INTEGER'), 42)
  assert.deepEqual(util.parseCellInput('9223372036854775807', 'INTEGER'), { t: 'int', v: '9223372036854775807' })
  assert.deepEqual(util.parseCellInput('1.5', ''), { t: 'real', v: '1.5' })
  assert.equal(util.parseCellInput('hello', 'INTEGER'), 'hello')
  assert.equal(util.affinityOf('VARCHAR(20)'), 'text')
  assert.equal(util.affinityOf('BIGINT'), 'integer')
  assert.equal(util.affinityOf('DECIMAL(10,2)'), 'numeric')
  assert.equal(util.editText({ t: 'blob', n: 4, hex: '00' }), null)
  assert.equal(util.editText({ t: 'text', v: 'abc', n: 99 }), null)
  assert.equal(util.editText(null), '')
})
