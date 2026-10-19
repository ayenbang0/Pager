import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { CheckpointLog, checkpointLines, MAX_CHECKPOINTS } from './checkpoints.js'
import { checkpointRefPrefix, currentSha, ensureWorktree, removeWorktree } from './git.js'
import { removeTmpDirs, tmpDir } from '../../testing/testutil.js'

after(removeTmpDirs)

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

interface Fixture {
  root: string
  dir: string
  branch: string
  log: CheckpointLog
}

/** A repo with one commit and an agent worktree on `pager/omp`. */
async function fixture(): Promise<Fixture> {
  const root = tmpDir('pager-cp-repo-')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'tester')
  git(root, 'config', 'user.email', 't@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(root, 'base.txt'), 'base')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  const dir = path.join(tmpDir('pager-cp-wt-'), 'omp')
  const branch = 'pager/omp'
  await ensureWorktree(root, dir, branch, git(root, 'rev-parse', 'HEAD'))
  return { root, dir, branch, log: new CheckpointLog(root, branch) }
}

/** What an agent turn leaves behind: a commit in the worktree. */
function turn(f: Fixture, file: string, text: string): void {
  fs.writeFileSync(path.join(f.dir, file), text)
  git(f.dir, 'add', '-A')
  git(f.dir, '-c', 'user.name=a', '-c', 'user.email=a@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `turn ${file}`)
}

const input = (sha: string, run: string, ask = 'do it') => ({ sha, run, ask, task: 'task', purpose: 'purpose' })

const refs = (f: Fixture): string[] => git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/pager/checkpoints').split('\n').filter(Boolean)

test('record keeps the pre-turn sha and metadata, and list returns them oldest first', async () => {
  const f = await fixture()
  const s0 = await currentSha(f.dir)
  const a = await f.log.record(input(s0, 'omp-1', 'first\nsecond line'), 1000)
  turn(f, 'a.txt', 'a')
  const s1 = await currentSha(f.dir)
  const b = await f.log.record({ ...input(s1, 'omp-2'), task: 'multi\nline  task' }, 2000)
  assert.deepEqual(a, { n: 1, sha: s0, run: 'omp-1', at: 1000, ask: 'first second line', task: 'task', purpose: 'purpose' })
  assert.equal(b.n, 2)
  assert.equal(b.task, 'multi line task')
  assert.deepEqual(await f.log.list(), [a, b])
  assert.deepEqual(refs(f), [`${checkpointRefPrefix(f.branch)}/1`, `${checkpointRefPrefix(f.branch)}/2`])
})

test('a new log reads the checkpoints back from the git refs', async () => {
  const f = await fixture()
  const s0 = await currentSha(f.dir)
  await f.log.record(input(s0, 'omp-1'), 1000)
  turn(f, 'a.txt', 'a')
  await f.log.record(input(await currentSha(f.dir), 'omp-2'), 2000)
  const again = await new CheckpointLog(f.root, f.branch).list()
  assert.deepEqual(again.map((c) => [c.n, c.run, c.at, c.sha === s0]), [[1, 'omp-1', 1000, true], [2, 'omp-2', 2000, false]])
})

test('the stack is trimmed to the last MAX_CHECKPOINTS and old refs are deleted', async () => {
  const f = await fixture()
  const sha = await currentSha(f.dir)
  for (let i = 1; i <= MAX_CHECKPOINTS + 3; i++) await f.log.record(input(sha, `omp-${i}`), i)
  const items = await f.log.list()
  assert.equal(items.length, MAX_CHECKPOINTS)
  assert.equal(items[0]?.n, 4)
  assert.equal(items.at(-1)?.n, MAX_CHECKPOINTS + 3)
  assert.equal(refs(f).length, MAX_CHECKPOINTS)
  assert.equal((await new CheckpointLog(f.root, f.branch).list()).length, MAX_CHECKPOINTS)
})

test('restore resets the worktree to before the last turn and drops that checkpoint', async () => {
  const f = await fixture()
  const s0 = await currentSha(f.dir)
  await f.log.record(input(s0, 'omp-1'))
  turn(f, 'a.txt', 'a')
  const s1 = await currentSha(f.dir)
  await f.log.record(input(s1, 'omp-2'))
  turn(f, 'b.txt', 'b')
  const res = await f.log.restore(f.dir, 1)
  assert.deepEqual(res.removed.map((c) => c.run), ['omp-2'])
  assert.equal(res.snapshot, false)
  assert.equal(await currentSha(f.dir), s1)
  assert.equal(fs.existsSync(path.join(f.dir, 'b.txt')), false)
  assert.equal(fs.existsSync(path.join(f.dir, 'a.txt')), true)
  assert.deepEqual((await f.log.list()).map((c) => c.run), ['omp-1'])
  assert.deepEqual(refs(f), [`${checkpointRefPrefix(f.branch)}/1`])
  const next = await f.log.record(input(s1, 'omp-3'))
  assert.equal(next.n, 2)
})

test('restore can undo several turns at once', async () => {
  const f = await fixture()
  const s0 = await currentSha(f.dir)
  for (const name of ['a', 'b', 'c']) {
    await f.log.record(input(await currentSha(f.dir), `omp-${name}`))
    turn(f, `${name}.txt`, name)
  }
  const res = await f.log.restore(f.dir, 2)
  assert.deepEqual(res.removed.map((c) => c.run), ['omp-b', 'omp-c'])
  assert.equal(fs.existsSync(path.join(f.dir, 'a.txt')), true)
  assert.equal(fs.existsSync(path.join(f.dir, 'b.txt')), false)
  assert.deepEqual((await f.log.list()).map((c) => c.run), ['omp-a'])
  await f.log.restore(f.dir, 1)
  assert.equal(await currentSha(f.dir), s0)
})

test('restore refuses a count outside the stack and changes nothing', async () => {
  const f = await fixture()
  await assert.rejects(f.log.restore(f.dir, 1), /0 turn/)
  await f.log.record(input(await currentSha(f.dir), 'omp-1'))
  turn(f, 'a.txt', 'a')
  await assert.rejects(f.log.restore(f.dir, 2), /1 turn/)
  await assert.rejects(f.log.restore(f.dir, 0))
  assert.equal(fs.existsSync(path.join(f.dir, 'a.txt')), true)
  assert.equal((await f.log.list()).length, 1)
})

test('restore commits uncommitted work first so it stays in the reflog, then resets', async () => {
  const f = await fixture()
  const s0 = await currentSha(f.dir)
  await f.log.record(input(s0, 'omp-1'))
  turn(f, 'a.txt', 'a')
  fs.writeFileSync(path.join(f.dir, 'a.txt'), 'edited')
  fs.writeFileSync(path.join(f.dir, 'new.txt'), 'untracked')
  const res = await f.log.restore(f.dir, 1)
  assert.equal(res.snapshot, true)
  assert.equal(await currentSha(f.dir), s0)
  assert.equal(git(f.dir, 'status', '--porcelain'), '')
  assert.equal(fs.existsSync(path.join(f.dir, 'new.txt')), false)
  assert.match(git(f.dir, 'reflog', '-n', '3'), /uncommitted work saved before undo/)
})

test('the checkpointed commit survives gc while only its ref names it', async () => {
  const f = await fixture()
  turn(f, 'a.txt', 'a')
  const s1 = await currentSha(f.dir)
  await f.log.record(input(s1, 'omp-1'))
  turn(f, 'b.txt', 'b')
  git(f.dir, 'reset', '--hard', '-q', 'HEAD~2')
  git(f.root, 'reflog', 'expire', '--expire=now', '--all')
  git(f.root, 'gc', '-q', '--prune=now')
  assert.equal(git(f.root, 'cat-file', '-t', s1), 'commit')
})

test('clear and removeWorktree delete the refs', async () => {
  const f = await fixture()
  await f.log.record(input(await currentSha(f.dir), 'omp-1'))
  await f.log.record(input(await currentSha(f.dir), 'omp-2'))
  await f.log.clear()
  assert.deepEqual(await f.log.list(), [])
  assert.deepEqual(refs(f), [])

  await f.log.record(input(await currentSha(f.dir), 'omp-3'))
  const other = new CheckpointLog(f.root, 'pager/omp-2')
  await other.record(input(await currentSha(f.dir), 'omp2-1'))
  await removeWorktree(f.root, f.dir, f.branch)
  assert.deepEqual(refs(f), [`${checkpointRefPrefix('pager/omp-2')}/1`])
  assert.deepEqual(await new CheckpointLog(f.root, f.branch).list(), [])
})

test('checkpointLines numbers turns back from the newest', async () => {
  const f = await fixture()
  const sha = await currentSha(f.dir)
  await f.log.record(input(sha, 'omp-1', 'old task'))
  await f.log.record(input(sha, 'omp-2', 'new task'))
  const out = checkpointLines(await f.log.list())
  assert.equal(out.length, 2)
  assert.match(out[0] ?? '', /^1  [0-9a-f]{7}  omp-2  .*new task$/)
  assert.match(out[1] ?? '', /^2  [0-9a-f]{7}  omp-1  .*old task$/)
})

test('restore refuses to undo work that was already merged into the checkout', async () => {
  const f = await fixture()
  await f.log.record(input(await currentSha(f.dir), 'omp-1'))
  turn(f, 'a.txt', 'a')
  const s1 = await currentSha(f.dir)
  await f.log.record(input(s1, 'omp-2'))
  turn(f, 'b.txt', 'b')
  git(f.root, 'merge', '--no-ff', '--no-edit', f.branch)
  await assert.rejects(f.log.restore(f.dir, 1), /already merged/)
  await assert.rejects(f.log.restore(f.dir, 2), /already merged/)
  assert.equal(fs.existsSync(path.join(f.dir, 'b.txt')), true)
  assert.equal((await f.log.list()).length, 2)
  // A later turn on top of the merged work can still be undone.
  await f.log.record(input(await currentSha(f.dir), 'omp-3'))
  turn(f, 'c.txt', 'c')
  const res = await f.log.restore(f.dir, 1)
  assert.deepEqual(res.removed.map((c) => c.run), ['omp-3'])
  assert.equal(fs.existsSync(path.join(f.dir, 'c.txt')), false)
})
