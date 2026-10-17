import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { ADAPTERS, findBinary } from './adapters.js'
import { removeTmpDirs, tmpDir } from '../testutil.js'

const extract = (cli: string, out: string): string => (ADAPTERS[cli]?.extract ?? ((s: string) => s))(out)

test('hermes extract drops the trailing session footer only', () => {
  const out = 'The session store is fine.\nDone.\n\nsession_id: abc123\n\n'
  assert.equal(extract('hermes', out), 'The session store is fine.\nDone.')
  assert.equal(extract('hermes', 'ok\nSession: abc\n'), 'ok')
})

test('extract strips ANSI escapes', () => {
  assert.equal(extract('claude', '\u001b[32mPAGER_OK\u001b[0m\n'), 'PAGER_OK')
})

test('model and effort become each CLI\'s own flags, ahead of the prompt', () => {
  assert.deepEqual(ADAPTERS.omp?.args?.('hi', '/w', { model: 'm1', effort: 'high' }), ['-p', '--no-session', '--cwd', '/w', '--model', 'm1', '--thinking', 'high', 'hi'])
  assert.deepEqual(ADAPTERS.opencode?.args?.('hi', '/w', { model: 'p/m' }), ['run', '--auto', '--dir', '/w', '-m', 'p/m', 'hi'])
  assert.deepEqual(ADAPTERS.hermes?.args?.('hi', '/w', { effort: 'low' }), ['chat', '-Q', '--oneshot', '--yolo', '--in', '/w', '--reasoning', 'low', '-q', 'hi'])
  assert.ok(ADAPTERS.claude?.args?.('hi', '/w', { effort: 'high', mcpConfig: '{}' })?.join(' ').endsWith('--effort high --mcp-config {} hi'))
  assert.deepEqual(ADAPTERS.omp?.args?.('hi', '/w'), ['-p', '--no-session', '--cwd', '/w', 'hi'])
})

test('findBinary searches the given PATH', async () => {
  const dir = tmpDir('pager-bin-')
  const file = path.join(dir, process.platform === 'win32' ? 'tool.exe' : 'tool')
  fs.writeFileSync(file, '', { mode: 0o755 })
  const env = { PATH: dir, PATHEXT: '.EXE' }
  assert.equal((await findBinary('tool', env))?.toLowerCase(), file.toLowerCase())
  assert.equal(await findBinary('missing-tool', env), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

after(removeTmpDirs)
