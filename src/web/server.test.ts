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

    const logo = await fetch(`${site.url}logo.svg`)
    assert.equal(logo.headers.get('content-type'), 'image/svg+xml')
    assert.match(await logo.text(), /^<svg [^>]*viewBox="0 0 64 64"/)
    assert.equal((await fetch(`${site.url}logo.png`)).status, 404, 'the pixel icon is gone')
    const mark = await fetch(`${site.url}logo-mark.svg`)
    assert.equal(mark.headers.get('content-type'), 'image/svg+xml')
    const markSvg = await mark.text()
    assert.match(markSvg, /^<svg [^>]*viewBox="0 0 64 64"/)
    assert.doesNotMatch(markSvg, /<rect width="64"/, 'the mark has no tile')

    for (const name of ['geist', 'geist-mono']) {
      const font = await fetch(`${site.url}fonts/${name}.woff2`)
      assert.equal(font.headers.get('content-type'), 'font/woff2')
      assert.match(font.headers.get('content-security-policy') ?? '', /font-src 'self'/)
      assert.deepEqual([...new Uint8Array(await font.arrayBuffer()).slice(0, 4)], [0x77, 0x4f, 0x46, 0x32], `${name} is woff2`)
    }
    const css = (await get(`${site.url}app.css`)).body + (await get(`${site.url}studio.css`)).body
    assert.match(css, /font-family:"Geist"/)
    assert.doesNotMatch(css, /pixelated|crisp-edges|steps\(/, 'one smooth style: no pixel rendering')

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
    assert.equal((await fetch(`${origin}/${'0'.repeat(36)}/fonts/geist.woff2`)).status, 404, 'the fonts are behind the token too')
    assert.equal((await fetch(`${origin}/fonts/geist.woff2`)).status, 404, 'no token, no font')
    assert.equal((await get(`${origin}/api/stats`)).status, 404, 'no token is refused')
    assert.equal((await get(`${site.url}api/stats`, { host: 'evil.example' })).status, 403, 'a foreign Host header (DNS rebinding) is refused')
  } finally {
    site.close()
  }
})

test('the studio changes bots only on a POST that carries the header, a JSON body and the token', async () => {
  const dir = tmpDir('pager-web-')
  const saved: { create: boolean; name: string; keywords: string[] }[] = []
  const conv = `grp:${'cd'.repeat(16)}`
  const studio = {
    state: () => ({ groups: [{ id: conv, title: '#t' }], backends: ['ollama'], bots: [], defaults: {}, limits: {} }) as never,
    save: (b: { name: string; keywords: string[] }, create: boolean) => {
      saved.push({ create, name: b.name, keywords: b.keywords })
      return b.name === 'taken' ? 'This group already has a bot named taken' : undefined
    },
    remove: () => true,
    preview: () => ({ system: 'S', chat: 'C' }),
    test: async () => ({ reply: 'hi' }),
  }
  const site = await startDocsServer({ dir, version: '1', chat: () => chat, agentUsages: () => [] }, studio)
  const post = (route: string, body: unknown, headers: Record<string, string> = { 'x-pager': 'studio', 'content-type': 'application/json' }): Promise<Response> =>
    fetch(`${site.url}${route}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const bot = { conv, name: 'scribe', backend: 'ollama', instructions: 'take notes', keywords: ['ship'], mode: 'mention' }
  try {
    assert.match((await get(`${site.url}studio/`)).body, /pager bot studio/)
    assert.equal((await post('api/studio/save', bot, { 'content-type': 'application/json' })).status, 403, 'no header: refused')
    assert.equal((await post('api/studio/save', bot, { 'x-pager': 'studio', 'content-type': 'text/plain' })).status, 403, 'not JSON: refused')
    assert.deepEqual(saved, [])
    assert.equal((await post('api/studio/save', { ...bot, create: true })).status, 200)
    assert.deepEqual(saved, [{ create: true, name: 'scribe', keywords: ['ship'] }])
    const bad = await post('api/studio/save', { ...bot, name: 'Bad Name' })
    assert.equal(bad.status, 400)
    assert.match(((await bad.json()) as { error: string }).error, /not a valid bot name/)
    const taken = await post('api/studio/save', { ...bot, name: 'taken' })
    assert.match(((await taken.json()) as { error: string }).error, /already has a bot/)
    assert.deepEqual(await (await post('api/studio/preview', bot)).json(), { system: 'S', chat: 'C' })
    assert.deepEqual(await (await post('api/studio/test', { ...bot, message: 'hello' })).json(), { reply: 'hi' })
    assert.equal((await post('api/studio/remove', { conv, name: 'scribe' })).status, 200)
    const rebinding = Promise.withResolvers<number>()
    const req = http.request(`${site.url}api/studio/save`, { method: 'POST', headers: { host: 'evil.example', 'x-pager': 'studio', 'content-type': 'application/json' } }, (res) => {
      res.resume()
      rebinding.resolve(res.statusCode ?? 0)
    })
    req.on('error', rebinding.reject)
    req.end('{}')
    assert.equal(await rebinding.promise, 403, 'a foreign Host header is refused on POST too')
    assert.equal(JSON.parse((await get(`${site.url}api/studio`)).body).groups[0].id, conv)
  } finally {
    site.close()
  }
  const off = await startDocsServer({ dir, version: '1', chat: () => chat, agentUsages: () => [] })
  try {
    assert.equal((await get(`${off.url}api/studio`)).status, 503, 'no agents, no studio')
  } finally {
    off.close()
  }
})
