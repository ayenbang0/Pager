import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'
import { openInApp, pageUrl } from './appBrowser.js'

after(removeTmpDirs)

const BAD = ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x', 'https://exa mple.com', 'https://x.com/\n', 'not a url', '']

test('only http(s) URLs without whitespace are accepted', () => {
  assert.equal(pageUrl('https://example.com/a?b=c'), 'https://example.com/a?b=c')
  for (const bad of BAD) assert.equal(pageUrl(bad), undefined, bad)
})

test('the seam file receives accepted URLs and refused ones are never delivered', async () => {
  const file = path.join(tmpDir('pager-open-'), 'open.txt')
  process.env.PAGER_OPEN_FILE = file
  try {
    assert.equal(await openInApp('https://example.com/a?b=c'), true)
    for (const bad of BAD) assert.equal(await openInApp(bad), false, bad)
    assert.equal(fs.readFileSync(file, 'utf8'), 'https://example.com/a?b=c\n')
  } finally {
    delete process.env.PAGER_OPEN_FILE
  }
})

test('inside the desktop window the URL goes to its pipe with the token; outside it nothing opens', async () => {
  const saved = { ...process.env }
  delete process.env.PAGER_OPEN_FILE
  delete process.env.PAGER_DESKTOP_PIPE
  delete process.env.PAGER_DESKTOP_TOKEN
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\pager-open-test-${process.pid}` : path.join(tmpDir('pager-open-'), 'host.sock')
  const got: unknown[] = []
  const server = net.createServer((sock) => {
    sock.once('data', (d) => {
      const msg = JSON.parse(d.toString()) as { token: string; url: string }
      got.push(msg)
      sock.end(msg.token === 'secret' ? 'ok\n' : 'no\n')
    })
  })
  const { promise, resolve } = Promise.withResolvers<void>()
  server.listen(pipe, resolve)
  await promise
  try {
    assert.equal(await openInApp('https://example.com/'), false, 'not in the desktop window')
    process.env.PAGER_DESKTOP_PIPE = pipe
    process.env.PAGER_DESKTOP_TOKEN = 'secret'
    assert.equal(await openInApp('https://example.com/'), true)
    assert.deepEqual(got, [{ token: 'secret', type: 'open', url: 'https://example.com/' }])
    process.env.PAGER_DESKTOP_TOKEN = 'wrong'
    assert.equal(await openInApp('https://example.com/'), false, 'the window refused the token')
    process.env.PAGER_DESKTOP_PIPE = `${pipe}-nobody-home`
    assert.equal(await openInApp('https://example.com/'), false, 'no window listening')
  } finally {
    server.close()
    for (const k of ['PAGER_DESKTOP_PIPE', 'PAGER_DESKTOP_TOKEN']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
})
