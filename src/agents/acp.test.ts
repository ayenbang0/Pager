// These tests drive real child processes and real git repositories, so a few waits poll real time (waitFor).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { waitFor } from '../testutil.js'
import { AGENT_NAMES, type AdapterSpec, type AgentName } from './adapters.js'
import { Orchestrator } from './orchestrator.js'

const oneShot = fileURLToPath(new URL('./testAgent.js', import.meta.url))
const acpAgent = fileURLToPath(new URL('./testAcpAgent.js', import.meta.url))
const fake: AdapterSpec = { bin: process.execPath, args: (p) => [oneShot, p], extract: (s) => s.trim(), acp: [acpAgent] }
const fakes = Object.fromEntries(AGENT_NAMES.map((n) => [n, fake])) as Record<AgentName, AdapterSpec> // every key is filled by the map above

const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function makeRepo(): string {
  const dir = tmp('pager-acp-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'tester')
  git(dir, 'config', 'user.email', 't@example.invalid')
  git(dir, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

async function withOrch(fn: (ctx: { orch: Orchestrator; repo: string; dataDir: string }) => Promise<void>): Promise<void> {
  const repo = makeRepo()
  const dataDir = tmp('pager-acp-data-')
  const orch = new Orchestrator({ dataDir, workdir: repo, adapters: fakes })
  try {
    await fn({ orch, repo, dataDir })
  } finally {
    await orch.close()
    for (const d of [repo, dataDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  }
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

const messages = (orch: Orchestrator): { author: string; text: string }[] =>
  orch.messages(200).map((m) => ({ author: m.authorName, text: m.text }))
const lines = (orch: Orchestrator): string[] => messages(orch).map((m) => `${m.author}: ${m.text}`)
const sessionIds = (dataDir: string): string[] =>
  Object.values(JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-sessions.json'), 'utf8')) as Record<string, Record<string, string>>).flatMap((v) =>
    Object.values(v),
  )

test('an ACP run streams into one room entry and reports its tools', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'ECHO hi\nTOOL read a.ts')
    const [run] = orch.room().runs
    assert.ok(run)
    const mine = messages(orch).filter((m) => m.author === run.id)
    assert.deepEqual(mine, [{ author: run.id, text: 'hi' }])
    assert.ok(lines(orch).includes(`pager: ${run.id} used 1 tool (read 1)`))
  }))

test('partial output is visible while the agent is still working', () =>
  withOrch(async ({ orch }) => {
    const done = orch.ask('omp', 'ECHO first\nSLEEP 1500\nECHO second')
    await waitFor(() => messages(orch).some((m) => m.text === 'first'), 10_000, 'partial text')
    assert.equal(orch.room().runs[0]?.state, 'running')
    await done
    assert.ok(messages(orch).some((m) => m.text === 'first\nsecond'))
  }))

test('permission requests are granted', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'PERM')
    assert.ok(messages(orch).some((m) => m.text === 'perm:a1'))
  }))

test('the next task resumes the stored session, also after a restart; a stale id falls back to a new one', () =>
  withOrch(async ({ orch, repo, dataDir }) => {
    await orch.ask('omp', 'SESSION')
    await orch.ask('omp', 'SESSION')
    const [first, second] = messages(orch).filter((m) => m.text.startsWith('session:'))
    assert.match(first?.text ?? '', /^session:sess-\w+ loaded:false$/)
    assert.equal(second?.text, `${first?.text.split(' ')[0]} loaded:true`)
    assert.deepEqual(sessionIds(dataDir), [first?.text.split(' ')[0]?.slice('session:'.length)])
    const file = path.join(dataDir, 'agent-sessions.json')
    const stored: Record<string, object> = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.keys(stored).map((key) => [key, { omp: 'bad-id' }]))))
    const restarted = new Orchestrator({ dataDir, workdir: repo, adapters: fakes })
    try {
      await restarted.ask('omp', 'SESSION')
      const third = messages(restarted).filter((m) => m.text.startsWith('session:')).at(-1)
      assert.match(third?.text ?? '', /loaded:false$/)
      assert.notEqual(sessionIds(dataDir)[0], 'bad-id')
    } finally {
      await restarted.close()
    }
  }))

test('replayed history from session/load is not shown, and each run works in its own worktree', () =>
  withOrch(async ({ orch, dataDir }) => {
    await orch.ask('omp', 'CWD')
    await orch.ask('omp', 'CWD')
    const cwds = messages(orch).flatMap((m) => (m.text.startsWith('cwd:') ? [m.text.slice(4)] : []))
    assert.equal(cwds.length, 2)
    assert.notEqual(cwds[0], cwds[1])
    for (const cwd of cwds) assert.ok(cwd.startsWith(path.join(dataDir, 'worktrees')), cwd)
    assert.ok(!messages(orch).some((m) => m.text.includes('REPLAYED') || m.text.includes('old question')))
  }))

test('a broken ACP handshake falls back to one-shot mode with a notice', () =>
  withEnv('TEST_ACP_BAD_INIT', '1', () =>
    withOrch(async ({ orch }) => {
      await orch.ask('omp', 'ECHO ok')
      assert.ok(lines(orch).some((l) => l.startsWith('pager: omp: ACP unavailable (bad init)')))
      assert.ok(messages(orch).some((m) => m.text === 'ok'))
      assert.equal(orch.room().runs[0]?.state, 'done')
    }),
  ))

test('PAGER_NO_ACP uses the one-shot path and stores no session', () =>
  withEnv('PAGER_NO_ACP', '1', () =>
    withOrch(async ({ orch, dataDir }) => {
      await orch.ask('omp', 'SESSION\nECHO plain')
      assert.ok(messages(orch).some((m) => m.text === 'plain'))
      assert.ok(!messages(orch).some((m) => m.text.startsWith('session:')))
      assert.equal(fs.existsSync(path.join(dataDir, 'agent-sessions.json')), false)
    }),
  ))

test('an agent that dies mid-run fails the run in a single message', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'ECHO partial\nFAIL')
    const [run] = orch.room().runs
    assert.equal(run?.state, 'failed')
    const mine = messages(orch).filter((m) => m.author === run?.id)
    assert.equal(mine.length, 1)
    assert.match(mine[0]?.text ?? '', /^partial\n\(failed: agent exited \(code 3\): boom\)$/)
  }))

test('stop kills a streaming run', () =>
  withOrch(async ({ orch }) => {
    const done = orch.ask('omp', 'ECHO started\nSLEEP 30000')
    await waitFor(() => messages(orch).some((m) => m.text === 'started'), 10_000, 'streaming started')
    orch.stop('all')
    await done
    assert.equal(orch.room().runs[0]?.state, 'cancelled')
    assert.ok(lines(orch).includes('pager: stopped'))
    assert.ok(messages(orch).some((m) => m.text === 'started\n(stopped)'))
  }))

test('delegation works over ACP', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'ASK claude: ECHO from-peer')
    // omp asks, claude answers, omp is resumed with the reply.
    assert.deepEqual(orch.room().runs.map((r) => r.agent), ['omp', 'claude', 'omp'])
    assert.ok(messages(orch).some((m) => m.text === 'from-peer'))
    assert.ok(messages(orch).some((m) => /^replies: \[claude-\w+\] from-peer/.test(m.text)))
  }))

test('commands() lists the slash commands an agent advertises', () =>
  withOrch(async ({ orch }) => {
    await orch.commands('omp')
    assert.ok(lines(orch).some((l) => l.startsWith('pager: omp slash commands:\n  /review  Review changes')))
  }))

test('agents without ACP get a hint instead of commands', async () => {
  const repo = makeRepo()
  const dataDir = tmp('pager-acp-data-')
  const orch = new Orchestrator({ dataDir, workdir: repo, adapters: { claude: { ...fake, acp: undefined } } })
  try {
    const toasts: string[] = []
    orch.on('toast', (t: { text: string }) => toasts.push(t.text))
    await orch.commands('claude')
    assert.match(toasts[0] ?? '', /claude has no ACP mode/)
  } finally {
    await orch.close()
    for (const d of [repo, dataDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  }
})
