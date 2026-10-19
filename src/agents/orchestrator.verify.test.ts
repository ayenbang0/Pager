// Drives real child processes and git repositories: the verify gate, conflict warnings and line counts as the orchestrator wires them.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Toast } from '../app/engine.js'
import { tmpDir } from '../testing/testutil.js'
import type { AdapterSpec } from './run/adapters.js'
import { Orchestrator } from './orchestrator.js'

const fixture = fileURLToPath(new URL('./testing/testAgent.js', import.meta.url))
const fake: AdapterSpec = { bin: process.execPath, args: (p) => [fixture, p], extract: (s) => s.trim() }
const fakes: Record<string, AdapterSpec> = { omp: fake, claude: fake, opencode: fake, hermes: fake }

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** Passes when ok.txt exists in the worktree. */
const CHECK = `"${process.execPath}" -e "process.exit(require('fs').existsSync('ok.txt') ? 0 : 7)"`

async function withOrch(fn: (ctx: { orch: Orchestrator; repo: string; toasts: Toast[] }) => Promise<void>): Promise<void> {
  const repo = tmpDir('pager-vrepo-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'tester')
  git(repo, 'config', 'user.email', 't@example.invalid')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  const dataDir = tmpDir('pager-vdata-')
  const orch = new Orchestrator({ dataDir, workdir: repo, adapters: fakes })
  const toasts: Toast[] = []
  orch.on('toast', (t: Toast) => toasts.push(t))
  await orch.refresh()
  orch.setReview(false)
  try {
    await fn({ orch, repo, toasts })
  } finally {
    await orch.close()
    for (const d of [repo, dataDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  }
}

const texts = (orch: Orchestrator): string[] => orch.messages(200).map((m) => m.text)
const merged = (repo: string): boolean => fs.existsSync(path.join(repo, 'a.txt'))

test('a failing verify is posted, blocks the merge, is readable with log, and --force overrides it', () =>
  withOrch(async ({ orch, repo, toasts }) => {
    await orch.setVerify(CHECK)
    await orch.ask('omp', 'WRITE a.txt=1')
    assert.ok(texts(orch).some((t) => t.includes('verify failed (exit 7')), 'failure posted after the turn')
    await orch.merge('omp')
    assert.equal(merged(repo), false)
    assert.match(toasts.at(-1)?.text ?? '', /Not merged: omp verify failed.*--force/)
    orch.showLog('omp')
    assert.ok(texts(orch).some((t) => t.startsWith('omp verify failed') && t.includes(CHECK)), 'log posts the kept result')
    await orch.merge('omp', true)
    assert.equal(merged(repo), true)
  }))

test('a passing verify lets the merge through without running it again', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.setVerify(CHECK)
    await orch.ask('omp', 'WRITE ok.txt=1\nWRITE a.txt=1')
    assert.equal(texts(orch).filter((t) => t.includes('verify passed')).length, 1)
    await orch.merge('omp')
    assert.equal(merged(repo), true)
    assert.equal(texts(orch).filter((t) => t.includes('verify passed')).length, 1, 'the result for this commit was reused')
  }))

test('merge runs the command first when it has not run on the current commit', () =>
  withOrch(async ({ orch, repo }) => {
    await orch.ask('omp', 'WRITE ok.txt=1\nWRITE a.txt=1')
    await orch.setVerify(CHECK)
    await orch.merge('omp')
    assert.ok(texts(orch).some((t) => t.startsWith('omp verify passed')))
    assert.equal(merged(repo), true)
    await orch.setVerify('off')
    assert.ok(texts(orch).includes('verify is off'))
  }))

test('/agent runs shows line counts, the verify word, and predicted conflicts', () =>
  withOrch(async ({ orch, toasts }) => {
    await orch.setVerify(CHECK)
    await orch.ask('omp', 'WRITE shared.txt=one\nWRITE ok.txt=1')
    await orch.ask('claude', 'WRITE shared.txt=two')
    assert.ok(toasts.some((t) => t.kind === 'warn' && t.text.includes('would conflict') && t.text.includes('shared.txt')), 'conflict warned')
    orch.list()
    const runs = texts(orch).filter((t) => /^(omp|claude)-\w+ {2}done/.test(t))
    assert.match(runs[0] ?? '', /^omp-\w+ {2}done {2}2 file\(s\) \+2\/-0 {2}verify: pass {2}conflicts: claude \(shared\.txt\)$/)
    assert.match(runs[1] ?? '', /^claude-\w+ {2}done {2}1 file\(s\) \+1\/-0 {2}verify: fail {2}conflicts: omp \(shared\.txt\)$/)
    assert.ok(texts(orch).some((t) => / changed 2 file\(s\) \(\+2\/-0\): /.test(t)), 'turn summary carries the counts')
  }))

test('an unchanged conflict is warned about once, not after every turn', () =>
  withOrch(async ({ orch, toasts }) => {
    await orch.ask('omp', 'WRITE shared.txt=one')
    await orch.ask('claude', 'WRITE shared.txt=two')
    await orch.ask('claude', 'WRITE other.txt=x')
    assert.equal(toasts.filter((t) => t.text.includes('would conflict')).length, 1)
  }))
