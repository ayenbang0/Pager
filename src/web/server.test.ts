import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'
import { startDocsServer } from './server.js'

after(removeTmpDirs)

const get = (url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; type: string }> => {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string; type: string }>()
  http
    .get(url, { headers }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type']) }))
    })
    .on('error', reject)
  return promise
}

const chat = { contacts: 2, online: 1, groups: 1, pending: 0, unread: 3, sent: 10, received: 20, week: [0, 0, 0, 0, 0, 1, 2], busiest: null }

test('the site serves docs and stats only under its token, and stats come from the data dir', async () => {
  const dir = tmpDir('pager-web-')
  fs.writeFileSync(path.join(dir, 'agent-stats.jsonl'), `${JSON.stringify({ ts: Date.now(), agent: 'omp', cli: 'omp', ms: 1500, files: 2, tokensIn: 5, tokensOut: 7, stop: 'end_turn' })}\n`)
  fs.writeFileSync(path.join(dir, 'terminal-usage.jsonl'), `${JSON.stringify({ ts: Date.now(), program: 'git', ms: 40, exit: 1 })}\n`)
  const site = await startDocsServer({ dir, version: '9.9.9', chat: () => chat, agentUsages: () => [] })
  try {
    const home = await get(site.url)
    assert.equal(home.status, 200)
    assert.match(home.body, /<title>pager docs<\/title>/)

    const logo = await fetch(`${site.url}logo.png`)
    assert.equal(logo.headers.get('content-type'), 'image/png')
    assert.deepEqual([...new Uint8Array(await logo.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])

    const docs = JSON.parse((await get(`${site.url}api/docs`)).body) as { version: string; commands: { usage: string }[] }
    assert.equal(docs.version, '9.9.9')
    assert.ok(docs.commands.some((c) => c.usage === '/docs'), 'every slash command is listed, /docs included')

    const stats = JSON.parse((await get(`${site.url}api/stats`)).body) as {
      chat: { sent: number }
      agents: { turns: number; tokensIn: number; tokensOut: number; byAgent: { agent: string }[] }
      terminal: { total: number; failed: number; top: { program: string }[] }
    }
    assert.equal(stats.chat.sent, 10)
    assert.deepEqual([stats.agents.turns, stats.agents.tokensIn, stats.agents.tokensOut, stats.agents.byAgent[0]?.agent], [1, 5, 7, 'omp'])
    assert.deepEqual([stats.terminal.total, stats.terminal.failed, stats.terminal.top[0]?.program], [1, 1, 'git'])

    const origin = new URL(site.url).origin
    assert.equal((await get(`${origin}/${'0'.repeat(36)}/api/stats`)).status, 404, 'a wrong token is refused')
    assert.equal((await get(`${origin}/api/stats`)).status, 404, 'no token is refused')
    assert.equal((await get(`${site.url}api/stats`, { host: 'evil.example' })).status, 403, 'a foreign Host header (DNS rebinding) is refused')
  } finally {
    site.close()
  }
})
