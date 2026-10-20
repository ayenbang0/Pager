import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { programOf, summarizeTerm, TermUsageLog } from './usage.js'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'

test('programOf keeps only the program name', () => {
  assert.equal(programOf('git commit -m "secret"'), 'git')
  assert.equal(programOf('C:\\tools\\Node.EXE script.js'), 'node')
  assert.equal(programOf('FOO=1 BAR=2 make all'), 'make')
  assert.equal(programOf('& .\\tool.ps1 a'), 'tool')
  assert.equal(programOf('   '), '')
})

test('summarizeTerm counts failures, ranks programs and buckets days', () => {
  const now = new Date(2026, 4, 10, 12).getTime()
  const day = 86_400_000
  const s = summarizeTerm(
    [
      { ts: now, program: 'git', ms: 10, exit: 0 },
      { ts: now - 1000, program: 'git', ms: 20, exit: 1 },
      { ts: now - day, program: 'npm', ms: 5, exit: 0 },
      { ts: now - 90 * day, program: 'old', ms: 1, exit: 0 },
    ],
    now,
  )
  assert.equal(s.total, 4)
  assert.equal(s.failed, 1)
  assert.deepEqual(s.top[0], { program: 'git', count: 2, failed: 1 })
  assert.equal(s.days.at(-1), 2)
  assert.equal(s.days.at(-2), 1)
  assert.equal(s.days.reduce((a, b) => a + b, 0), 3, 'the 90-day-old command is outside the window')
})

test('TermUsageLog round-trips and skips torn lines and empty programs', () => {
  const dir = tmpDir('pager-usage-')
  const log = new TermUsageLog(`${dir}/u.jsonl`)
  log.append({ ts: 1, program: 'ls', ms: 2, exit: 0 })
  log.append({ ts: 2, program: '', ms: 2, exit: 0 })
  assert.deepEqual(log.read(), [{ ts: 1, program: 'ls', ms: 2, exit: 0 }])
})

after(removeTmpDirs)
