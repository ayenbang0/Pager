'use strict'
// Runs the git block's main-process methods against a throwaway repository: `node --test desktop/electron/blocks/git.test.cjs`.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { test, before, after } = require('node:test')
const { makeFixture } = require('../../renderer/blocks/_harness/git-fixture.cjs')

process.env.PAGER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-home-')) // no control.token: no Pager to ask
const block = require('./git.cjs')
const m = block.methods

let fx
let patch
const git = (...args) => execFileSync('git', args, { cwd: fx.repo, encoding: 'utf8', windowsHide: true })
const call = (name, args = {}) => m[name]({ cwd: fx.repo, ...args }, { emit() {} })

before(async () => {
  fx = makeFixture()
  patch = await import(pathToFileURL(path.join(__dirname, '../../renderer/blocks/gitpatch.js')).href)
})
after(() => {
  block.dispose()
  fx.cleanup()
})

test('open, status and refs describe the fixture', async () => {
  const o = await call('open')
  assert.equal(o.ok, true)
  assert.equal(o.branch, 'main')
  assert.equal(o.upstream, 'origin/main')
  assert.equal(o.ahead, 1)
  const s = await call('status')
  const byPath = Object.fromEntries(s.files.map((f) => [f.path, f]))
  assert.equal(byPath['docs/notes.md'].index, 'A')
  assert.equal(byPath['src/lib.rs'].worktree, 'M')
  assert.equal(byPath['TODO.txt'].kind, 'untracked')
  assert.deepEqual([s.staged, s.modified, s.untracked], [1, 1, 1])
  const r = await call('refs')
  assert.deepEqual(r.branches.map((b) => b.name).sort(), ['feature/lanes', 'fix/long-subjects', 'main'])
  assert.equal(r.branches.find((b) => b.name === 'main').ahead, 1)
  assert.ok(r.tags.find((t) => t.name === 'v0.1.0' && t.annotated))
  assert.ok(r.tags.find((t) => t.name === 'nightly' && !t.annotated))
  assert.ok(r.remotes.find((x) => x.name === 'origin/main'))
  assert.deepEqual(r.remoteNames, ['origin'])
  assert.equal(await call('open', { cwd: os.tmpdir() }).then((x) => x.ok), false)
})

test('log is topologically ordered with parents and decorations; commit lists files', async () => {
  const l = await call('log', { limit: 100 })
  assert.equal(l.commits.length, 12)
  assert.equal(l.commits[0].subject, 'feat(lib): re-exported layout and Place')
  assert.match(l.commits[0].refs, /HEAD -> main/)
  const merge = l.commits.find((c) => c.subject.startsWith('Merge branch'))
  assert.equal(merge.parents.length, 2)
  const idx = new Map(l.commits.map((c, i) => [c.hash, i]))
  for (const c of l.commits) for (const p of c.parents) assert.ok(idx.get(p) > idx.get(c.hash), 'parents come after children')
  const page = await call('log', { limit: 5, skip: 5 })
  assert.deepEqual(page.commits.map((c) => c.hash), l.commits.slice(5, 10).map((c) => c.hash))
  assert.equal(page.hasMore, true)
  const d = await call('commit', { hash: merge.hash })
  assert.equal(d.message, "Merge branch 'feature/lanes'")
  assert.ok(d.files.length >= 1)
  const first = l.commits[l.commits.length - 1]
  const root = await call('commit', { hash: first.hash })
  assert.ok(root.files.some((f) => f.path === 'src/lib.rs' && f.status === 'A' && f.add > 10))
  const diff = await call('diff', { hash: first.hash, path: 'README.md' })
  assert.match(diff.text, /\+# orbit/)
  const diff2 = await call('diff', { hash: l.commits[0].hash, parent: l.commits[0].parents[0], path: 'src/mod.rs' })
  assert.match(diff2.text, /\+pub use/)
})

test('whole-file stage, unstage and undo/redo', async () => {
  await call('stage', { paths: ['TODO.txt'] })
  assert.match(git('diff', '--cached', '--name-only'), /TODO\.txt/)
  assert.equal((await call('undoState')).undo, 'Stage TODO.txt')
  await call('undo')
  assert.doesNotMatch(git('diff', '--cached', '--name-only'), /TODO\.txt/)
  assert.equal((await call('undoState')).redo, 'Stage TODO.txt')
  await call('redo')
  assert.match(git('diff', '--cached', '--name-only'), /TODO\.txt/)
  await call('unstage', { paths: ['TODO.txt'] })
  assert.doesNotMatch(git('diff', '--cached', '--name-only'), /TODO\.txt/)
  await assert.rejects(call('stage', { paths: ['../outside'] }), /outside the repository/)
})

test('line-level staging: one added line, a hunk, then unstaging a single line', async () => {
  const text = (await call('diff', { path: 'src/lib.rs' })).text
  const d = patch.parseDiff(text)
  assert.ok(d.hunks.length >= 2, `expected several hunks, got ${d.hunks.length}`)
  // Stage only the first added line of the first hunk.
  const h0 = d.hunks[0]
  const li = h0.lines.findIndex((l) => l.t === '+')
  const p1 = patch.buildPatch(d, [{ hunk: 0, lines: [li] }])
  await call('applyPatch', { patch: p1 })
  const cached = patch.parseDiff(git('diff', '--cached', '--no-renames', '--', 'src/lib.rs'))
  assert.equal(patch.diffStat(cached).add, 1)
  assert.equal(patch.diffStat(cached).del, 0)
  // The working tree diff lost exactly that line.
  const after = patch.parseDiff((await call('diff', { path: 'src/lib.rs' })).text)
  assert.equal(patch.diffStat(after).add, patch.diffStat(d).add - 1)
  // Stage the whole last hunk (a pure addition) and the deletion hunk; every change of the file is staged afterwards.
  const sel = after.hunks.map((_, i) => ({ hunk: i, lines: null }))
  await call('applyPatch', { patch: patch.buildPatch(after, sel) })
  assert.equal((await call('diff', { path: 'src/lib.rs' })).text.trim(), '')
  const full = patch.parseDiff(git('diff', '--cached', '--no-renames', '--', 'src/lib.rs'))
  assert.deepEqual(patch.diffStat(full), patch.diffStat(d))
  // Unstage a single staged line; the rest stays staged.
  const stagedText = (await call('diff', { path: 'src/lib.rs', staged: true })).text
  const sd = patch.parseDiff(stagedText)
  const hi = sd.hunks.findIndex((h) => h.lines.some((l) => l.t === '-'))
  const di = sd.hunks[hi].lines.findIndex((l) => l.t === '-')
  await call('applyPatch', { patch: patch.buildPatch(sd, [{ hunk: hi, lines: [di] }], { reverse: true }), reverse: true })
  const rest = patch.parseDiff(git('diff', '--cached', '--no-renames', '--', 'src/lib.rs'))
  assert.equal(patch.diffStat(rest).del, patch.diffStat(sd).del - 1)
  assert.equal(patch.diffStat(rest).add, patch.diffStat(sd).add)
  assert.equal(patch.diffStat(patch.parseDiff((await call('diff', { path: 'src/lib.rs' })).text)).del, 1)
  // Undo returns the index to before the unstage.
  await call('undo')
  assert.equal(patch.diffStat(patch.parseDiff(git('diff', '--cached', '--no-renames', '--', 'src/lib.rs'))).del, patch.diffStat(sd).del)
})

test('an untracked file stages partially by line', async () => {
  fs.writeFileSync(path.join(fx.repo, 'TODO.txt'), 'one\ntwo\nthree\n')
  const t = await call('diff', { path: 'TODO.txt', untracked: true })
  const d = patch.parseDiff(t.text)
  assert.equal(d.isNew, true)
  const idx = d.hunks[0].lines.findIndex((l) => l.text === 'two')
  await call('applyPatch', { patch: patch.buildPatch(d, [{ hunk: 0, lines: [idx] }]) })
  assert.equal(git('show', ':TODO.txt'), 'two\n')
  await call('unstage', { paths: ['TODO.txt'] })
  assert.equal(git('ls-files', '--', 'TODO.txt').trim(), '')
})

test('commit message generation falls back to the file list; commit, amend and undo work', async () => {
  const g = await call('generateMessage')
  assert.equal(g.source, 'heuristic')
  assert.ok(g.summary.length > 0 && g.summary.length <= 72)
  await assert.rejects(call('commitCreate', { summary: '  ' }), /summary/i)
  const before = git('rev-parse', 'HEAD').trim()
  const c = await call('commitCreate', { summary: 'Stage by line', body: 'Why: tests.' })
  assert.equal(git('rev-parse', 'HEAD').trim(), c.hash)
  assert.equal(git('log', '-1', '--format=%B').trim(), 'Stage by line\n\nWhy: tests.')
  assert.equal((await call('undoState')).undo, 'Commit')
  await call('undo')
  assert.equal(git('rev-parse', 'HEAD').trim(), before)
  assert.match(git('diff', '--cached', '--name-only'), /docs\/notes\.md/)
  await call('redo')
  await call('commitCreate', { summary: 'Stage by line, amended', amend: true })
  assert.equal(git('log', '-1', '--format=%s').trim(), 'Stage by line, amended')
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), String(Number(git('rev-list', '--count', before).trim()) + 1))
})

test('discard, branch, tag, checkout and stash', async () => {
  fs.writeFileSync(path.join(fx.repo, 'README.md'), 'changed\n')
  fs.writeFileSync(path.join(fx.repo, 'junk.txt'), 'junk\n')
  await call('discard', { paths: ['README.md'], untracked: ['junk.txt'] })
  assert.equal(git('status', '--porcelain').includes('README.md'), false)
  assert.equal(fs.existsSync(path.join(fx.repo, 'junk.txt')), false)
  await call('createBranch', { name: 'topic/x' })
  assert.equal(git('branch', '--show-current').trim(), 'topic/x')
  await call('checkout', { ref: 'main' })
  await call('createTag', { name: 'tmp-tag' })
  assert.match(git('tag'), /tmp-tag/)
  await call('deleteTag', { name: 'tmp-tag' })
  await call('deleteBranch', { name: 'topic/x' })
  assert.doesNotMatch(git('branch'), /topic/)
  await assert.rejects(call('checkout', { ref: '--evil' }), /invalid ref/)
  fs.writeFileSync(path.join(fx.repo, 'README.md'), 'stash me\n')
  await call('stashPush', { message: 'wip' })
  assert.equal(fs.readFileSync(path.join(fx.repo, 'README.md'), 'utf8').includes('stash me'), false)
  assert.equal((await call('refs')).stashes.length, 1)
  await call('stashPop')
  assert.equal(fs.readFileSync(path.join(fx.repo, 'README.md'), 'utf8'), 'stash me\n')
})

test('push and fetch against the fixture remote; watch emits changes', async () => {
  const p = await call('push')
  assert.ok(typeof p.output === 'string')
  assert.equal((await call('open')).ahead, 0)
  await call('fetch')
  const events = []
  await m.watch({ cwd: fx.repo }, { emit: (e, x) => events.push([e, x]) })
  await new Promise((r) => setTimeout(r, 400))
  fs.writeFileSync(path.join(fx.repo, 'watched.txt'), 'x')
  for (let i = 0; i < 40 && !events.length; i++) await new Promise((r) => setTimeout(r, 100))
  assert.ok(events.length > 0, 'a worktree change is reported')
  assert.equal(events[0][0], 'changed')
  await m.unwatch({ cwd: fx.repo })
})

/** A tiny repo of its own for the merge/conflict flow, so the shared fixture's state stays untouched. */
function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-git-ops-'))
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'ada@example.com')
  g('config', 'user.name', 'Ada')
  g('config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n')
  g('add', '-A')
  g('commit', '-qm', 'base')
  return { dir, g }
}

test('merge: fast-forward, conflicts, resolve, continue and abort', async () => {
  const { dir, g } = scratchRepo()
  const c = (name, args = {}) => m[name]({ cwd: dir, ...args }, { emit() {} })
  try {
    g('checkout', '-qb', 'side')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'side\n')
    g('commit', '-qam', 'side change')
    g('checkout', '-q', 'main')
    // fast-forward only
    const ff = await c('merge', { ref: 'side', mode: 'ffonly' })
    assert.equal(ff.conflicts, false)
    assert.equal(g('log', '-1', '--format=%s').trim(), 'side change')
    assert.equal((await c('status')).operation, null)
    // diverge: both change a.txt
    g('checkout', '-qb', 'other', 'HEAD~1')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'other\n')
    g('commit', '-qam', 'other change')
    const merged = await c('merge', { ref: 'main', mode: 'noff' })
    assert.equal(merged.conflicts, true)
    const st = await c('status')
    assert.equal(st.operation.kind, 'merge')
    assert.equal(st.conflicted, 1)
    assert.equal(st.files.find((f) => f.path === 'a.txt').kind, 'unmerged')
    // continue with unresolved conflicts is an error, not silent
    await assert.rejects(c('operation', { action: 'continue' }), /unmerged|unresolved|conflict/i)
    // abort restores the pre-merge state
    await c('operation', { action: 'abort' })
    assert.equal((await c('status')).operation, null)
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'other\n')
    // again, resolve with theirs and continue
    await c('merge', { ref: 'main', mode: 'noff' })
    await c('resolve', { path: 'a.txt', side: 'theirs' })
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'side\n')
    const done = await c('operation', { action: 'continue' })
    assert.equal(done.operation, null)
    assert.equal(g('rev-list', '--parents', '-n1', 'HEAD').trim().split(' ').length, 3, 'a merge commit with two parents')
    await assert.rejects(c('operation', { action: 'abort' }), /Nothing is in progress/)
    await assert.rejects(c('merge', { ref: '--evil' }), /invalid ref/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rebase state is reported and can be aborted', async () => {
  const { dir, g } = scratchRepo()
  const c = (name, args = {}) => m[name]({ cwd: dir, ...args }, { emit() {} })
  try {
    g('checkout', '-qb', 'topic')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'topic\n')
    g('commit', '-qam', 'topic change')
    g('checkout', '-q', 'main')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n')
    g('commit', '-qam', 'main change')
    g('checkout', '-q', 'topic')
    assert.throws(() => g('rebase', 'main'), /CONFLICT|could not apply/i)
    const op = (await c('status')).operation
    assert.equal(op.kind, 'rebase')
    assert.equal(op.step, 1)
    assert.equal(op.total, 1)
    await c('operation', { action: 'abort' })
    assert.equal((await c('status')).operation, null)
    assert.equal(g('branch', '--show-current').trim(), 'topic')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stash apply/drop, branch create without switching, rename, sign-off, remote info and clone', async () => {
  const { dir, g } = scratchRepo()
  const c = (name, args = {}) => m[name]({ cwd: dir, ...args }, { emit() {} })
  const cloneParent = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-git-clone-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'stashed\n')
    await c('stashPush', { message: 'keep me' })
    let refs = await c('refs')
    assert.equal(refs.stashes.length, 1)
    assert.ok(refs.stashes[0].date > 0)
    await c('stashApply', { ref: 'stash@{0}' })
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'stashed\n')
    assert.equal((await c('refs')).stashes.length, 1, 'apply keeps the stash')
    await c('discard', { paths: ['a.txt'] })
    await c('stashDrop', { ref: 'stash@{0}' })
    assert.equal((await c('refs')).stashes.length, 0)

    await c('createBranch', { name: 'feature/x', checkout: false })
    assert.equal(g('branch', '--show-current').trim(), 'main')
    await c('renameBranch', { name: 'feature/x', to: 'feature/y' })
    refs = await c('refs')
    assert.deepEqual(refs.branches.map((b) => b.name).sort(), ['feature/y', 'main'])

    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n')
    await c('stage', { paths: ['b.txt'] })
    await c('commitCreate', { summary: 'add b', signoff: true })
    assert.match(g('log', '-1', '--format=%B'), /Signed-off-by: Ada <ada@example\.com>/)

    assert.deepEqual((await c('refs')).remoteInfo, [])
    g('remote', 'add', 'origin', dir)
    assert.deepEqual((await c('refs')).remoteInfo, [{ name: 'origin', url: dir }])

    const cloned = await c('clone', { url: dir, dir: cloneParent })
    assert.equal(cloned.path, path.join(cloneParent, path.basename(dir)))
    assert.ok(fs.existsSync(path.join(cloned.path, '.git')))
    await assert.rejects(c('clone', { url: dir, dir: cloneParent }), /already exists/)
    await assert.rejects(c('clone', { url: '--upload-pack=x', dir: cloneParent }), /Enter a repository URL/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(cloneParent, { recursive: true, force: true })
  }
})
