// node --test desktop/renderer/surface/diff.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlightLine, langOf, MAX_DIFF_LINES, pairHunk, parseUnifiedDiff } from './diff.js'

const GIT = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,5 +1,6 @@ export function f()
 import x from 'x'
-const a = 1
+const a = 2
+const b = "two" // note
 keep
 keep2
-gone
\\ No newline at end of file
@@ -20,3 +21,3 @@
 c
-d
+e
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/added.js b/added.js
new file mode 100644
--- /dev/null
+++ b/added.js
@@ -0,0 +1,2 @@
+one
+two
diff --git a/dead.js b/dead.js
deleted file mode 100644
--- a/dead.js
+++ /dev/null
@@ -1 +0,0 @@
-bye
`

test('git diff: files, statuses, hunks and numbering', () => {
  const d = parseUnifiedDiff(GIT)
  assert.equal(d.truncated, false)
  assert.deepEqual(d.files.map((f) => [f.name, f.status]), [['src/a.ts', 'modified'], ['new.txt', 'renamed'], ['img.png', 'binary'], ['added.js', 'added'], ['dead.js', 'deleted']])
  const a = d.files[0]
  assert.equal(a.hunks.length, 2)
  assert.equal(a.additions, 3)
  assert.equal(a.deletions, 3)
  const h = a.hunks[0]
  assert.equal(h.section, 'export function f()')
  assert.deepEqual([h.oldStart, h.oldLines, h.newStart, h.newLines], [1, 5, 1, 6])
  assert.deepEqual(h.lines.map((l) => [l.type, l.oldNo ?? null, l.newNo ?? null]), [
    ['ctx', 1, 1], ['del', 2, null], ['add', null, 2], ['add', null, 3], ['ctx', 3, 4], ['ctx', 4, 5], ['del', 5, null], ['note', null, null],
  ])
  assert.equal(h.lines[7].text, 'No newline at end of file')
  assert.equal(a.hunks[1].lines[1].oldNo, 21)
  assert.equal(d.files[1].oldName, 'old.txt')
  assert.equal(d.files[1].hunks.length, 0)
  assert.equal(d.files[3].oldName, '')
  assert.equal(d.files[4].newName, '')
})

test('plain diff -u (no git header), timestamps, CRLF input', () => {
  const d = parseUnifiedDiff('--- a.txt\t2024-01-01 10:00:00\r\n+++ b.txt\t2024-01-02 10:00:00\r\n@@ -1,2 +1,2 @@\r\n same\r\n-old\r\n+new\r\n')
  assert.equal(d.files.length, 1)
  assert.equal(d.files[0].oldName, 'a.txt')
  assert.equal(d.files[0].newName, 'b.txt')
  assert.deepEqual(d.files[0].hunks[0].lines.map((l) => l.text), ['same', 'old', 'new'])
})

test('a bare hunk list becomes one unnamed file; one-line hunk headers default counts to 1', () => {
  const d = parseUnifiedDiff('@@ -3 +3 @@\n-a\n+b\n')
  assert.equal(d.files.length, 1)
  assert.equal(d.files[0].name, '')
  assert.deepEqual([d.files[0].hunks[0].oldLines, d.files[0].hunks[0].newLines], [1, 1])
})

test('hunk counts decide where the body ends: payload lines that look like headers stay payload', () => {
  const d = parseUnifiedDiff('--- a\n+++ b\n@@ -1,3 +1,3 @@\n--- a/not-a-header\n+++ b/not-a-header\n @@ -9 +9 @@ ctx\n')
  assert.equal(d.files.length, 1)
  assert.deepEqual(d.files[0].hunks[0].lines.map((l) => l.type), ['del', 'add', 'ctx'])
})

test('hostile text is carried verbatim, never interpreted', () => {
  const evil = '<img src=x onerror=alert(1)>'
  const d = parseUnifiedDiff(`diff --git a/"><script>alert(1)</script> b/"><script>alert(1)</script>\n--- a/x\n+++ b/x\n@@ -1 +1 @@ <svg onload=alert(2)>\n-${evil}\n+${evil}\n`)
  assert.equal(d.files[0].hunks[0].section, '<svg onload=alert(2)>')
  assert.equal(d.files[0].hunks[0].lines[0].text, evil)
})

test('garbage and empty input give no files', () => {
  assert.deepEqual(parseUnifiedDiff('').files, [])
  assert.deepEqual(parseUnifiedDiff('hello\nworld\n').files, [])
  assert.deepEqual(parseUnifiedDiff('@@ -1 +1 @@ \u0000\u0001').files[0].hunks[0].lines, [])
})

test('line cap', () => {
  const body = Array.from({ length: MAX_DIFF_LINES + 50 }, (_, i) => `+l${i}`).join('\n')
  const d = parseUnifiedDiff(`@@ -0,0 +1,${MAX_DIFF_LINES + 50} @@\n${body}\n`)
  assert.equal(d.truncated, true)
  assert.equal(d.files[0].hunks[0].lines.length, MAX_DIFF_LINES)
})

test('pairHunk lines deletions up with the additions that follow', () => {
  const d = parseUnifiedDiff('@@ -1,5 +1,4 @@\n c\n-d1\n-d2\n-d3\n+a1\n+a2\n e\n')
  const rows = pairHunk(d.files[0].hunks[0])
  assert.deepEqual(rows.map((r) => [r.left && r.left.text, r.right && r.right.text]), [['c', 'c'], ['d1', 'a1'], ['d2', 'a2'], ['d3', null], ['e', 'e']])
  const only = pairHunk(parseUnifiedDiff('@@ -0,0 +1,2 @@\n+x\n+y\n').files[0].hunks[0])
  assert.deepEqual(only.map((r) => [r.left, r.right && r.right.text]), [[null, 'x'], [null, 'y']])
})

test('langOf', () => {
  assert.equal(langOf('src/a.ts'), 'js')
  assert.equal(langOf('x.PY'), 'py')
  assert.equal(langOf('run.sh'), 'sh')
  assert.equal(langOf('Makefile'), '')
  assert.equal(langOf(''), '')
})

test('highlightLine colours keywords, strings, numbers, comments', () => {
  const r = highlightLine('const s = "a // b" + 42 // trailing', 'js')
  assert.deepEqual(r.filter((x) => x.cls).map((x) => [x.cls, x.text]), [['kw', 'const'], ['str', '"a // b"'], ['num', '42'], ['com', '// trailing']])
  assert.deepEqual(highlightLine('x = 1 # note', 'py').filter((x) => x.cls).map((x) => x.cls), ['num', 'com'])
  assert.deepEqual(highlightLine('SELECT a FROM t -- hi', 'sql').filter((x) => x.cls).map((x) => x.cls), ['kw', 'kw', 'com'])
  assert.deepEqual(highlightLine('anything <b>', ''), [{ cls: '', text: 'anything <b>' }])
})

test('highlightLine runs always concatenate back to the line', () => {
  const lines = ['', '   ', '"unterminated', "it's 'quoted' \\' x", '/* c */ a /* open', 'a1b2 3x 0xFF 1.5e3', '`tpl ${x}`', 'é☃ "ü" // ✓', '\\', '"\\', 'x'.repeat(700)]
  for (const lang of ['js', 'py', 'sh', 'sql', 'json', '']) for (const l of lines) assert.equal(highlightLine(l, lang).map((x) => x.text).join(''), l, `${lang}: ${l}`)
})
