import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as u from './files-util.js'

test('langForPath: extension, file name and Dockerfile.* variants', () => {
  assert.equal(u.langForPath('C:\\a\\b\\lan.test.ts'), 'typescript')
  assert.equal(u.langForPath('/x/Dockerfile'), 'dockerfile')
  assert.equal(u.langForPath('/x/Dockerfile.dev'), 'dockerfile')
  assert.equal(u.langForPath('/x/CMakeLists.txt'), 'cmake')
  assert.equal(u.langForPath('/x/README'), null)
  assert.equal(u.langForPath('/x/.gitignore'), 'properties')
  assert.equal(u.langForPath('/x/a.PY'), 'python')
})

test('parsePathSpec: line and column, Windows drive colon is not a position', () => {
  assert.deepEqual(u.parsePathSpec('src/a.ts:12:3'), { path: 'src/a.ts', line: 12, col: 3 })
  assert.deepEqual(u.parsePathSpec('src/a.ts:12'), { path: 'src/a.ts', line: 12, col: undefined })
  assert.deepEqual(u.parsePathSpec('C:\\x\\a.ts'), { path: 'C:\\x\\a.ts', line: undefined, col: undefined })
  assert.deepEqual(u.parsePathSpec('C:\\x\\a.ts:7'), { path: 'C:\\x\\a.ts', line: 7, col: undefined })
  assert.deepEqual(u.parsePathSpec('"C:/x y/a.md"'), { path: 'C:/x y/a.md', line: undefined, col: undefined })
})

test('breadcrumb and relPath are relative to the root, case-insensitive on drives', () => {
  const c = u.breadcrumb('C:\\Repo\\src\\net\\lan.test.ts', 'c:\\repo')
  assert.deepEqual(c.map((x) => x.name), ['src', 'net', 'lan.test.ts'])
  assert.equal(c[1].path, 'c:/repo/src/net')
  assert.deepEqual(u.breadcrumb('/a/b/c/d/e.txt', '/other').map((x) => x.name), ['c', 'd', 'e.txt'])
  assert.equal(u.relPath('C:\\Repo\\src\\a.ts', 'c:/repo'), 'src/a.ts')
  assert.equal(u.relPath('/elsewhere/a.ts', '/repo'), '/elsewhere/a.ts')
  assert.equal(u.relPath('/repository/a.ts', '/repo'), '/repository/a.ts')
})

test('resolveLink and isExternalUrl', () => {
  assert.equal(u.resolveLink('C:/p/docs/a.md', '../img/x%20y.png#top'), 'C:/p/img/x y.png')
  assert.equal(u.resolveLink('/p/a.md', './b.md?x=1'), '/p/b.md')
  assert.equal(u.resolveLink('/p/a.md', '/abs/c.md'), '/abs/c.md')
  assert.ok(u.isExternalUrl('https://x.dev'))
  assert.ok(u.isExternalUrl('mailto:a@b.c'))
  assert.ok(!u.isExternalUrl('C:\\x\\y.md'))
  assert.ok(!u.isExternalUrl('docs/a.md'))
})

test('lineCol and lineSpans', () => {
  assert.deepEqual(u.lineCol('ab\ncd', 0), { line: 1, col: 1 })
  assert.deepEqual(u.lineCol('ab\ncd', 4), { line: 2, col: 2 })
  const blocks = [{ raw: '# T' }, { raw: '\n\n' }, { raw: 'a\nb' }, { raw: '\n\n' }, { raw: 'c' }]
  assert.deepEqual(u.lineSpans(blocks), [{ start: 1, end: 1 }, { start: 1, end: 1 }, { start: 3, end: 4 }, { start: 4, end: 4 }, { start: 6, end: 6 }])
})

test('changedBlocks maps gutter marks to blocks', () => {
  const spans = [{ start: 1, end: 1 }, { start: 3, end: 4 }, { start: 6, end: 6 }]
  assert.deepEqual([...u.changedBlocks(spans, [{ kind: 'modified', start: 4, end: 4 }])], [1])
  assert.deepEqual([...u.changedBlocks(spans, [{ kind: 'added', start: 1, end: 6 }])], [0, 1, 2])
  assert.deepEqual([...u.changedBlocks(spans, [])], [])
})

test('toggleTask flips the n-th checkbox and skips fenced code', () => {
  const raw = '- [ ] a\n  - [x] b\n```\n- [ ] no\n```\n1. [ ] c'
  assert.equal(u.toggleTask(raw, 0), '- [x] a\n  - [x] b\n```\n- [ ] no\n```\n1. [ ] c')
  assert.equal(u.toggleTask(raw, 1), '- [ ] a\n  - [ ] b\n```\n- [ ] no\n```\n1. [ ] c')
  assert.equal(u.toggleTask(raw, 2), '- [ ] a\n  - [x] b\n```\n- [ ] no\n```\n1. [x] c')
  assert.equal(u.toggleTask(raw, 9), raw)
})

test('blockLabel', () => {
  assert.equal(u.blockLabel({ type: 'heading', depth: 2, raw: '## x' }), 'Heading 2')
  assert.equal(u.blockLabel({ type: 'list', raw: '- [ ] x' }), 'Task list')
  assert.equal(u.blockLabel({ type: 'blockquote', raw: '> [!NOTE]\n> x' }), 'Callout')
  assert.equal(u.blockLabel({ type: 'code', lang: 'ts', raw: '' }), 'Code · ts')
})

test('mapOffset maps rendered text offsets back through markup', () => {
  assert.equal(u.mapOffset('# Changelog', 'Changelog', 3), 5)
  assert.equal(u.mapOffset('some **bold** text', 'some bold text', 7), 9)
  assert.equal(u.mapOffset('abc', 'abc', 99), 3)
})

test('slug, calloutOf, listContinuation', () => {
  assert.equal(u.slug('[1.11.0] - 2026-10-22'), '1110---2026-10-22')
  assert.equal(u.slug('Héllo World!'), 'héllo-world')
  assert.deepEqual(u.calloutOf('[!warning] Careful\nbody'), { kind: 'warning', title: 'Careful', rest: 'body' })
  assert.equal(u.calloutOf('[!nope]\nx'), null)
  assert.deepEqual(u.listContinuation('  - [x] done'), { empty: false, prefix: '  - [ ] ' })
  assert.deepEqual(u.listContinuation('9. nine'), { empty: false, prefix: '10. ' })
  assert.deepEqual(u.listContinuation('- '), { empty: true, prefix: '' })
  assert.equal(u.listContinuation('plain'), null)
})

test('hexRow pads a short last row', () => {
  const r = u.hexRow(Uint8Array.from([0x41, 0x00, 0xff]), 0, 16)
  assert.equal(r.off, '00000010')
  assert.equal(r.asc, 'A··')
  assert.ok(r.hex.startsWith('41 00 ff '))
  assert.equal(r.hex.length, 16 * 3 + 1)
})

test('humanSize', () => {
  assert.equal(u.humanSize(512), '512 B')
  assert.equal(u.humanSize(1536), '1.5 KB')
  assert.equal(u.humanSize(5 * 1024 * 1024), '5.0 MB')
})

test('detectIndent', () => {
  assert.equal(u.detectIndent('a\nb'), null)
  assert.deepEqual(u.detectIndent('f {\n\tx\n\ty\n}'), { tab: true, size: 4 })
  assert.deepEqual(u.detectIndent('f {\n  x\n  if {\n    y\n  }\n}'), { tab: false, size: 2 })
  assert.deepEqual(u.detectIndent('f {\n    x\n        y\n}'), { tab: false, size: 4 })
})
