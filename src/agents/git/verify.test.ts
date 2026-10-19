import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir } from '../../testing/testutil.js'
import { mergeGate, outputTail, runVerify, VerifyStore, verifyHeadline, verifyReport, verifyWord, type VerifyResult } from './verify.js'

after(removeTmpDirs)

const node = (script: string): string => `"${process.execPath}" -e "${script}"`

const result = (over: Partial<VerifyResult> = {}): VerifyResult => ({
  ok: true,
  code: 0,
  timedOut: false,
  output: '',
  truncated: false,
  ms: 1200,
  sha: 'aaa',
  command: 'npm test',
  at: 0,
  ...over,
})

test('a passing command is ok and its output is kept', async () => {
  const r = await runVerify(node("console.log('all good')"), tmpDir('pager-verify-'))
  assert.equal(r.ok, true)
  assert.equal(r.code, 0)
  assert.equal(r.timedOut, false)
  assert.match(r.output, /all good/)
})

test('a failing command reports its exit code and stderr; the command runs in the given directory', async () => {
  const dir = tmpDir('pager-verify-')
  const r = await runVerify(node("console.error('boom in '+require('path').basename(process.cwd())); process.exit(3)"), dir)
  assert.equal(r.ok, false)
  assert.equal(r.code, 3)
  assert.ok(r.output.includes(`boom in ${path.basename(dir)}`))
})

// A real child process and a real (short) timeout: the kill path of the runner is what is under test.
test('a command that outlives the timeout is killed and reported as timed out', async () => {
  const started = Date.now()
  const r = await runVerify(node("console.log('started'); setInterval(() => {}, 1000)"), tmpDir('pager-verify-'), { timeoutMs: 800 })
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  assert.ok(Date.now() - started < 15_000, 'returned long before the interval would end')
  assert.match(verifyHeadline(r, 800), /timed out after 1s/)
})

test('output is capped to its tail', async () => {
  const r = await runVerify(node("for (let i = 0; i < 2000; i++) console.log('line ' + i); console.log('THE END')"), tmpDir('pager-verify-'), { maxOutput: 500 })
  assert.equal(r.ok, true)
  assert.ok(r.output.length <= 500)
  assert.equal(r.truncated, true)
  assert.match(r.output, /THE END\s*$/)
  assert.ok(!r.output.includes('line 0\n'))
})

test('output that fits is not marked truncated, and terminal escapes are stripped', async () => {
  const r = await runVerify(node("process.stdout.write('\\x1b[31mred\\x1b[0m\\n')"), tmpDir('pager-verify-'), { maxOutput: 500 })
  assert.equal(r.truncated, false)
  assert.equal(r.output.trim(), 'red')
})

test('a command that cannot start in a missing directory fails instead of throwing', async () => {
  const r = await runVerify(node('0'), path.join(tmpDir('pager-verify-'), 'nope'))
  assert.equal(r.ok, false)
  assert.equal(r.code, null)
})

test('headlines and reports show the verdict, with the output tail only for failures', () => {
  const pass = result({ output: 'ok 1\nok 2\n' })
  assert.equal(verifyHeadline(pass), 'verify passed (1.2s)')
  assert.equal(verifyReport(pass), 'verify passed (1.2s)')
  const fail = result({ ok: false, code: 1, output: Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') })
  const report = verifyReport(fail)
  assert.ok(report.startsWith('verify failed (exit 1, 1.2s)\n'))
  assert.ok(report.endsWith('l29') && report.includes('l15') && !report.includes('l14\n'))
  assert.equal(verifyWord(pass), 'pass')
  assert.equal(verifyWord(fail), 'fail')
  assert.equal(verifyWord(result({ ok: false, code: null, timedOut: true })), 'timed out')
  assert.equal(outputTail('x'.repeat(5000), 15, 100).length, 100)
})

test('merge gate: no command or --force allows; unseen or stale commits run first; a failure on this commit blocks', () => {
  const base = { command: 'npm test', head: 'aaa', force: false }
  assert.deepEqual(mergeGate({ ...base, command: undefined, last: undefined }), { action: 'allow' })
  assert.deepEqual(mergeGate({ ...base, force: true, last: result({ ok: false, code: 1 }) }), { action: 'allow' })
  assert.deepEqual(mergeGate({ ...base, last: undefined }), { action: 'run' })
  assert.deepEqual(mergeGate({ ...base, last: result({ sha: 'bbb' }) }), { action: 'run' }, 'passed on another commit')
  assert.deepEqual(mergeGate({ ...base, last: result({ command: 'npm run lint' }) }), { action: 'run' }, 'ran a different command')
  assert.deepEqual(mergeGate({ ...base, last: result() }), { action: 'allow' })
  const blocked = mergeGate({ ...base, last: result({ ok: false, code: 2 }) })
  assert.equal(blocked.action, 'block')
  assert.match(blocked.action === 'block' ? blocked.reason : '', /verify failed \(exit 2/)
  assert.equal(mergeGate({ ...base, last: result({ ok: false, code: null, timedOut: true }) }).action, 'block')
})

test('the verify command is kept per repository and survives a restart', () => {
  const dir = tmpDir('pager-verify-store-')
  const file = path.join(dir, 'data', 'agents-verify.json')
  const store = new VerifyStore(file)
  assert.equal(store.get('/repo/a'), undefined)
  assert.equal(store.set('/repo/a', 'npm test'), undefined)
  assert.equal(store.set('/repo/b', 'make check'), undefined)
  const again = new VerifyStore(file)
  assert.equal(again.get('/repo/a'), 'npm test')
  assert.equal(again.get('/repo/b'), 'make check')
  again.set('/repo/a', undefined)
  assert.equal(new VerifyStore(file).get('/repo/a'), undefined)
  assert.equal(new VerifyStore(file).get('/repo/b'), 'make check')
  fs.writeFileSync(file, 'not json')
  assert.equal(new VerifyStore(file).get('/repo/b'), undefined)
})
