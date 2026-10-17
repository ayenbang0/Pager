import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AdapterSpec } from './adapters.js'
import { Orchestrator } from './orchestrator.js'

const fixture = fileURLToPath(new URL('./testAgent.js', import.meta.url))
const fake: AdapterSpec = { bin: process.execPath, args: (p) => [fixture, p], extract: (s) => s.trim() }
const fakes: Record<string, AdapterSpec> = { omp: fake, claude: fake, opencode: fake, hermes: fake }

function setup(): { orch: Orchestrator; cleanup: () => void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-pt-'))
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: repo })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 't')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-ptd-'))
  const orch = new Orchestrator({ dataDir, workdir: repo, adapters: fakes })
  return {
    orch,
    cleanup: () => {
      for (const d of [repo, dataDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test("cli runs the agent's own binary with the given arguments and posts the output", async () => {
  const { orch, cleanup } = setup()
  await orch.refresh()
  try {
    await orch.cli('omp', ['-e', 'console.log("models: a b"); console.error("warn")'])
    const texts = orch.messages(10).map((m) => `${m.authorName}: ${m.text}`)
    assert.ok(texts.some((t) => t.startsWith('you: $ omp -e')))
    assert.ok(texts.includes('omp: models: a b\nwarn'))
  } finally {
    await orch.close()
    cleanup()
  }
})

test('a non-zero exit is reported', async () => {
  const { orch, cleanup } = setup()
  await orch.refresh()
  try {
    await orch.cli('claude', ['-e', 'process.exit(4)'])
    assert.ok(orch.messages(10).some((m) => m.authorName === 'claude' && m.text === '(exit 4)'))
  } finally {
    await orch.close()
    cleanup()
  }
})

test('a task that is a slash command reaches the agent verbatim, without the pager preamble', async () => {
  const { orch, cleanup } = setup()
  await orch.refresh()
  try {
    await orch.ask('omp', '/review the last change')
    assert.ok(orch.messages(20).some((m) => m.text === 'raw: /review the last change'))
  } finally {
    await orch.close()
    cleanup()
  }
})

test('@name !args in the room runs the agent CLI instead of starting a task', async () => {
  const { orch, cleanup } = setup()
  await orch.refresh()
  try {
    orch.say('@omp !-e "console.log(1+1)"')
    await orch.close() // waits for the in-flight CLI call
    assert.ok(orch.messages(10).some((m) => m.authorName === 'omp' && m.text === '2'))
    assert.equal(orch.room().runs.length, 0)
  } finally {
    cleanup()
  }
})
