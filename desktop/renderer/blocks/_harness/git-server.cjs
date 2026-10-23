'use strict'
// Node shim for the git block harness: serves desktop/renderer over HTTP and answers `POST /rpc` with the real
// main-process handler (desktop/electron/blocks/git.cjs) against a throwaway fixture repository.
//   node desktop/renderer/blocks/_harness/git-server.cjs [port]      then open http://127.0.0.1:<port>/blocks/_harness/git.html
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { makeFixture } = require('./git-fixture.cjs')

process.env.PAGER_HOME = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pager-home-'))
const block = require('../../../electron/blocks/git.cjs')
const rendererRoot = path.resolve(__dirname, '../..')
const fx = makeFixture()
const clients = new Set()
const ctx = { emit: (event, payload) => clients.forEach((res) => res.write(`data: ${JSON.stringify({ event, payload })}\n\n`)) }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'POST' && url.pathname === '/rpc') {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', async () => {
      try {
        const { method, args } = JSON.parse(body)
        const fn = block.methods[method]
        if (!fn) throw new Error(`no such method: ${method}`)
        const result = await fn(args ?? {}, ctx)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }))
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }))
      }
    })
    return
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(': ok\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (url.pathname === '/info') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ repo: fx.repo, dir: fx.dir }))
    return
  }
  const file = path.normalize(path.join(rendererRoot, decodeURIComponent(url.pathname)))
  if (!file.startsWith(rendererRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404)
    return res.end('not found')
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(file).pipe(res)
})

const port = Number(process.argv[2]) || 0
server.listen(port, '127.0.0.1', () => {
  const p = server.address().port
  console.log(`git harness: http://127.0.0.1:${p}/blocks/_harness/git.html  (fixture ${fx.repo})`)
})
const stop = () => {
  block.dispose()
  server.close()
  fx.cleanup()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
