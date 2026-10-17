// These tests drive real child processes and real git repositories, so a few waits poll real time (waitFor).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { waitFor } from '../testutil.js'
import type { AdapterSpec } from './adapters.js'
import { Orchestrator } from './orchestrator.js'

const oneShot = fileURLToPath(new URL('./testAgent.js', import.meta.url))
const acpAgent = fileURLToPath(new URL('./testAcpAgent.js', import.meta.url))
const fake: AdapterSpec = { bin: process.execPath, args: (p) => [oneShot, p], extract: (s) => s.trim(), acp: [acpAgent] }
const fakes: Record<string, AdapterSpec> = { omp: fake, claude: fake, opencode: fake, hermes: fake }

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
  await orch.refresh()
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

const messages = (orch: Orchestrator, scope?: string): { author: string; text: string }[] =>
  orch.messages(200, scope).map((m) => ({ author: m.authorName, text: m.text }))
const lines = (orch: Orchestrator): string[] => messages(orch).map((m) => `${m.author}: ${m.text}`)
const sessionIds = (dataDir: string): string[] =>
  Object.values(JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-sessions.json'), 'utf8')) as Record<string, Record<string, string>>).flatMap((v) =>
    Object.values(v),
  )

test('an ACP turn streams into one entry of the agent\'s tab and reports its tools', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'ECHO hi\nTOOL read a.ts')
    const [run] = orch.room().runs
    assert.ok(run)
    assert.deepEqual(messages(orch, 'omp').filter((m) => m.author === 'omp'), [{ author: 'omp', text: 'hi' }])
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
      await restarted.refresh()
      await restarted.ask('omp', 'SESSION')
      const third = messages(restarted).filter((m) => m.text.startsWith('session:')).at(-1)
      assert.match(third?.text ?? '', /loaded:false$/)
      assert.notEqual(sessionIds(dataDir)[0], 'bad-id')
    } finally {
      await restarted.close()
    }
  }))

test('two agents of one CLI keep separate sessions and workspaces', () =>
  withOrch(async ({ orch, dataDir }) => {
    assert.equal(typeof (await orch.addAgent('omp', 'ui')), 'object')
    await orch.ask('omp', 'SESSION')
    await orch.ask('ui', 'SESSION')
    const ids = sessionIds(dataDir)
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1])
    await orch.ask('omp', 'CWD')
    await orch.ask('ui', 'CWD')
    const cwds = messages(orch).flatMap((m) => (m.text.startsWith('cwd:') ? [m.text.slice(4)] : []))
    assert.notEqual(cwds[0], cwds[1])
  }))

test('replayed history from session/load is not shown, and an agent works in the same worktree every turn', () =>
  withOrch(async ({ orch, dataDir }) => {
    await orch.ask('omp', 'CWD')
    await orch.ask('omp', 'CWD')
    const cwds = messages(orch).flatMap((m) => (m.text.startsWith('cwd:') ? [m.text.slice(4)] : []))
    assert.equal(cwds.length, 2)
    assert.equal(cwds[0], cwds[1])
    assert.ok(cwds[0]?.startsWith(path.join(dataDir, 'worktrees')), cwds[0])
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

test('an agent that dies mid-turn fails the run in a single message', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'ECHO partial\nFAIL')
    const [run] = orch.room().runs
    assert.equal(run?.state, 'failed')
    const mine = messages(orch, 'omp').filter((m) => m.author === 'omp')
    assert.equal(mine.length, 1)
    assert.match(mine[0]?.text ?? '', /^partial\n\(failed: agent exited \(code 3\): boom\)$/)
  }))

test('stop kills a streaming turn', () =>
  withOrch(async ({ orch }) => {
    const done = orch.ask('omp', 'ECHO started\nSLEEP 30000')
    await waitFor(() => messages(orch).some((m) => m.text === 'started'), 10_000, 'streaming started')
    orch.stop('omp')
    await done
    assert.equal(orch.room().runs[0]?.state, 'cancelled')
    assert.ok(lines(orch).includes('pager: stopped'))
    assert.ok(messages(orch).some((m) => m.text === 'started\n(stopped)'))
  }))

test('teammates message each other over ACP through the tool set', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'PAGER send_message {"to":"claude","text":"ECHO from-peer","wait":true}')
    assert.deepEqual(orch.room().runs.map((r) => r.agent), ['omp', 'claude'])
    assert.ok(messages(orch, 'claude').some((m) => m.text === 'from-peer'))
    assert.ok(messages(orch, 'omp').some((m) => m.text.includes('pager send_message: ok from-peer')))
  }))

test('the tool server is attached to a fresh session and to a resumed one, and the client advertises questions', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'MCP\nCAPS')
    await orch.ask('omp', 'MCP')
    const mcp = messages(orch).filter((m) => m.text.includes('mcp:')).map((m) => m.text)
    assert.ok(mcp[0]?.includes('mcp:pager'), 'session/new')
    assert.ok(mcp[1]?.includes('mcp:pager'), 'session/load')
    assert.ok(messages(orch).some((m) => m.text.includes('"elicitation":{"form":{}}')))
  }))

test('an elicitation from the agent becomes a question for the user and the answer reaches the agent', () =>
  withOrch(async ({ orch }) => {
    const schema = { requestedSchema: { type: 'object', properties: { q0: { type: 'string', title: 'Which?', oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] } } } }
    const done = orch.ask('omp', `ELICIT ${JSON.stringify(schema)}`)
    await waitFor(() => orch.questions.views().length === 1, 15_000, 'question')
    const [view] = orch.questions.views()
    assert.ok(view)
    assert.equal(view.agent, 'omp')
    assert.deepEqual(view.fields[0]?.options.map((o) => o.value), ['a', 'b'])
    orch.questions.answer(view.id, { q0: 'b' })
    await done
    assert.ok(messages(orch).some((m) => m.text === 'elicit:{"action":"accept","content":{"q0":"b"}}'))
  }))

test('a cancelled elicitation tells the agent the user cancelled', () =>
  withOrch(async ({ orch }) => {
    const schema = { requestedSchema: { type: 'object', properties: { q0: { type: 'string', title: 'Which?', oneOf: [{ const: 'a', title: 'A' }] } } } }
    const done = orch.ask('omp', `ELICIT ${JSON.stringify(schema)}`)
    await waitFor(() => orch.questions.views().length === 1, 15_000, 'question')
    orch.questions.answer(orch.questions.views()[0]?.id ?? '', null)
    await done
    assert.ok(messages(orch).some((m) => m.text === 'elicit:{"action":"cancel"}'))
  }))

test('a configured model and effort are applied through session/set_config_option', () =>
  withOrch(async ({ orch }) => {
    orch.setModel('omp', 'smart-2')
    orch.setEffort('omp', 'high')
    await orch.ask('omp', 'CFG')
    assert.ok(messages(orch).some((m) => m.text === 'cfg:{"model":"smart-2","thinking":"high"}'))
    assert.deepEqual(orch.agentOptions('omp').find((o) => o.category === 'model')?.options.map((o) => o.value), ['fast-1', 'smart-2'])
  }))

test('a setting equal to the current value is not sent', () =>
  withOrch(async ({ orch }) => {
    orch.setModel('omp', 'fast-1')
    await orch.ask('omp', 'CFG')
    assert.ok(messages(orch).some((m) => m.text === 'cfg:{}'))
  }))

test('usage updates feed the context share, and a nearly full context compacts automatically', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'USAGE 90/100')
    await waitFor(() => messages(orch).some((m) => m.text === 'raw: /compact'), 20_000, 'automatic compaction')
    assert.ok(lines(orch).some((l) => l.startsWith('pager: omp context 90% — compacting')))
    await waitFor(() => orch.room().agents.every((a) => a.state === 'idle'), 15_000, 'idle')
    assert.equal(orch.room().agents.find((a) => a.name === 'omp')?.contextPct, undefined, 'the share is cleared until the agent reports again')
  }))

test('automatic compaction can be switched off', () =>
  withOrch(async ({ orch }) => {
    orch.registry.setAutoCompact(false)
    await orch.ask('omp', 'USAGE 90/100')
    assert.equal(orch.room().agents.find((a) => a.name === 'omp')?.contextPct, 0.9)
    assert.ok(!messages(orch).some((m) => m.text === 'raw: /compact'))
  }))

test('usage() runs the agent\'s own /usage and keeps the text', () =>
  withOrch(async ({ orch }) => {
    await orch.ask('omp', 'ECHO warm up')
    await orch.usage(['omp'])
    assert.equal(orch.usageOf('omp')?.text, 'raw: /usage')
  }))

test('commands() lists the slash commands an agent advertises, with argument hints', () =>
  withOrch(async ({ orch }) => {
    await orch.commands('omp')
    const text = lines(orch).find((l) => l.startsWith('pager: omp slash commands:')) ?? ''
    assert.match(text, /\/review {2}Review changes/)
    assert.match(text, /\/compact <focus> {2}Compact context/)
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
