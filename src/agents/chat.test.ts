import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'
import { buildChatPrompt, runChatTurn } from './chat.js'
import type { AdapterSpec } from './run/adapters.js'
import { Registry } from './run/registry.js'

after(removeTmpDirs)

const fixture = fileURLToPath(new URL('./testing/testAgent.js', import.meta.url))
const fake: AdapterSpec = { bin: process.execPath, args: (p) => [fixture, p], extract: (s) => s.trim() }

function setup(): { registry: Registry; cwd: string } {
  const registry = new Registry(tmpDir('pager-chat-data-'))
  assert.equal(typeof registry.addInstance('omp'), 'object')
  return { registry, cwd: tmpDir('pager-chat-cwd-') }
}

test('a chat turn runs the CLI headless in the scratch folder: files land there and the reply comes back whole', async () => {
  const { registry, cwd } = setup()
  const prompt = buildChatPrompt({ agent: 'omp', user: 'you', cwd, history: [{ author: 'you', text: 'earlier' }], message: 'WRITE a.txt=1' })
  const res = await runChatTurn({ registry, adapters: { omp: fake } }, { agent: 'omp', prompt, cwd, signal: new AbortController().signal })
  assert.equal(res.ok, true)
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), '1')
  assert.equal(fs.existsSync(path.join(cwd, '.git')), false, 'no git repository is involved')
  const echo = await runChatTurn({ registry, adapters: { omp: fake } }, { agent: 'omp', prompt: buildChatPrompt({ agent: 'omp', user: 'you', cwd, history: [], message: 'ECHO hello **there**' }), cwd, signal: new AbortController().signal })
  assert.deepEqual(echo, { ok: true, text: 'hello **there**' })
})

test('the prompt names the agent and user, lists the history, and puts the new message after the marker', () => {
  const p = buildChatPrompt({ agent: 'omp', user: 'ann', cwd: '/s', history: [{ author: 'you', text: 'one' }, { author: 'omp', text: 'two' }], message: 'three' })
  assert.match(p, /^You are "omp"\. You are chatting with ann through pager's AI tab\. Reply in Markdown\. There is no git repository; your working directory \/s is a scratch folder/)
  assert.ok(p.includes('--- CHAT ---\nyou: one\nomp: two\n--- NEW MESSAGES ---\nthree'))
})

test('errors: an unknown teammate, a failing CLI, a missing binary and a stopped turn', async () => {
  const { registry, cwd } = setup()
  const signal = new AbortController().signal
  assert.deepEqual(await runChatTurn({ registry }, { agent: 'nobody', prompt: 'x', cwd, signal }), { ok: false, error: 'nobody is not a teammate' })
  const failing = await runChatTurn({ registry, adapters: { omp: fake } }, { agent: 'omp', prompt: buildChatPrompt({ agent: 'omp', user: 'you', cwd, history: [], message: 'FAIL' }), cwd, signal })
  assert.equal(failing.ok, false)
  assert.match(failing.ok ? '' : failing.error, /exit 3: boom/)
  const missing = await runChatTurn({ registry, adapters: { omp: { ...fake, bin: 'definitely-not-installed-xyz' } } }, { agent: 'omp', prompt: 'x', cwd, signal })
  assert.deepEqual(missing, { ok: false, error: 'definitely-not-installed-xyz was not found on PATH' })
  const controller = new AbortController()
  const slow = runChatTurn({ registry, adapters: { omp: fake } }, { agent: 'omp', prompt: buildChatPrompt({ agent: 'omp', user: 'you', cwd, history: [], message: 'SLEEP 5000' }), cwd, signal: controller.signal })
  setTimeout(() => controller.abort(new Error('stopped')), 300)
  assert.deepEqual(await slow, { ok: false, error: 'stopped' })
})
