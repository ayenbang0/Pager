// These tests drive real child processes and real git repositories, so a few waits poll real time (waitFor).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Toast } from '../engine.js'
import { waitFor } from '../testutil.js'
import { AGENT_NAMES, type AdapterSpec, type AgentName } from './adapters.js'
import { MAX_RUNS_PER_THREAD, Orchestrator, type OrchestratorOptions } from './orchestrator.js'

const fixture = fileURLToPath(new URL('./testAgent.js', import.meta.url))
const fake: AdapterSpec = { bin: process.execPath, args: (p) => [fixture, p], extract: (s) => s.trim() }
const fakes = Object.fromEntries(AGENT_NAMES.map((n) => [n, fake])) as Record<AgentName, AdapterSpec> // every key is filled by the map above

const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function makeRepo(): string {
  const dir = tmp('pager-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'tester')
  git(dir, 'config', 'user.email', 't@example.invalid')
  git(dir, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

async function withOrch(
  fn: (ctx: { orch: Orchestrator; repo: string; toasts: Toast[] }) => Promise<void>,
  extra: Partial<OrchestratorOptions> = {},
): Promise<void> {
  const repo = makeRepo()
  const dataDir = tmp('pager-data-')
  const orch = new Orchestrator({ dataDir, workdir: repo, adapters: fakes, ...extra })
  const toasts: Toast[] = []
  orch.on('toast', (t: Toast) => toasts.push(t))
  try {
    await fn({ orch, repo, toasts })
  } finally {
    await orch.close()
    for (const d of [repo, dataDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  }
}

const texts = (orch: Orchestrator): string[] => orch.messages(100).map((m) => `${m.authorName}: ${m.text}`)

test('a run edits only its own worktree and leaves the checkout clean', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.ask('omp', 'WRITE a.txt=hi\nECHO done')
    const [run] = orch.room().runs
    assert.ok(run)
    assert.equal(fs.existsSync(path.join(repo, 'a.txt')), false)
    assert.equal(git(repo, 'status', '--porcelain'), '')
    assert.equal(git(repo, 'rev-list', '--count', `main..pager/${run.id}`), '1')
    assert.equal(git(repo, 'show', '--name-only', '--format=', `pager/${run.id}`), 'a.txt')
    assert.ok(orch.messages(50).some((m) => m.authorName === run.id && m.text.startsWith('done')))
    assert.deepEqual({ state: run.state, files: run.files, mergeable: run.mergeable }, { state: 'done', files: 1, mergeable: true })
  }))

test('delegated runs stack on each other and merge in one step', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.ask('omp', 'WRITE a.txt=1\nASK claude: HAS a.txt\nWRITE b.txt=2')
    const lines = texts(orch)
    assert.ok(lines.some((l) => /^claude-\w+: has a\.txt$/.test(l)), 'claude saw the file omp committed')
    const runs = orch.room().runs
    assert.equal(runs.length, 3)
    assert.ok(lines.some((l) => /^omp-\w+: replies: .*has a\.txt/.test(l)), 'omp was resumed with the reply')
    const last = runs[2]
    assert.ok(last)
    await orch.merge(last.id)
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), '1')
    assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), '2')
    assert.equal(git(repo, 'rev-list', '--count', '--merges', 'HEAD'), '1')
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
    assert.equal(git(repo, 'branch', '--list', 'pager/*'), '')
    assert.ok(orch.room().runs.every((r) => !r.mergeable))
  }))

test('conflicting sibling runs abort the second merge cleanly', () =>
  withOrch(async ({ orch, repo, toasts }) => {
    await orch.ask('omp', 'WRITE shared.txt=one')
    await orch.ask('claude', 'WRITE shared.txt=two')
    assert.ok(toasts.some((t) => t.kind === 'warn' && t.text.includes('shared.txt')), 'overlap warning')
    const [first, second] = orch.room().runs
    assert.ok(first && second)
    await orch.merge(first.id)
    await orch.merge(second.id)
    const last = toasts.at(-1)
    assert.equal(last?.kind, 'error')
    assert.match(last?.text ?? '', /shared\.txt/)
    assert.equal(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), 'one')
    assert.equal(git(repo, 'status', '--porcelain'), '')
  }))

test('merge refuses on a dirty checkout', () =>
  withOrch(async ({ orch, repo, toasts }) => {
    await orch.ask('omp', 'WRITE a.txt=1')
    const [run] = orch.room().runs
    assert.ok(run)
    fs.writeFileSync(path.join(repo, 'base.txt'), 'changed')
    await orch.merge(run.id)
    assert.equal(toasts.at(-1)?.kind, 'error')
    assert.equal(git(repo, 'rev-list', '--count', `main..pager/${run.id}`), '1')
    assert.equal(fs.existsSync(path.join(repo, 'a.txt')), false)
  }))

test('endless delegation is cut off by the depth and run limits', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'LOOP claude')
    const runs = orch.room().runs
    assert.ok(runs.length <= MAX_RUNS_PER_THREAD)
    assert.ok(texts(orch).some((l) => l.includes('replies:') && l.includes('delegation limit reached')))
  }))

test('stop kills the agent process tree and marks the run cancelled', () => {
  const pidfile = path.join(tmp('pager-pid-'), 'pids')
  process.env.TEST_AGENT_PIDFILE = pidfile
  return withOrch(async ({ orch }) => {
    const done = orch.ask('omp', 'SLEEP 60000')
    await waitFor(() => orch.room().runs[0]?.state === 'running' && fs.existsSync(pidfile), 15_000, 'run to start')
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim().split('\n')[0])
    orch.stop('all')
    await done
    assert.equal(orch.room().runs[0]?.state, 'cancelled')
    await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 15_000, 'process to exit')
  }).finally(() => {
    delete process.env.TEST_AGENT_PIDFILE
  })
})

test('the concurrency limit queues extra runs', () =>
  withOrch(
    async ({ orch }) => {
      const a = orch.ask('omp', 'SLEEP 60000')
      const b = orch.ask('claude', 'SLEEP 60000')
      const states = (): string => orch.room().runs.map((r) => r.state).sort().join()
      await waitFor(() => states() === 'queued,running', 15_000, 'one running, one queued')
      orch.stop('all')
      await Promise.all([a, b])
      assert.equal(states(), 'cancelled,cancelled')
    },
    { limits: { maxConcurrent: 1 } },
  ))

test('a plain directory is rejected with a toast', async () => {
  const dir = tmp('pager-plain-')
  const orch = new Orchestrator({ dataDir: tmp('pager-data-'), workdir: dir, adapters: fakes })
  const toasts: Toast[] = []
  orch.on('toast', (t: Toast) => toasts.push(t))
  await orch.ask('omp', 'ECHO x')
  assert.equal(toasts[0]?.kind, 'error')
  assert.match(toasts[0]?.text ?? '', /git repository/)
  assert.equal(orch.room().runs.length, 0)
  await orch.close()
})

test('a failing agent is reported and not mergeable', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'FAIL')
    const [run] = orch.room().runs
    assert.equal(run?.state, 'failed')
    assert.equal(run?.mergeable, false)
    assert.ok(orch.messages(10).some((m) => m.text.startsWith('(failed: exit 3')))
  }))

test('check reports ok, failed and missing agents', () =>
  withOrch(
    async ({ orch }) => {
      await orch.check()
      const lines = texts(orch)
      assert.ok(lines.some((l) => l.startsWith('pager: omp: ok (')))
      assert.ok(lines.some((l) => l.startsWith('pager: claude: failed')))
      assert.ok(lines.some((l) => l === 'pager: opencode: opencode was not found on PATH'))
    },
    {
      adapters: {
        omp: { bin: process.execPath, args: () => ['-e', "console.log('PAGER_OK')"], extract: (s) => s.trim() },
        claude: { bin: process.execPath, args: () => ['-e', "console.log('nope')"], extract: (s) => s.trim() },
        opencode: { bin: 'pager-test-missing-binary', args: () => [], extract: (s) => s },
        hermes: { bin: 'pager-test-missing-binary', args: () => [], extract: (s) => s },
      },
    },
  ))

test('the room survives a restart without counting as unread, and corrupt lines are skipped', async () => {
  const repo = makeRepo()
  const dataDir = tmp('pager-data-')
  try {
    const first = new Orchestrator({ dataDir, workdir: repo, adapters: fakes })
    await first.ask('omp', 'ECHO remembered')
    await first.close()
    fs.appendFileSync(path.join(dataDir, 'agents-room.jsonl'), 'not json\n{"n":"x"}\n')
    const second = new Orchestrator({ dataDir, workdir: repo, adapters: fakes })
    try {
      assert.ok(texts(second).includes('you: @omp ECHO remembered'))
      assert.ok(texts(second).some((t) => t.endsWith(': remembered')))
      assert.equal(second.room().unread, 0)
      await second.ask('omp', 'ECHO again')
      assert.equal(new Set(second.messages(100).map((m) => m.key)).size, second.messages(100).length)
    } finally {
      await second.close()
    }
  } finally {
    for (const d of [repo, dataDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('facts an agent keeps with @@remember reach later prompts until cleared', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'REMEMBER use tabs\nECHO noted')
    assert.ok(texts(orch).some((t) => t.endsWith(': noted')))
    assert.ok(!texts(orch).some((t) => t.includes('@@remember')))
    await orch.ask('claude', 'MEM')
    assert.ok(texts(orch).some((t) => /^claude-\w+: mem: - \d{4}-\d{2}-\d{2} \(omp\) use tabs$/.test(t)))
    await orch.memory('add', 'run npm test')
    await orch.memory('show')
    assert.ok(texts(orch).some((t) => t.startsWith('pager: memory (2 notes):')))
    await orch.memory('clear')
    await orch.ask('omp', 'MEM')
    assert.ok(texts(orch).some((t) => t.endsWith(': mem: none')))
  }))

test('agents see only the documents the task names, edit only those, and refusals are reported', () => {
  const docs = new Map([
    ['plan.md', 'old plan'],
    ['secret.md', 'peer text'],
    ['big.md', 'x'.repeat(20_000)],
  ])
  const writes: string[] = []
  const port = {
    list: (task: string) => [...docs].filter(([name]) => task.includes(`#${name}`)).map(([name, text]) => ({ name, text })),
    write: (name: string, text: string, append: boolean, base: string) => {
      if (!append && docs.get(name) !== base) return 'it changed while the agent worked'
      writes.push(name)
      docs.set(name, append ? `${docs.get(name)}${text}` : text)
      return null
    },
  }
  return withOrch(
    async ({ orch }) => {
      await orch.ask('omp', 'DOCSEEN')
      assert.ok(texts(orch).some((t) => t.endsWith(': docs: none')))
      await orch.ask('omp', 'see #plan.md\nDOCSEEN\nDOCEDIT plan.md=new plan\nDOCEDIT secret.md=hacked')
      assert.ok(texts(orch).some((t) => t.endsWith(': docs: plan.md')))
      assert.equal(docs.get('plan.md'), 'new plan')
      assert.equal(docs.get('secret.md'), 'peer text')
      assert.ok(texts(orch).some((t) => /^pager: omp-\w+ edited plan\.md$/.test(t)))
      assert.ok(texts(orch).some((t) => /^pager: omp-\w+ could not edit secret\.md \(it was not shown to the agent\)$/.test(t)))
      assert.ok(!texts(orch).some((t) => t.includes('@@doc')))
      // A replacement of a document the prompt had to cut would delete the part the agent never saw.
      await orch.ask('omp', 'see #big.md\nDOCEDIT big.md=short')
      assert.equal(docs.get('big.md')?.length, 20_000)
      assert.ok(texts(orch).some((t) => /could not edit big\.md \(a replacement needs the whole document/.test(t)))
      assert.deepEqual(writes, ['plan.md'])
    },
    { docs: port },
  )
})

test('a replace is refused when the document changed while the agent worked', () => {
  const docs = new Map([['plan.md', 'v1']])
  const port = {
    list: (task: string) => {
      if (!task.includes('#plan.md')) return []
      const snapshot = { name: 'plan.md', text: docs.get('plan.md') ?? '' }
      // Real child process: the collaborator types after the agent got its snapshot and while it is still working.
      setTimeout(() => docs.set('plan.md', 'v1 plus a human edit'), 150)
      return [snapshot]
    },
    write: (name: string, text: string, _append: boolean, base: string) => {
      if (docs.get(name) !== base) return 'it changed while the agent worked'
      docs.set(name, text)
      return null
    },
  }
  return withOrch(
    async ({ orch }) => {
      await orch.ask('omp', 'see #plan.md\nSLEEP 700\nDOCEDIT plan.md=agent version')
      assert.equal(docs.get('plan.md'), 'v1 plus a human edit')
      assert.ok(texts(orch).some((t) => /could not edit plan\.md \(it changed while the agent worked\)/.test(t)))
    },
    { docs: port },
  )
})

test('a chain runs each agent on top of the previous commit and hands over its reply', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.chain(['omp', 'claude'], 'WRITE a.txt=1')
    const [first, second] = orch.room().runs
    assert.ok(first && second)
    assert.equal(first.agent, 'omp')
    assert.equal(second.agent, 'claude')
    assert.equal(git(repo, 'show', `pager/${second.id}:a.txt`), '1')
    assert.ok(texts(orch).includes(`${second.id}: chained from ${first.id}`))
  }))

test('a chain stops when a step fails', () =>
  withOrch(async ({ orch }) => {
    await orch.chain(['omp', 'claude'], 'FAIL')
    assert.equal(orch.room().runs.length, 1)
    assert.ok(texts(orch).includes('pager: chain stopped: the previous step failed'))
  }))

test('@a>b in the room starts a chain; an unknown name is rejected', () =>
  withOrch(async ({ orch, toasts }) => {
    orch.say('@omp>claude ECHO hi')
    await waitFor(() => orch.room().runs.length === 2 && orch.room().runs.every((r) => r.state === 'done'))
    orch.say('@omp>nope hi')
    assert.equal(toasts.at(-1)?.kind, 'warn')
    assert.equal(orch.room().runs.length, 2)
  }))
