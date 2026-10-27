import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commitButton, filterEntries, groupStatus, isImagePath, mergeCandidates, operationText, pathsOf, pruneSelection, refRows, selectKeys, splitStatus } from './gitmodel.js'

const files = [
  { path: 'a.txt', index: 'M', worktree: 'M', kind: 'changed' },
  { path: 'b.txt', index: 'A', worktree: '.', kind: 'changed' },
  { path: 'c.txt', index: '.', worktree: 'D', kind: 'changed' },
  { path: 'new name.txt', orig: 'old.txt', index: 'R', worktree: '.', kind: 'renamed' },
  { path: 'x.txt', index: 'U', worktree: 'U', kind: 'unmerged' },
  { path: 'u/one.txt', index: '.', worktree: '?', kind: 'untracked' },
]

test('groupStatus fills the four groups; a staged+modified file lands in two with different keys', () => {
  const g = groupStatus(files)
  assert.deepEqual(g.conflicted.map((e) => e.key), ['conflicted:x.txt'])
  assert.deepEqual(g.staged.map((e) => `${e.path}:${e.status}`), ['a.txt:M', 'b.txt:A', 'new name.txt:R'])
  assert.equal(g.staged[2].orig, 'old.txt')
  assert.deepEqual(g.unstaged.map((e) => `${e.path}:${e.status}`), ['a.txt:M', 'c.txt:D'])
  assert.deepEqual(g.untracked.map((e) => e.key), ['untracked:u/one.txt'])
  assert.equal(g.untracked[0].untracked, true)
  assert.equal(g.conflicted[0].conflict, true)
  assert.deepEqual(groupStatus(undefined), { conflicted: [], staged: [], unstaged: [], untracked: [] })
})

test('splitStatus (sidebar) still folds untracked and conflicted into the working-tree list', () => {
  const s = splitStatus(files)
  assert.equal(s.staged.length, 3)
  assert.deepEqual(s.unstaged.map((e) => e.path), ['a.txt', 'c.txt', 'x.txt', 'u/one.txt'])
})

test('filterEntries needs every word, ignores case', () => {
  const g = groupStatus(files)
  const all = [...g.staged, ...g.unstaged, ...g.untracked]
  assert.equal(filterEntries(all, '').length, all.length)
  assert.deepEqual(filterEntries(all, 'U/ONE').map((e) => e.path), ['u/one.txt'])
  assert.deepEqual(filterEntries(all, 'txt name').map((e) => e.path), ['new name.txt'])
  assert.deepEqual(filterEntries(all, 'nope'), [])
})

test('selectKeys: plain, toggle and shift ranges', () => {
  const order = ['a', 'b', 'c', 'd', 'e']
  let s = selectKeys({ order, selected: new Set(), anchor: null }, 'b')
  assert.deepEqual([...s.selected], ['b'])
  s = selectKeys({ order, ...s }, 'd', { range: true })
  assert.deepEqual([...s.selected].sort(), ['b', 'c', 'd'])
  assert.equal(s.anchor, 'b')
  s = selectKeys({ order, ...s }, 'a', { range: true })
  assert.deepEqual([...s.selected].sort(), ['a', 'b'])
  s = selectKeys({ order, ...s }, 'e', { toggle: true })
  assert.deepEqual([...s.selected].sort(), ['a', 'b', 'e'])
  s = selectKeys({ order, ...s }, 'a', { toggle: true })
  assert.deepEqual([...s.selected].sort(), ['b', 'e'])
  s = selectKeys({ order, ...s }, 'c', { range: true, toggle: true })
  assert.deepEqual([...s.selected].sort(), ['a', 'b', 'c', 'e'], 'ctrl+shift adds the range from the anchor to what was already selected')
  // a range without a usable anchor behaves like a plain click
  assert.deepEqual([...selectKeys({ order, selected: new Set(), anchor: 'zz' }, 'c', { range: true }).selected], ['c'])
})

test('pruneSelection and pathsOf follow the visible entries', () => {
  const g = groupStatus(files)
  const sel = new Set(['staged:a.txt', 'unstaged:a.txt', 'staged:gone.txt'])
  assert.deepEqual([...pruneSelection(sel, [...g.staged, ...g.unstaged].map((e) => e.key))].sort(), ['staged:a.txt', 'unstaged:a.txt'])
  assert.deepEqual(pathsOf([...g.staged, ...g.unstaged], sel, 'staged'), ['a.txt'])
  assert.deepEqual(pathsOf([...g.staged, ...g.unstaged], sel, 'unstaged'), ['a.txt'])
  assert.deepEqual(pathsOf(g.untracked, sel, 'untracked'), [])
})

test('commitButton explains why it is disabled', () => {
  const base = { staged: 2, conflicted: 0, summary: 'Fix it', amend: false, committing: false }
  assert.deepEqual(commitButton(base), { disabled: false, label: 'Commit 2 files', hint: '' })
  assert.equal(commitButton({ ...base, staged: 1 }).label, 'Commit 1 file')
  assert.match(commitButton({ ...base, summary: '  ' }).hint, /summary/)
  assert.equal(commitButton({ ...base, summary: '' }).disabled, true)
  assert.equal(commitButton({ ...base, staged: 0 }).label, 'Nothing staged')
  assert.equal(commitButton({ ...base, staged: 0 }).disabled, true)
  assert.equal(commitButton({ ...base, conflicted: 2 }).label, 'Resolve conflicts')
  assert.match(commitButton({ ...base, conflicted: 1 }).hint, /1 file still has conflicts/)
  assert.deepEqual(commitButton({ ...base, amend: true, summary: '', staged: 0 }), { disabled: false, label: 'Amend message', hint: '' })
  assert.equal(commitButton({ ...base, amend: true }).label, 'Amend with 2 files')
  assert.equal(commitButton({ ...base, committing: true }).disabled, true)
})

test('operationText names the operation, its step and what is left', () => {
  assert.equal(operationText(null), null)
  const r = operationText({ kind: 'rebase', label: 'Rebase in progress', step: 2, total: 5 }, 1)
  assert.equal(r.title, 'Rebase in progress (step 2 of 5)')
  assert.equal(r.detail, '1 file has conflicts')
  assert.equal(r.canSkip, true)
  assert.equal(r.continueLabel, 'Continue')
  const m = operationText({ kind: 'merge', label: 'Merge in progress' }, 0)
  assert.equal(m.canSkip, false)
  assert.equal(m.continueLabel, 'Commit merge')
  assert.match(m.detail, /No conflicts left/)
  assert.match(operationText({ kind: 'merge', label: '' }, 3).title, /merge in progress/)
})

test('isImagePath', () => {
  assert.equal(isImagePath('a/b.PNG'), true)
  assert.equal(isImagePath('logo.svg'), true)
  assert.equal(isImagePath('png'), false)
  assert.equal(isImagePath('notes.txt'), false)
  assert.equal(isImagePath(undefined), false)
})

const refs = {
  branches: [
    { name: 'main', current: true, date: 5, hash: 'a', ahead: 1, behind: 0 },
    { name: 'old', current: false, date: 1, hash: 'b' },
    { name: 'feature/x', current: false, date: 9, hash: 'c' },
  ],
  remotes: [
    { name: 'origin/main', date: 4, hash: 'a' },
    { name: 'origin/dev', date: 8, hash: 'd' },
    { name: 'up/stream/x', date: 2, hash: 'e' },
  ],
  tags: [{ name: 'v1', date: 3, hash: 'a' }, { name: 'v2', date: 7, hash: 'c' }],
  stashes: [{ ref: 'stash@{0}', hash: 'f', message: 'On main: wip thing', date: 6 }],
  remoteNames: ['origin', 'up'],
  remoteInfo: [{ name: 'origin', url: 'git@x:o.git' }, { name: 'up', url: 'u' }],
}

test('refRows: current branch first, then newest; remotes grouped; empty sections vanish', () => {
  const rows = refRows(refs)
  assert.deepEqual(rows.filter((r) => r.type === 'header').map((r) => `${r.id}:${r.count}`), ['branches:3', 'remotes:3', 'tags:2', 'stashes:1'])
  assert.deepEqual(rows.filter((r) => r.kind === 'branch').map((r) => r.name), ['main', 'feature/x', 'old'])
  assert.deepEqual(rows.filter((r) => r.type === 'subheader').map((r) => `${r.title}|${r.url}`), ['origin|git@x:o.git', 'up|u'])
  assert.deepEqual(rows.filter((r) => r.kind === 'remote').map((r) => `${r.remote}:${r.short}`), ['origin:dev', 'origin:main', 'up:stream/x'])
  assert.deepEqual(rows.filter((r) => r.kind === 'tag').map((r) => r.name), ['v2', 'v1'])
  assert.equal(rows.find((r) => r.kind === 'stash').title, 'wip thing')
  assert.deepEqual(refRows({ branches: [], remotes: [], tags: [], stashes: [] }), [])
})

test('refRows filters by name and collapses sections', () => {
  const rows = refRows(refs, 'x')
  assert.deepEqual(rows.filter((r) => r.type === 'header').map((r) => r.id), ['branches', 'remotes'])
  assert.deepEqual(rows.filter((r) => r.type === 'item').map((r) => r.name), ['feature/x', 'up/stream/x'])
  assert.deepEqual(refRows(refs, 'WIP').filter((r) => r.type === 'item').map((r) => r.kind), ['stash'])
  assert.deepEqual(refRows(refs, 'zzz'), [])
  const c = refRows(refs, '', new Set(['branches', 'tags']))
  assert.equal(c.filter((r) => r.kind === 'branch').length, 0)
  assert.equal(c.find((r) => r.id === 'branches').collapsed, true)
  assert.equal(c.filter((r) => r.kind === 'remote').length, 3)
})

test('mergeCandidates excludes the current branch', () => {
  assert.deepEqual(mergeCandidates(refs, 'main'), ['old', 'feature/x', 'origin/main', 'origin/dev', 'up/stream/x'])
})
