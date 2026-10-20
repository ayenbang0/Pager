import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { selftest, type SelfTestSpawn } from './selftest.js'

class Fake extends EventEmitter {
  stdout = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

const spawnWith = (script: (c: Fake) => void): SelfTestSpawn => (_f, _a, _o) => {
  const c = new Fake()
  queueMicrotask(() => script(c))
  return c as unknown as ReturnType<SelfTestSpawn>
}

test('an executable that prints ok and exits 0 passes', async () => {
  const args: string[][] = []
  const r = await selftest('Pager.exe', (f, a, o) => {
    args.push([f, ...a])
    return spawnWith((c) => {
      c.stdout.emit('data', Buffer.from('ok\n'))
      c.emit('close', 0)
    })(f, a, o)
  })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(args, [['Pager.exe', '--selftest']])
})

test('a spawn error (Smart App Control refusing the file) is reported with its code', async () => {
  const r = await selftest('Pager.exe', spawnWith((c) => c.emit('error', Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' }))))
  assert.deepEqual(r, { ok: false, reason: 'cannot start: UNKNOWN' })
})

test('a non-zero exit, or exit 0 without ok, fails', async () => {
  assert.equal((await selftest('x', spawnWith((c) => c.emit('close', 3)))).ok, false)
  assert.equal((await selftest('x', spawnWith((c) => c.emit('close', 0)))).ok, false)
})

test('a host that never answers is killed after the timeout', async () => {
  const c = new Fake()
  // Short real timeout: the behavior under test is the timer itself.
  const r = await selftest('x', () => c as unknown as ReturnType<SelfTestSpawn>, 20)
  assert.equal(r.ok, false)
  assert.equal(c.killed, true)
})
