import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'
import { controlAddress, sendControl, startControl, type RunRequest, type DocsRequest } from './control.js'

after(removeTmpDirs)

/** Sends a raw line and returns the one-line reply. */
async function raw(dir: string, line: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const s = net.createConnection(controlAddress(dir))
  let buf = ''
  s.on('connect', () => s.write(line))
  s.on('data', (d) => {
    buf += d.toString()
    if (buf.includes('\n')) {
      s.destroy()
      resolve(buf.trim())
    }
  })
  s.on('error', reject)
  return promise
}

test('a run request reaches the handler with its fields', async () => {
  const dir = tmpDir('pager-ctl-')
  const seen: (RunRequest | DocsRequest)[] = []
  const c = await startControl(dir, (r) => {
    seen.push(r)
    return { ok: true, id: 'terminal:2' }
  })
  try {
    const res = await sendControl(dir, { type: 'run', cwd: dir, command: 'echo hi' })
    assert.deepEqual(res, { kind: 'ok', reply: { ok: true, id: 'terminal:2' } })
    assert.deepEqual(seen, [{ type: 'run', cwd: dir, command: 'echo hi' }])
  } finally {
    c.close()
  }
})

test('ping is answered without the handler, and handler errors come back as replies', async () => {
  const dir = tmpDir('pager-ctl-')
  let calls = 0
  const c = await startControl(dir, () => {
    calls++
    throw new Error('boom')
  })
  try {
    const ping = await sendControl(dir, { type: 'ping' })
    assert.equal(ping.kind === 'ok' && ping.reply.ok, true)
    assert.equal(calls, 0)
    assert.deepEqual(await sendControl(dir, { type: 'run' }), { kind: 'ok', reply: { ok: false, error: 'boom' } })
  } finally {
    c.close()
  }
})

test('a wrong token is rejected and never reaches the handler', async () => {
  const dir = tmpDir('pager-ctl-')
  let calls = 0
  const c = await startControl(dir, () => {
    calls++
    return { ok: true }
  })
  try {
    assert.deepEqual(JSON.parse(await raw(dir, `${JSON.stringify({ token: 'nope', type: 'run' })}\n`)), { ok: false, error: 'unauthorized' })
    assert.deepEqual(JSON.parse(await raw(dir, '{{\n')), { ok: false, error: 'bad request' })
    assert.equal(calls, 0)
  } finally {
    c.close()
  }
})

test('with no pager listening the result is none, also after close removes the token', async () => {
  const dir = tmpDir('pager-ctl-')
  assert.deepEqual(await sendControl(dir, { type: 'ping' }), { kind: 'none' })
  const c = await startControl(dir, () => ({ ok: true }))
  assert.equal(fs.existsSync(path.join(dir, 'control.token')), true)
  c.close()
  assert.equal(fs.existsSync(path.join(dir, 'control.token')), false)
  assert.deepEqual(await sendControl(dir, { type: 'ping' }), { kind: 'none' })
})

test('a request line over 64 KiB is refused', async () => {
  const dir = tmpDir('pager-ctl-')
  let calls = 0
  const c = await startControl(dir, () => {
    calls++
    return { ok: true }
  })
  try {
    // The server may reset the connection while we are still writing, so a rejection is as good as a refusal.
    const res = await sendControl(dir, { type: 'run', command: 'x'.repeat(70 * 1024) }).catch(() => undefined)
    assert.notEqual(res?.kind === 'ok' && res.reply.ok, true)
    assert.equal(calls, 0)
  } finally {
    c.close()
  }
})

test('the address depends on the data dir and platform', () => {
  assert.match(controlAddress('C:\\a', 'win32'), /^\\\\\.\\pipe\\pager-[0-9a-f]{16}$/)
  assert.notEqual(controlAddress('/a', 'linux', '/tmp'), controlAddress('/b', 'linux', '/tmp'))
  assert.equal(controlAddress('C:\\A', 'win32'), controlAddress('c:\\a', 'win32'))
  assert.ok(controlAddress('/a', 'linux', '/tmp').endsWith('.sock'))
})

test('a docs request reaches the handler and the reply carries the url', async () => {
  const dir = tmpDir('pager-ctl-')
  const c = await startControl(dir, (r) => (r.type === 'docs' ? { ok: true, url: 'http://127.0.0.1:1/t/' } : { ok: false, error: 'no' }))
  try {
    assert.deepEqual(await sendControl(dir, { type: 'docs' }), { kind: 'ok', reply: { ok: true, url: 'http://127.0.0.1:1/t/' } })
  } finally {
    c.close()
  }
})
