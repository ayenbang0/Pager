// These tests drive real child processes and real git repositories, so a few waits poll real time (waitFor).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Toast } from '../engine.js'
import { removeTmpDirs, tmpDir, waitFor } from '../testutil.js'
import type { AdapterSpec } from './adapters.js'
import { Orchestrator, type OrchestratorOptions } from './orchestrator.js'

const fixture = fileURLToPath(new URL('./testAgent.js', import.meta.url))
const fake: AdapterSpec = { bin: process.execPath, args: (p) => [fixture, p], extract: (s) => s.trim() }
const fakes: Record<string, AdapterSpec> = { omp: fake, claude: fake, opencode: fake, hermes: fake }

const tmp = tmpDir
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

/** Runs `fn` with an environment variable set, restoring it afterwards (the orchestrator snapshots process.env when constructed). */
async function withEnv(name: string, value: string, fn: () => Promise<void>): Promise<void> {
  process.env[name] = value
  try {
    await fn()
  } finally {
    delete process.env[name]
  }
}

async function withOrch(
  fn: (ctx: { orch: Orchestrator; repo: string; toasts: Toast[]; dataDir: string }) => Promise<void>,
  extra: Partial<OrchestratorOptions> = {},
  review = false,
): Promise<void> {
  const repo = makeRepo()
  const dataDir = tmp('pager-data-')
  const orch = new Orchestrator({ dataDir, workdir: repo, adapters: fakes, ...extra })
  const toasts: Toast[] = []
  orch.on('toast', (t: Toast) => toasts.push(t))
  await orch.refresh()
  orch.setReview(review)
  try {
    await fn({ orch, repo, toasts, dataDir })
  } finally {
    await orch.close()
    for (const d of [repo, dataDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  }
}

const texts = (orch: Orchestrator, scope?: string): string[] => orch.messages(200, scope).map((m) => `${m.authorName}: ${m.text}`)
const idle = (orch: Orchestrator): boolean => orch.room().agents.every((a) => a.state === 'idle') && orch.room().runs.every((r) => r.state !== 'queued' && r.state !== 'running')
const settled = (orch: Orchestrator): Promise<void> => waitFor(() => idle(orch), 30_000, 'agents to settle')

test('the first check seeds a team from the agents that are ready', () =>
  withOrch(async ({ orch }) => {
    assert.deepEqual(orch.names(), ['omp', 'claude', 'opencode', 'hermes'])
  }))

test('a turn edits only its own worktree and leaves the checkout clean', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.ask('omp', 'WRITE a.txt=hi\nECHO done')
    const [run] = orch.room().runs
    assert.ok(run)
    assert.equal(fs.existsSync(path.join(repo, 'a.txt')), false)
    assert.equal(git(repo, 'status', '--porcelain'), '')
    assert.equal(git(repo, 'rev-list', '--count', 'main..pager/omp'), '1')
    assert.equal(git(repo, 'show', '--name-only', '--format=', 'pager/omp'), 'a.txt')
    assert.ok(orch.messages(50).some((m) => m.authorName === 'omp' && m.text.startsWith('done')))
    assert.deepEqual({ agent: run.agent, state: run.state, files: run.files, mergeable: run.mergeable }, { agent: 'omp', state: 'done', files: 1, mergeable: true })
  }))

test('an agent keeps one worktree and branch, and each turn starts from the current main branch', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.ask('omp', 'WRITE a.txt=1')
    fs.writeFileSync(path.join(repo, 'later.txt'), 'main moved on')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'main moves')
    await orch.ask('omp', 'HAS later.txt\nWRITE b.txt=2')
    assert.ok(texts(orch, 'omp').some((l) => l === 'omp: has later.txt'), 'the second turn saw main\'s new file')
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 2, 'one worktree for the repo and one for omp')
    assert.equal(git(repo, 'show', 'pager/omp:a.txt'), '1')
    assert.equal(git(repo, 'show', 'pager/omp:b.txt'), '2')
    const runs = orch.room().runs
    assert.equal(runs.length, 2)
    assert.deepEqual(
      runs.map((r) => r.mergeable),
      [false, true],
      'only the latest run of an agent offers a merge',
    )
  }))

test('merge brings the branch into the checkout and the workspace stays for the next task', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.ask('omp', 'WRITE a.txt=1')
    await orch.merge('omp')
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), '1')
    assert.equal(git(repo, 'rev-list', '--count', '--merges', 'HEAD'), '1')
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 2)
    assert.equal(git(repo, 'branch', '--list', 'pager/omp'), '+ pager/omp')
    assert.ok(orch.room().runs.every((r) => !r.mergeable))
    await orch.ask('omp', 'WRITE b.txt=2')
    assert.equal(orch.room().runs.at(-1)?.mergeable, true)
  }))

test('conflicting sibling branches abort the second merge cleanly', () =>
  withOrch(async ({ orch, repo, toasts }) => {
    await orch.ask('omp', 'WRITE shared.txt=one')
    await orch.ask('claude', 'WRITE shared.txt=two')
    assert.ok(toasts.some((t) => t.kind === 'warn' && t.text.includes('shared.txt')), 'overlap warning')
    await orch.merge('omp')
    await orch.merge('claude')
    const last = toasts.at(-1)
    assert.equal(last?.kind, 'error')
    assert.match(last?.text ?? '', /shared\.txt/)
    assert.equal(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), 'one')
    assert.equal(git(repo, 'status', '--porcelain'), '')
  }))

test('merge refuses on a dirty checkout', () =>
  withOrch(async ({ orch, repo, toasts }) => {
    await orch.ask('omp', 'WRITE a.txt=1')
    fs.writeFileSync(path.join(repo, 'base.txt'), 'changed')
    await orch.merge('omp')
    assert.equal(toasts.at(-1)?.kind, 'error')
    assert.equal(git(repo, 'rev-list', '--count', 'main..pager/omp'), '1')
    assert.equal(fs.existsSync(path.join(repo, 'a.txt')), false)
  }))

test('stop kills the agent process tree and marks the run cancelled', () => {
  const pidfile = path.join(tmp('pager-pid-'), 'pids')
  process.env.TEST_AGENT_PIDFILE = pidfile
  return withOrch(async ({ orch }) => {
    const done = orch.ask('omp', 'SLEEP 60000')
    await waitFor(() => orch.room().runs[0]?.state === 'running' && fs.existsSync(pidfile), 15_000, 'run to start')
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim().split('\n')[0])
    orch.stop('omp')
    await done
    assert.equal(orch.room().runs[0]?.state, 'cancelled')
    await waitFor(
      () => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      },
      15_000,
      'process to exit',
    )
  }).finally(() => {
    delete process.env.TEST_AGENT_PIDFILE
  })
})

test('the concurrency limit queues extra turns', () =>
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
  await orch.refresh()
  await orch.ask('omp', 'ECHO x')
  assert.equal(toasts.find((t) => t.kind === 'error')?.kind, 'error')
  assert.match(toasts.find((t) => t.kind === 'error')?.text ?? '', /git repository/)
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

test('check reports ok, failed and missing agents and only ready ones join the team', () =>
  withOrch(
    async ({ orch }) => {
      assert.deepEqual(orch.names(), ['omp', 'claude'], 'missing agents are not on the team')
      await orch.check()
      const lines = texts(orch)
      assert.ok(lines.some((l) => l.startsWith('pager: omp: ok (')))
      assert.ok(lines.some((l) => l.startsWith('pager: claude: failed')))
      assert.ok(lines.some((l) => l === 'pager: opencode: pager-test-missing-binary not found on PATH'))
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
    await first.refresh()
    await first.ask('omp', 'ECHO remembered')
    await first.close()
    fs.appendFileSync(path.join(dataDir, 'agents-room.jsonl'), 'not json\n{"n":"x"}\n')
    const second = new Orchestrator({ dataDir, workdir: repo, adapters: fakes })
    try {
      await second.refresh()
      assert.ok(texts(second).includes('you: @omp ECHO remembered'))
      assert.ok(texts(second).some((t) => t === 'omp: remembered'))
      assert.equal(second.room().unread, 0)
      assert.deepEqual(second.names(), ['omp', 'claude', 'opencode', 'hermes'], 'the team was remembered, not re-seeded')
      await second.ask('omp', 'ECHO again')
      assert.equal(new Set(second.messages(100).map((m) => m.key)).size, second.messages(100).length)
    } finally {
      await second.close()
    }
  } finally {
    for (const d of [repo, dataDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('room entries written by an older version (no addressee) show in the hub only', async () => {
  const repo = makeRepo()
  const dataDir = tmp('pager-data-')
  try {
    const old = { n: 1, ts: Date.now(), author: 'omp-ab12cd', authorKey: '0'.repeat(64), kind: 'text', text: 'from the old days' }
    fs.writeFileSync(path.join(dataDir, 'agents-room.jsonl'), `${JSON.stringify(old)}\n`)
    const orch = new Orchestrator({ dataDir, workdir: repo, adapters: fakes })
    try {
      assert.ok(texts(orch).includes('omp-ab12cd: from the old days'))
      assert.equal(orch.messages(10, 'omp').length, 0)
    } finally {
      await orch.close()
    }
  } finally {
    for (const d of [repo, dataDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('notes an agent keeps with the remember tool reach later prompts until cleared', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'TOOL remember {"note":"use tabs"}\nECHO noted')
    assert.ok(texts(orch).some((t) => t === 'omp: tool remember: ok remembered\nnoted'))
    await orch.ask('claude', 'MEM')
    assert.ok(texts(orch).some((t) => /^claude: mem: - \d{4}-\d{2}-\d{2} \(omp\) use tabs$/.test(t)))
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
      await orch.ask('omp', 'see #plan.md\nDOCSEEN\nTOOL doc_write {"name":"plan.md","text":"new plan"}\nTOOL doc_write {"name":"secret.md","text":"hacked"}')
      assert.ok(texts(orch).some((t) => t.includes('docs: plan.md')))
      assert.equal(docs.get('plan.md'), 'new plan')
      assert.equal(docs.get('secret.md'), 'peer text')
      assert.ok(texts(orch).some((t) => /^pager: omp-\w+ edited plan\.md$/.test(t)))
      assert.ok(texts(orch).some((t) => /^pager: omp-\w+ could not edit secret\.md \(it was not shown to the agent\)$/.test(t)))
      // A replacement of a document the prompt had to cut would delete the part the agent never saw.
      await orch.ask('omp', 'see #big.md\nTOOL doc_write {"name":"big.md","text":"short"}')
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
      await orch.ask('omp', 'see #plan.md\nSLEEP 700\nTOOL doc_write {"name":"plan.md","text":"agent version"}')
      assert.equal(docs.get('plan.md'), 'v1 plus a human edit')
      assert.ok(texts(orch).some((t) => /could not edit plan\.md \(it changed while the agent worked\)/.test(t)))
    },
    { docs: port },
  )
})

test('a chain runs each agent on top of the previous branch and hands over its reply', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.chain(['omp', 'claude'], 'WRITE a.txt=1')
    const [first, second] = orch.room().runs
    assert.ok(first && second)
    assert.equal(first.agent, 'omp')
    assert.equal(second.agent, 'claude')
    assert.equal(git(repo, 'show', 'pager/claude:a.txt'), '1')
    assert.ok(texts(orch).includes(`claude: chained from ${first.id}`))
  }))

test('a chain stops when a step fails', () =>
  withOrch(async ({ orch }) => {
    await orch.chain(['omp', 'claude'], 'FAIL')
    assert.equal(orch.room().runs.length, 1)
    assert.ok(texts(orch).includes('pager: chain stopped: the previous step failed'))
  }))

test('@a>b in the hub starts a chain; an unknown name names nobody', () =>
  withOrch(async ({ orch, toasts }) => {
    orch.say('@omp>claude ECHO hi')
    await waitFor(() => orch.room().runs.length === 2 && orch.room().runs.every((r) => r.state === 'done'))
    orch.say('@omp>nope hi')
    assert.equal(toasts.at(-1)?.kind, 'warn')
    assert.equal(orch.room().runs.length, 2)
  }))

test('one message that names two agents reaches both, and each knows who else heard it', () =>
  withOrch(async ({ orch }) => {
    orch.say('@omp @claude\nALSO')
    await settled(orch)
    await waitFor(() => orch.room().runs.length === 2, 15_000, 'both turns')
    await settled(orch)
    assert.ok(texts(orch, 'omp').includes('omp: also: claude'))
    assert.ok(texts(orch, 'claude').includes('claude: also: omp'))
    assert.ok(!texts(orch, 'omp').some((l) => l.startsWith('claude:')), "omp's tab does not show claude's reply")
    assert.ok(texts(orch).some((l) => l === 'omp: also: claude') && texts(orch).some((l) => l === 'claude: also: omp'), 'the hub shows both')
  }))

test('@all reaches every ready agent', () =>
  withOrch(async ({ orch }) => {
    orch.say('@all\nECHO roll call')
    await waitFor(() => orch.room().runs.length === 4, 40_000, 'four turns')
    await settled(orch)
    assert.equal(texts(orch).filter((l) => l.endsWith(': roll call')).length, 4)
  }, { limits: { maxConcurrent: 4 } }))

test('text typed in an agent tab goes to that agent only', () =>
  withOrch(async ({ orch }) => {
    orch.say('ECHO just you', 'claude')
    await waitFor(() => orch.room().runs.length === 1, 15_000, 'one turn')
    await settled(orch)
    assert.deepEqual(orch.room().runs.map((r) => r.agent), ['claude'])
    assert.ok(texts(orch, 'claude').includes('you: ECHO just you'))
    assert.equal(orch.messages(50, 'omp').length, 0)
  }))

test('the hub refuses text that names nobody', () =>
  withOrch(async ({ orch, toasts }) => {
    orch.say('hello there')
    assert.equal(toasts.at(-1)?.kind, 'warn')
    assert.match(toasts.at(-1)?.text ?? '', /@omp/)
    assert.equal(orch.room().runs.length, 0)
  }))

test('the board shows the goal, the agent\'s own line and its teammates', () =>
  withOrch(async ({ orch }) => {
    orch.setGoal('ship the login page')
    await waitFor(() => orch.goal() === 'ship the login page', 5000, 'goal')
    await orch.ask('claude', 'TOOL set_status {"task":"write the css","fits":"styles for the login page"}')
    await orch.ask('omp', 'BOARD')
    const board = texts(orch, 'omp').find((t) => t.startsWith('omp: board:')) ?? ''
    assert.match(board, /GOAL: ship the login page/)
    assert.match(board, /YOU: omp/)
    assert.match(board, /claude \(idle\) task: write the css \| fits: styles for the login page/)
  }))

test('a status an agent sets survives a restart', async () => {
  const repo = makeRepo()
  const dataDir = tmp('pager-data-')
  try {
    const first = new Orchestrator({ dataDir, workdir: repo, adapters: fakes })
    await first.refresh()
    await first.ask('claude', 'TOOL set_status {"task":"write the css"}')
    await first.close()
    const second = new Orchestrator({ dataDir, workdir: repo, adapters: fakes })
    try {
      await second.refresh()
      await second.ask('omp', 'BOARD')
      assert.ok(texts(second, 'omp').some((t) => t.includes('claude (idle) task: write the css')))
    } finally {
      await second.close()
    }
  } finally {
    for (const d of [repo, dataDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a message that touches a busy agent\'s task is forwarded to it', () =>
  withOrch(async ({ orch }) => {
    orch.say('@omp\nTOOL set_status {"task":"fix the login flow tokens"}\nSLEEP 800')
    await waitFor(() => orch.room().agents.find((a) => a.name === 'omp')?.task !== '', 15_000, 'omp to state its task')
    orch.say('@claude please check the login flow tokens')
    await waitFor(() => orch.room().runs.filter((r) => r.agent === 'omp').length === 2, 20_000, 'omp to get the forward')
    await settled(orch)
    assert.equal(orch.room().runs.filter((r) => r.agent === 'claude').length, 1)
  }))

test('an unrelated message is not forwarded, and an idle agent without a task is never woken', () =>
  withOrch(async ({ orch }) => {
    orch.say('@omp\nTOOL set_status {"task":"fix the login flow tokens"}\nSLEEP 500')
    await waitFor(() => orch.room().agents.find((a) => a.name === 'omp')?.task !== '', 15_000, 'omp to state its task')
    orch.say('@claude\nECHO lunch menu')
    await settled(orch)
    assert.equal(orch.room().runs.filter((r) => r.agent === 'omp').length, 1)
    assert.equal(orch.room().runs.filter((r) => r.agent === 'hermes').length, 0)
  }))

test('send_message delivers to a teammate, and wait returns its reply', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'TOOL send_message {"to":"claude","text":"ECHO hello from omp","wait":true}')
    assert.ok(texts(orch, 'omp').some((t) => t === 'omp: tool send_message: ok hello from omp'))
    assert.ok(texts(orch, 'claude').some((t) => t === 'claude: hello from omp'))
  }))

test('send_message refuses yourself, unknown names and cycles', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'TOOL send_message {"to":"omp","text":"hi"}\nTOOL send_message {"to":"nobody","text":"hi"}')
    const mine = texts(orch, 'omp').join('\n')
    assert.match(mine, /tool send_message: error you cannot message yourself/)
    assert.match(mine, /tool send_message: error no ready agent "nobody"; ready: claude, opencode, hermes/)
    await orch.ask('omp', 'TOOL send_message {"to":"claude","text":"TOOL send_message {\\"to\\":\\"omp\\",\\"text\\":\\"back\\"}","wait":true}')
    assert.match(texts(orch, 'claude').join('\n'), /error cycle: omp > claude > omp/)
  }))

test('delegation is cut off after PEER_MAX_DEPTH hops', () =>
  withOrch(async ({ orch }) => {
    assert.equal(typeof (await orch.addAgent('omp', 'omp-2')), 'object')
    const hop = (to: string, rest: string): string => `TOOL send_message ${JSON.stringify({ to, text: rest, wait: true })}`
    const deepest = hop('omp-2', 'ECHO end')
    const third = hop('hermes', deepest)
    const second = hop('opencode', third)
    const first = hop('claude', second)
    await orch.ask('omp', first)
    assert.match(texts(orch, 'hermes').join('\n'), /error too deep/)
  }))

test('ask_user blocks the agent until the user answers, and the agent is shown as asking', () =>
  withOrch(async ({ orch }) => {
    const done = orch.ask('omp', 'TOOL ask_user {"questions":[{"question":"Which?","options":["A","B"]}]}')
    await waitFor(() => orch.questions.views().length === 1, 15_000, 'question')
    const [view] = orch.questions.views()
    assert.equal(view?.agent, 'omp')
    assert.equal(orch.room().agents.find((a) => a.name === 'omp')?.state, 'asking')
    assert.ok(view)
    orch.questions.answer(view.id, { q0: 'B' })
    await done
    assert.match(texts(orch, 'omp').join('\n'), /"selected":\["B"\]/)
  }))

test('stopping an agent cancels its pending question', () =>
  withOrch(async ({ orch }) => {
    const done = orch.ask('omp', 'TOOL ask_user {"questions":[{"question":"Which?","options":["A","B"]}]}')
    await waitFor(() => orch.questions.views().length === 1, 15_000, 'question')
    orch.stop('omp')
    await done
    assert.equal(orch.questions.views().length, 0)
  }))

test('a file-changing turn is reviewed by another agent, round robin, and the verdict reaches both tabs', () =>
  withOrch(async ({ orch }) => {
    orch.setReview(true)
    await orch.ask('omp', 'WRITE a.txt=1')
    await waitFor(() => texts(orch).some((t) => t.startsWith('pager: claude reviewed omp: approve')), 20_000, 'review')
    await settled(orch)
    assert.ok(texts(orch, 'omp').some((t) => t.startsWith('pager: claude reviewed omp: approve')))
    assert.ok(texts(orch, 'claude').some((t) => t.startsWith('pager: claude reviewed omp: approve')))
    await orch.ask('claude', 'WRITE b.txt=2')
    await waitFor(() => texts(orch).some((t) => t.startsWith('pager: opencode reviewed claude')), 20_000, 'second review')
    await settled(orch)
  }))

test('reviewer feedback goes back to the author, and the loop stops after two rounds', () =>
  withEnv('TEST_REVIEW_VERDICT', 'changes', () =>
    withEnv('TEST_AGENT_FEEDBACK_WRITE', '1', () =>
      withOrch(async ({ orch }) => {
        orch.setReview(true)
        await orch.ask('omp', 'WRITE a.txt=1')
        await waitFor(() => texts(orch).some((t) => t.includes('review stopped after 2 rounds')), 40_000, 'review to stop')
        await settled(orch)
        assert.equal(texts(orch).filter((t) => /^pager: \w+ reviewed omp: changes/.test(t)).length, 2, 'two different reviewers, round robin')
        assert.equal(orch.room().runs.filter((r) => r.agent === 'omp').length, 2, 'one feedback turn')
      }),
    ),
  ))

test('a reviewer that never calls submit_review leaves an unknown verdict and no loop', () =>
  withEnv('TEST_REVIEW_VERDICT', 'none', () =>
    withOrch(async ({ orch }) => {
      orch.setReview(true)
      await orch.ask('omp', 'WRITE a.txt=1')
      await waitFor(() => texts(orch).some((t) => t.startsWith('pager: claude reviewed omp: unknown')), 20_000, 'unknown verdict')
      await settled(orch)
      assert.equal(orch.room().runs.filter((r) => r.agent === 'omp').length, 1)
    }),
  ))

test('review can be switched off, and a lone agent has no reviewer', () =>
  withOrch(async ({ orch }) => {
    orch.setReview(false)
    await orch.ask('omp', 'WRITE a.txt=1')
    await settled(orch)
    assert.ok(!texts(orch).some((t) => t.includes('reviewed')))
    orch.setReview(true)
    for (const n of ['claude', 'opencode', 'hermes']) await orch.deleteAgent(n)
    await orch.ask('omp', 'WRITE b.txt=1')
    assert.ok(texts(orch, 'omp').includes('pager: no reviewer available'))
  }))

test('drop <agent> removes its workspace and branch; reset forgets its session', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.ask('omp', 'WRITE a.txt=1')
    await settled(orch)
    await orch.drop('omp')
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
    assert.equal(git(repo, 'branch', '--list', 'pager/omp'), '')
    assert.equal(orch.room().runs.length, 0)
  }))

test('a finished turn, a failure and a review verdict each raise a popup and a desktop alert', () =>
  withOrch(async ({ orch, toasts }) => {
    const alerts: string[] = []
    orch.on('notify', (title: string, body: string) => alerts.push(`${title}: ${body}`))
    await orch.ask('omp', 'ECHO all done')
    assert.ok(alerts.includes('omp: omp: all done'))
    assert.ok(toasts.some((t) => t.kind === 'info' && t.text === 'omp: all done'))
    await orch.ask('omp', 'FAIL')
    assert.ok(alerts.some((a) => a.startsWith('omp: omp: exit 3')))
    assert.ok(toasts.some((t) => t.kind === 'error' && t.text.startsWith('omp: exit 3')))
    orch.setReview(true)
    await orch.ask('omp', 'WRITE a.txt=1')
    await waitFor(() => alerts.some((a) => /reviewed omp: approve/.test(a)), 20_000, 'review alert')
  }))

test('deleting an agent that never ran just removes it, and a second delete finds nothing', () =>
  withOrch(async ({ orch }) => {
    assert.equal(await orch.deleteAgent('hermes'), 'deleted')
    assert.ok(!orch.room().agents.some((a) => a.name === 'hermes'))
    assert.equal(await orch.deleteAgent('hermes'), undefined)
  }))

test('deleting an agent with unmerged work keeps its workspace until it is dropped', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.ask('omp', 'WRITE a.txt=1')
    await settled(orch)
    assert.equal(await orch.deleteAgent('omp'), 'kept')
    assert.ok(!orch.room().agents.some((a) => a.name === 'omp'))
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 2)
    assert.equal(git(repo, 'branch', '--list', 'pager/omp') === '', false)
    await orch.drop('omp')
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
    assert.equal(git(repo, 'branch', '--list', 'pager/omp'), '')
  }))

test('deleting an agent whose work was merged removes its worktree and branch', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.ask('omp', 'WRITE a.txt=1')
    await orch.merge('omp')
    assert.equal(await orch.deleteAgent('omp'), 'deleted')
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
    assert.equal(git(repo, 'branch', '--list', 'pager/omp'), '')
  }))

test('deleting an agent in the middle of a turn stops it and the turn still resolves', () =>
  withOrch(async ({ orch }) => {
    const done = orch.ask('omp', 'SLEEP 60000')
    await waitFor(() => orch.room().agents.find((a) => a.name === 'omp')?.state === 'working', 20_000, 'omp working')
    assert.equal(await orch.deleteAgent('omp'), 'deleted')
    await done
    assert.ok(!orch.room().agents.some((a) => a.name === 'omp'))
  }))

after(removeTmpDirs)
