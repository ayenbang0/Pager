import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPatch, changeCount, diffStat, lineTotal, parseDiff, splitRows } from './gitpatch.js'

const MODIFIED = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,6 +1,6 @@ fn head',
  ' one',
  '-two',
  '+TWO',
  ' three',
  ' four',
  '-five',
  '+FIVE',
  ' six',
  '@@ -20,3 +20,4 @@',
  ' tail',
  '+extra',
  ' end',
  ' end2',
  '',
].join('\n')

test('parseDiff reads paths, hunks and line numbers', () => {
  const d = parseDiff(MODIFIED)
  assert.equal(d.oldPath, 'a.txt')
  assert.equal(d.newPath, 'a.txt')
  assert.equal(d.hunks.length, 2)
  assert.equal(d.hunks[0].section, 'fn head')
  assert.deepEqual(d.hunks[0].lines.map((l) => l.t).join(''), ' -+  -+ ')
  assert.deepEqual([d.hunks[0].lines[1].oldNo, d.hunks[0].lines[1].newNo], [2, null])
  assert.deepEqual([d.hunks[0].lines[2].oldNo, d.hunks[0].lines[2].newNo], [null, 2])
  assert.deepEqual(diffStat(d), { add: 3, del: 2 })
  assert.equal(changeCount(d.hunks[1]), 1)
})

test('staging one added line keeps the deletion beside it as context', () => {
  const d = parseDiff(MODIFIED)
  const patch = buildPatch(d, [{ hunk: 0, lines: [2] }]) // only "+TWO"
  assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt\n--- a\/a\.txt\n\+\+\+ b\/a\.txt\n/)
  // the unselected "-two" becomes context, the unselected "-five"/"+FIVE" pair is neutral
  assert.ok(patch.includes('\n two\n+TWO\n'))
  assert.ok(patch.includes('\n five\n'))
  assert.ok(!patch.includes('+FIVE'))
  assert.match(patch, /@@ -1,6 \+1,7 @@ fn head/)
})

test('staging a whole hunk yields only that hunk, with the right new-side start', () => {
  const d = parseDiff(MODIFIED)
  const second = buildPatch(d, [{ hunk: 1, lines: null }])
  assert.match(second, /@@ -20,3 \+20,4 @@/)
  assert.ok(!second.includes('TWO'))
  const both = buildPatch(d, [{ hunk: 0, lines: null }, { hunk: 1, lines: null }])
  assert.match(both, /@@ -1,6 \+1,6 @@ fn head/)
  assert.match(both, /@@ -20,3 \+20,4 @@/)
})

test('a selection that selects nothing builds no patch', () => {
  const d = parseDiff(MODIFIED)
  assert.equal(buildPatch(d, []), null)
  assert.equal(buildPatch(d, [{ hunk: 0, lines: [0] }]), null) // line 0 is context
})

test('reverse (unstage) turns unselected additions into context and drops unselected deletions', () => {
  const d = parseDiff(MODIFIED)
  const patch = buildPatch(d, [{ hunk: 0, lines: [1] }], { reverse: true }) // only "-two"
  assert.ok(patch.includes('\n-two\n'))
  assert.ok(patch.includes('\n TWO\n')) // the + line stays as it is in the index
  assert.ok(patch.includes('\n FIVE\n')) // unselected "+FIVE" stays in the index as context
  assert.ok(!patch.includes('five')) // unselected "-five" is not part of the patch at all
})

test('a new file stages as a creation, a deleted one unstages as a re-creation', () => {
  const added = ['diff --git a/n.txt b/n.txt', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,3 @@', '+a', '+b', '+c', ''].join('\n')
  const d = parseDiff(added)
  assert.equal(d.isNew, true)
  const part = buildPatch(d, [{ hunk: 0, lines: [1] }])
  assert.match(part, /new file mode 100644\n--- \/dev\/null\n\+\+\+ b\/n\.txt\n@@ -0,0 \+1,1 @@\n\+b\n$/)
  const removed = ['diff --git a/o.txt b/o.txt', 'deleted file mode 100644', 'index 4444444..0000000', '--- a/o.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y', ''].join('\n')
  const r = parseDiff(removed)
  assert.equal(r.isDeleted, true)
  const whole = buildPatch(r, [{ hunk: 0, lines: null }], { reverse: true })
  assert.match(whole, /deleted file mode 100644\n--- a\/o\.txt\n\+\+\+ \/dev\/null\n/)
})

test('"no newline at end of file" markers follow the line they belong to', () => {
  const text = ['diff --git a/z b/z', 'index 1..2 100644', '--- a/z', '+++ b/z', '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+B', '\\ No newline at end of file', ''].join('\n')
  const d = parseDiff(text)
  assert.deepEqual(d.hunks[0].lines.map((l) => l.t).join(''), ' -\\+\\')
  const p = buildPatch(d, [{ hunk: 0, lines: null }])
  assert.ok(p.endsWith('-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n'))
})

test('empty or binary input parses to an empty diff', () => {
  assert.equal(parseDiff('').hunks.length, 0)
  const b = parseDiff('diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n')
  assert.equal(b.binary, true)
  assert.equal(b.hunks.length, 0)
})

test('lineTotal counts every hunk line', () => {
  assert.equal(lineTotal(parseDiff(MODIFIED)), 12)
  assert.equal(lineTotal(parseDiff('')), 0)
})

test('splitRows pairs a deletion run with the addition run after it and keeps line indexes', () => {
  const d = parseDiff(MODIFIED)
  const rows = splitRows(d.hunks[0])
  const text = rows.map((r) => (r.meta ? 'meta' : `${r.l ? r.l.line.t + r.l.line.text : '_'}|${r.r ? r.r.line.t + r.r.line.text : '_'}`))
  assert.deepEqual(text, [' one| one', '-two|+TWO', ' three| three', ' four| four', '-five|+FIVE', ' six| six'])
  assert.deepEqual(rows[1].l.li, 1)
  assert.deepEqual(rows[1].r.li, 2)
  // uneven runs leave the shorter side empty; pure additions and pure deletions stand alone
  const uneven = { lines: [{ t: '-', text: 'a' }, { t: '-', text: 'b' }, { t: '+', text: 'c' }, { t: ' ', text: 'x' }, { t: '+', text: 'd' }, { t: '-', text: 'e' }] }
  assert.deepEqual(splitRows(uneven).map((r) => `${r.l ? r.l.li : '_'}|${r.r ? r.r.li : '_'}`), ['0|2', '1|_', '3|3', '_|4', '5|_'])
})

test('splitRows turns "no newline" markers into full-width meta rows', () => {
  const rows = splitRows({ lines: [{ t: '-', text: 'a' }, { t: '\\', text: 'No newline at end of file' }, { t: '+', text: 'b' }, { t: '\\', text: 'No newline at end of file' }] })
  assert.deepEqual(rows.map((r) => (r.meta ? `meta${r.meta.li}` : `${r.l ? r.l.li : '_'}|${r.r ? r.r.li : '_'}`)), ['0|_', 'meta1', '_|2', 'meta3'])
  assert.deepEqual(splitRows({ lines: [] }), [])
})
