'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const files = require('./files.cjs')
const t = files._t

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-files-test-'))
test.after(() => { files.dispose(); fs.rmSync(tmp, { recursive: true, force: true }) })

test('isWithin: containment is lexical and rejects siblings sharing a prefix', () => {
  const root = path.join(tmp, 'proj')
  assert.equal(t.isWithin(root, root), true)
  assert.equal(t.isWithin(root, path.join(root, 'a', 'b.txt')), true)
  assert.equal(t.isWithin(root, path.join(root, '..', 'proj2', 'x')), false)
  assert.equal(t.isWithin(root, path.join(root, 'a', '..', '..', 'etc')), false)
  assert.equal(t.isWithin(root, path.join(root, '..foo')), true)
  assert.equal(t.isWithin(root, path.dirname(root)), false)
})

test('resolveAllowed: only granted roots, relative paths anchored to the root, no NUL', () => {
  const root = path.join(tmp, 'granted')
  const other = path.join(tmp, 'other')
  const list = [root]
  assert.equal(t.resolveAllowed('src/a.ts', root, list), path.join(root, 'src', 'a.ts'))
  assert.equal(t.resolveAllowed(path.join(root, 'x'), root, list), path.join(root, 'x'))
  assert.throws(() => t.resolveAllowed('../other/secret', root, list), /Outside/)
  assert.throws(() => t.resolveAllowed(path.join(other, 'secret'), root, list), /Outside/)
  assert.throws(() => t.resolveAllowed('a\0b', root, list), /Invalid/)
  assert.throws(() => t.resolveAllowed('', root, list), /Invalid/)
})

test('grantRoot merges nested grants', () => {
  t.grants.length = 0
  const a = path.join(tmp, 'g1')
  t.grantRoot(path.join(a, 'deep'))
  t.grantRoot(a)
  assert.deepEqual(t.grants, [a])
  t.grantRoot(path.join(a, 'deep2'))
  assert.deepEqual(t.grants, [a])
})

test('parseHunks reads counts, defaulting an omitted count to 1', () => {
  const diff = ['@@ -2 +2 @@ a', '-b', '+B', '@@ -3,0 +4 @@ c', '+d', '@@ -10,3 +11,0 @@', '-x', '-y', '-z', '@@ -20,2 +21,4 @@', ''].join('\n')
  assert.deepEqual(t.parseHunks(diff), [
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
    { oldStart: 3, oldCount: 0, newStart: 4, newCount: 1 },
    { oldStart: 10, oldCount: 3, newStart: 11, newCount: 0 },
    { oldStart: 20, oldCount: 2, newStart: 21, newCount: 4 },
  ])
})

test('hunksToMarks: added, modified and removed', () => {
  const marks = t.hunksToMarks(t.parseHunks('@@ -3,0 +4,2 @@\n@@ -5 +7,3 @@\n@@ -9,2 +12,0 @@\n@@ -1 +0,0 @@\n'))
  assert.deepEqual(marks, [
    { kind: 'added', start: 4, end: 5 },
    { kind: 'modified', start: 7, end: 9 },
    { kind: 'removed', line: 12 },
    { kind: 'removed', line: 0 },
  ])
})

test('parseStatusV2: branch, ahead/behind, changed, renamed and untracked entries', () => {
  const out = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +5 -2',
    '1 .M N... 100644 100644 100644 aaa bbb src/a b.ts', '1 A. N... 000000 100644 100644 000 bbb new.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 moved.ts', 'orig.ts', 'u UU N... 1 2 3 4 aaa bbb ccc conflict.ts', '? notes/', ''].join('\0')
  const s = t.parseStatusV2(out)
  assert.equal(s.branch, 'main')
  assert.equal(s.ahead, 5)
  assert.equal(s.behind, 2)
  assert.deepEqual(s.entries.map((e) => e.path), ['src/a b.ts', 'new.ts', 'moved.ts', 'conflict.ts', 'notes/'])
  assert.deepEqual(s.entries.map((e) => t.statusLetter(e.xy)), ['M', 'A', 'R', 'U', '?'])
})

test('fuzzyScore: subsequence only, basename and word starts rank higher', () => {
  assert.equal(t.fuzzyScore('zzz', 'src/app.ts'), null)
  const a = t.fuzzyScore('app', 'src/app.ts')
  const b = t.fuzzyScore('app', 'src/a/p/pretty.ts')
  assert.ok(a && b && a.score > b.score)
  assert.deepEqual(t.fuzzyScore('sa', 'src/app.ts').idx.length, 2)
  assert.deepEqual(t.fuzzyScore('', 'x'), { score: 0, idx: [] })
  const ranked = ['lib/filesystem.ts', 'src/files.ts', 'docs/FILES.md'].map((p) => [p, t.fuzzyScore('files', p)]).filter((x) => x[1]).sort((x, y) => y[1].score - x[1].score)
  assert.equal(ranked[0][0] === 'lib/filesystem.ts', false)
})

test('decodeText / encodeText round trip BOM, UTF-16 and CRLF', () => {
  const u8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('h\u00e9llo\r\nw', 'utf8')])
  const d = t.decodeText(u8)
  assert.equal(d.text, 'h\u00e9llo\r\nw')
  assert.equal(d.bom, true)
  assert.equal(t.detectEol(d.text), 'crlf')
  assert.deepEqual(t.encodeText('h\u00e9llo\nw', { encoding: 'utf8', bom: true, eol: 'crlf' }), u8)
  const u16 = t.encodeText('a\nb', { encoding: 'utf16le', bom: true, eol: 'lf' })
  assert.equal(t.decodeText(u16).text, 'a\nb')
  assert.equal(t.decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'latin1').text, 'caf\u00e9')
  assert.equal(t.detectEol('a\nb\nc\r\n'), 'lf')
})

test('looksBinary: NUL bytes mean binary, UTF-16 BOM does not', () => {
  assert.equal(t.looksBinary(Buffer.from([1, 2, 0, 3])), true)
  assert.equal(t.looksBinary(Buffer.from('plain text')), false)
  assert.equal(t.looksBinary(Buffer.from([0xff, 0xfe, 0x61, 0x00])), false)
})

test('parseRange: suffix, open-ended, clamped and invalid ranges', () => {
  assert.equal(t.parseRange(undefined, 100), null)
  assert.deepEqual(t.parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(t.parseRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(t.parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(t.parseRange('bytes=50-500', 100), { start: 50, end: 99 })
  assert.equal(t.parseRange('bytes=100-', 100), 'bad')
  assert.equal(t.parseRange('bytes=9-2', 100), 'bad')
  assert.equal(t.parseRange('items=1-2', 100), 'bad')
})

test('kindByExt', () => {
  assert.equal(t.kindByExt('a/b.PNG'), 'image')
  assert.equal(t.kindByExt('x.pdf'), 'pdf')
  assert.equal(t.kindByExt('x.m4a'), 'audio')
  assert.equal(t.kindByExt('x.mp4'), 'video')
  assert.equal(t.kindByExt('x.rs'), null)
})

test('write: atomic save keeps EOL/BOM and detects a changed mtime', async () => {
  t.grants.length = 0
  await files.methods.grant({ path: tmp })
  const f = path.join(tmp, 'doc.txt')
  fs.writeFileSync(f, 'one\r\ntwo\r\n')
  const r = await files.methods.read({ path: f, root: tmp })
  assert.equal(r.kind, 'text')
  assert.equal(r.eol, 'crlf')
  assert.equal(r.content, 'one\ntwo\n')
  const w = await files.methods.write({ path: f, root: tmp, content: 'one\nTWO\n', eol: r.eol, encoding: r.encoding, bom: r.bom, expectMtimeMs: r.mtimeMs })
  assert.equal(w.ok, true)
  assert.equal(fs.readFileSync(f, 'utf8'), 'one\r\nTWO\r\n')
  const stale = await files.methods.write({ path: f, root: tmp, content: 'x', eol: 'lf', expectMtimeMs: r.mtimeMs - 5000 })
  assert.equal(stale.conflict, true)
  assert.equal(fs.readFileSync(f, 'utf8'), 'one\r\nTWO\r\n')
  const forced = await files.methods.write({ path: f, root: tmp, content: 'x', eol: 'lf', expectMtimeMs: r.mtimeMs - 5000, force: true })
  assert.equal(forced.ok, true)
  assert.equal(fs.readFileSync(f, 'utf8'), 'x')
  await assert.rejects(files.methods.read({ path: path.join(tmp, '..', 'nope.txt'), root: tmp }), /Outside/)
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp')), [])
})

test('gutter, status and list against a real git repo', async () => {
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
  const run = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' })
  run('init', '-q')
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'a\nb\nc\n')
  fs.writeFileSync(path.join(repo, 'ign.log'), 'x')
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\n')
  run('add', '.')
  run('commit', '-qm', 'init')
  await files.methods.grant({ path: repo })
  const g = await files.methods.gutter({ path: path.join(repo, 'src', 'a.txt'), root: repo, text: 'a\nB\nc\nd\n' })
  assert.equal(g.tracked, true)
  assert.deepEqual(g.marks, [{ kind: 'modified', start: 2, end: 2 }, { kind: 'added', start: 4, end: 4 }])
  const clean = await files.methods.gutter({ path: path.join(repo, 'src', 'a.txt'), root: repo, text: 'a\nb\nc\n' })
  assert.equal(clean.count, 0)
  const gone = await files.methods.gutter({ path: path.join(repo, 'src', 'a.txt'), root: repo, text: 'a\nc\n' })
  assert.deepEqual(gone.marks, [{ kind: 'removed', line: 1 }])
  const fresh = await files.methods.gutter({ path: path.join(repo, 'src', 'new.txt'), root: repo, text: 'n1\nn2\n' })
  assert.equal(fresh.tracked, false)
  assert.deepEqual(fresh.marks, [{ kind: 'added', start: 1, end: 2 }])
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'changed\n')
  fs.writeFileSync(path.join(repo, 'src', 'u.txt'), 'u')
  const st = await files.methods.status({ root: repo })
  assert.equal(st.repo, true)
  assert.equal(st.files['src/a.txt'], 'M')
  assert.equal(st.files['src/u.txt'], '?')
  assert.equal(st.changed, 1)
  assert.ok(st.ignored.includes('ign.log'))
  const l = await files.methods.list({ dir: repo, root: repo, compact: true })
  assert.deepEqual(l.entries.map((e) => e.name), ['src', '.gitignore', 'ign.log'])
  const deep = await files.methods.list({ dir: path.join(repo, 'src'), root: repo, compact: true })
  assert.equal(deep.entries[0].name, 'deep')
  const found = await files.methods.find({ root: repo, query: 'a.t' })
  assert.equal(found.results[0].path, 'src/a.txt')
})

test('media server honours Range and refuses unknown tokens', async () => {
  const f = path.join(tmp, 'clip.mp4')
  fs.writeFileSync(f, Buffer.from('0123456789'))
  await files.methods.grant({ path: tmp })
  const { url } = await files.methods.media({ path: f, root: tmp })
  const full = await fetch(url)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'video/mp4')
  const part = await fetch(url, { headers: { Range: 'bytes=2-4' } })
  assert.equal(part.status, 206)
  assert.equal(await part.text(), '234')
  assert.equal(part.headers.get('content-range'), 'bytes 2-4/10')
  assert.equal((await fetch(url, { headers: { Range: 'bytes=99-' } })).status, 416)
  assert.equal((await fetch(url.replace(/\/f\/[0-9a-f]+\//, '/f/deadbeef/'))).status, 404)
  await assert.rejects(files.methods.media({ path: path.join(os.tmpdir(), 'elsewhere.mp4'), root: tmp }), /Outside/)
})

test('Windows-1252 and UTF-16 BE round trip exactly', () => {
  const s = 'caf\u00e9 \u201cquoted\u201d \u20ac5 \u2026'
  const b = t.encodeText(s, { encoding: 'latin1' })
  assert.deepEqual([...b.subarray(0, 4)], [0x63, 0x61, 0x66, 0xe9])
  assert.ok(b.includes(0x93) && b.includes(0x94) && b.includes(0x80) && b.includes(0x85))
  assert.equal(t.decodeText(b, 'latin1').text, s)
  assert.equal(t.encodeText('\u4e2d', { encoding: 'latin1' })[0], 0x3f)
  const be = t.encodeText('a\nb\u00e9', { encoding: 'utf16be', bom: true })
  assert.deepEqual([...be.subarray(0, 4)], [0xfe, 0xff, 0x00, 0x61])
  const d = t.decodeText(be)
  assert.deepEqual([d.text, d.encoding, d.bom], ['a\nb\u00e9', 'utf16be', true])
  assert.deepEqual(t.encodeText(d.text, d), be)
})

test('editorconfig: globs, nearest file wins, root stops the walk', async () => {
  assert.ok(t.ecGlob('*.{js,ts}').test('src/a.ts'))
  assert.ok(!t.ecGlob('*.{js,ts}').test('src/a.tsx'))
  assert.ok(t.ecGlob('src/**.md').test('src/a/b.md'))
  assert.ok(!t.ecGlob('src/*.md').test('src/a/b.md'))
  assert.ok(t.ecGlob('[ab].txt').test('a.txt') && !t.ecGlob('[!ab].txt').test('a.txt'))
  assert.ok(t.ecGlob('f{1..3}').test('f2') && !t.ecGlob('f{1..3}').test('f4'))
  const dir = path.join(tmp, 'ec')
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.editorconfig'), 'root = true\n[*]\nindent_style = space\nindent_size = 2\nend_of_line = crlf\ntrim_trailing_whitespace = true\n[*.md]\ntrim_trailing_whitespace = false\n')
  fs.writeFileSync(path.join(dir, 'sub', '.editorconfig'), '[*.js]\nindent_style = tab\nindent_size = tab\ntab_width = 8\ninsert_final_newline = true\ncharset = utf-8-bom\n')
  t.grants.length = 0
  await files.methods.grant({ path: tmp })
  const js = await files.methods.editorconfig({ path: path.join(dir, 'sub', 'a.js'), root: tmp })
  assert.deepEqual(js, { indentStyle: 'tab', indentSize: 8, tabWidth: 8, eol: 'crlf', encoding: 'utf8', bom: true, trimTrailing: true, finalNewline: true })
  const md = await files.methods.editorconfig({ path: path.join(dir, 'a.md'), root: tmp })
  assert.deepEqual(md, { indentStyle: 'space', indentSize: 2, eol: 'crlf' })
})

test('read: invalid UTF-8 without a BOM is sniffed as Windows-1252, and a forced UTF-8 read is flagged lossy', async () => {
  t.grants.length = 0
  await files.methods.grant({ path: tmp })
  const f = path.join(tmp, 'legacy.txt')
  fs.writeFileSync(f, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94]))
  const r = await files.methods.read({ path: f, root: tmp })
  assert.deepEqual([r.encoding, r.content, r.sniffed], ['latin1', 'caf\u00e9 \u201cq\u201d', true])
  const forced = await files.methods.read({ path: f, root: tmp, encoding: 'utf8' })
  assert.equal(forced.lossy, true)
  assert.equal(forced.encoding, 'utf8')
  const ok = path.join(tmp, 'fine.txt')
  fs.writeFileSync(ok, 'caf\u00e9')
  const g = await files.methods.read({ path: ok, root: tmp })
  assert.deepEqual([g.encoding, g.lossy, g.sniffed], ['utf8', undefined, undefined])
})
