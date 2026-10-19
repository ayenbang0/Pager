import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir } from '../../testing/testutil.js'
import { CHECKOUT, ConflictBook, conflictsOf, describeConflict, parseMergeTree, predictConflicts } from './conflicts.js'
import { diffNumstat } from './git.js'
import { parseNumstat } from './diffstat.js'

after(removeTmpDirs)

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function makeRepo(): string {
  const dir = tmpDir('pager-conflicts-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'tester')
  git(dir, 'config', 'user.email', 't@example.invalid')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'base\n')
  fs.writeFileSync(path.join(dir, 'other.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

/** Commits `content` to `file` on a new branch off main, then returns to main. */
function branch(repo: string, name: string, files: Record<string, string>): void {
  git(repo, 'checkout', '-q', '-b', name, 'main')
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', name)
  git(repo, 'checkout', '-q', 'main')
}

test('parseMergeTree reads the conflicted files after the tree id and ignores the messages', () => {
  assert.deepEqual(parseMergeTree(0, 'abc123\n'), { kind: 'clean' })
  assert.deepEqual(parseMergeTree(1, 'abc123\na.ts\nsrc/b.ts\n\nAuto-merging a.ts\nCONFLICT (content): Merge conflict in a.ts\n'), { kind: 'conflict', files: ['a.ts', 'src/b.ts'] })
  assert.deepEqual(parseMergeTree(1, 'abc123\r\na.ts\r\na.ts\r\n\r\nmsg\r\n'), { kind: 'conflict', files: ['a.ts'] })
  assert.deepEqual(parseMergeTree(129, 'usage: git merge-tree'), { kind: 'unsupported' })
  assert.deepEqual(parseMergeTree(128, ''), { kind: 'error' })
  assert.deepEqual(parseMergeTree('ENOENT', ''), { kind: 'error' })
  assert.deepEqual(parseMergeTree(undefined, ''), { kind: 'error' })
})

test('predicts a conflict between an agent branch and the checkout, naming the file', async () => {
  const repo = makeRepo()
  branch(repo, 'pager/omp', { 'shared.txt': 'omp\n', 'other.txt': 'omp only\n' })
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'main moved\n')
  git(repo, 'commit', '-qam', 'main moves')
  assert.deepEqual(await predictConflicts(repo, [{ name: 'omp', branch: 'pager/omp' }]), [{ a: 'omp', b: CHECKOUT, files: ['shared.txt'] }])
})

test('predicts a conflict between two agent branches and leaves the checkout untouched', async () => {
  const repo = makeRepo()
  branch(repo, 'pager/omp', { 'shared.txt': 'one\n' })
  branch(repo, 'pager/claude', { 'shared.txt': 'two\n' })
  const head = git(repo, 'rev-parse', 'HEAD')
  const found = await predictConflicts(repo, [
    { name: 'omp', branch: 'pager/omp' },
    { name: 'claude', branch: 'pager/claude' },
  ])
  assert.deepEqual(found, [{ a: 'omp', b: 'claude', files: ['shared.txt'] }])
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head)
  assert.equal(git(repo, 'status', '--porcelain'), '')
})

test('branches that touch different files or different regions predict no conflict', async () => {
  const repo = makeRepo()
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'top\nmiddle\n1\n2\n3\n4\n5\n6\nbottom\n')
  git(repo, 'commit', '-qam', 'longer base')
  branch(repo, 'pager/omp', { 'shared.txt': 'TOP\nmiddle\n1\n2\n3\n4\n5\n6\nbottom\n' })
  branch(repo, 'pager/claude', { 'shared.txt': 'top\nmiddle\n1\n2\n3\n4\n5\n6\nBOTTOM\n', 'other.txt': 'claude\n' })
  assert.deepEqual(
    await predictConflicts(repo, [
      { name: 'omp', branch: 'pager/omp' },
      { name: 'claude', branch: 'pager/claude' },
    ]),
    [],
  )
})

test('a probe that reports an old git yields no predictions, and a failing probe is skipped', async () => {
  const repo = makeRepo()
  branch(repo, 'pager/omp', { 'shared.txt': 'one\n' })
  assert.deepEqual(await predictConflicts(repo, [{ name: 'omp', branch: 'pager/omp' }], async () => ({ code: 129, stdout: '' })), [])
  assert.deepEqual(await predictConflicts(repo, [{ name: 'omp', branch: 'pager/omp' }], async () => ({ code: 128, stdout: '' })), [])
  assert.deepEqual(await predictConflicts(repo, [{ name: 'ghost', branch: 'pager/ghost' }]), [], 'a missing branch is not a conflict')
})

test('the book announces a conflict once, again when its files change, and again after it clears', () => {
  const book = new ConflictBook()
  const one = { a: 'omp', b: 'claude', files: ['a.ts'] }
  assert.deepEqual(book.update([one]), [one])
  assert.deepEqual(book.update([{ a: 'claude', b: 'omp', files: ['a.ts'] }]), [], 'the same pair seen from the other side is not new')
  const more = { a: 'omp', b: 'claude', files: ['a.ts', 'b.ts'] }
  assert.deepEqual(book.update([more]), [more])
  assert.deepEqual(book.update([]), [])
  assert.deepEqual(book.update([more]), [more])
  assert.deepEqual(book.all(), [more])
  book.forget('claude')
  assert.deepEqual(book.all(), [])
})

test('conflicts are described for toasts and run lines', () => {
  assert.equal(describeConflict({ a: 'omp', b: CHECKOUT, files: ['a.ts'] }), 'omp would conflict with the checkout in a.ts')
  assert.equal(describeConflict({ a: 'omp', b: 'claude', files: ['a', 'b', 'c', 'd', 'e'] }), 'omp and claude would conflict in a, b, c, +2')
  const all = [
    { a: 'omp', b: CHECKOUT, files: ['a.ts'] },
    { a: 'omp', b: 'claude', files: ['b.ts'] },
    { a: 'claude', b: 'hermes', files: ['c.ts'] },
  ]
  assert.equal(conflictsOf(all, 'omp'), 'checkout (a.ts), claude (b.ts)')
  assert.equal(conflictsOf(all, 'claude'), 'omp (b.ts), hermes (c.ts)')
  assert.equal(conflictsOf(all, 'nobody'), '')
})

test('numstat sums added and deleted lines and counts binary files as zero', async () => {
  assert.deepEqual(parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n10\t0\tb.ts\n'), { adds: 13, dels: 1 })
  assert.deepEqual(parseNumstat(''), { adds: 0, dels: 0 })
  const repo = makeRepo()
  const base = git(repo, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'new1\nnew2\nnew3\n')
  fs.writeFileSync(path.join(repo, 'added.txt'), 'x\ny\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'edit')
  assert.deepEqual(await diffNumstat(repo, base), { adds: 5, dels: 1 })
})
