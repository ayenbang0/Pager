import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ADAPTERS, findBinary, isAgentName } from './adapters.js'

test('hermes extract drops the trailing session footer only', () => {
  const out = 'The session store is fine.\nDone.\n\nsession_id: abc123\n\n'
  assert.equal(ADAPTERS.hermes.extract(out), 'The session store is fine.\nDone.')
  assert.equal(ADAPTERS.hermes.extract('ok\nSession: abc\n'), 'ok')
})

test('extract strips ANSI escapes', () => {
  assert.equal(ADAPTERS.claude.extract('\u001b[32mPAGER_OK\u001b[0m\n'), 'PAGER_OK')
})

test('isAgentName rejects prototype keys', () => {
  assert.ok(isAgentName('omp'))
  assert.ok(!isAgentName('constructor'))
  assert.ok(!isAgentName('toString'))
})

test('findBinary searches the given PATH', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-bin-'))
  const file = path.join(dir, process.platform === 'win32' ? 'tool.exe' : 'tool')
  fs.writeFileSync(file, '', { mode: 0o755 })
  const env = { PATH: dir, PATHEXT: '.EXE' }
  assert.equal((await findBinary('tool', env))?.toLowerCase(), file.toLowerCase())
  assert.equal(await findBinary('missing-tool', env), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})
