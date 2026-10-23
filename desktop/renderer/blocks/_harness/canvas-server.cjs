'use strict'
// Harness server for the Canvas block: serves desktop/renderer over http and bridges `POST /rpc/<method>` to the real
// main-process handler (desktop/electron/blocks/canvas.cjs), with handler events pushed to the page over SSE (`/events`).
//   node canvas-server.cjs [port]      env: CANVAS_DIR (default: a fresh temp dir)
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const handler = require('../../../electron/blocks/canvas.cjs')
const root = path.resolve(__dirname, '..', '..', '..', 'renderer')
const dir = process.env.CANVAS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pager-canvas-harness-'))
const port = Number(process.argv[2]) || 5178
const clients = new Set()
const ctx = {
  canvasDir: dir,
  emit(event, payload) {
    const data = `event: block\ndata: ${JSON.stringify({ event, payload })}\n\n`
    for (const c of clients) c.write(data)
  },
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': hi\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (url.pathname.startsWith('/rpc/') && req.method === 'POST') {
    const method = url.pathname.slice(5)
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json')
      try {
        const fn = Object.hasOwn(handler.methods, method) ? handler.methods[method] : null
        if (!fn) throw new Error(`no method ${method}`)
        const out = await fn(body ? JSON.parse(body) : undefined, ctx)
        res.end(JSON.stringify({ ok: true, result: out === undefined ? null : out }))
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e), code: e && e.code }))
      }
    })
    return
  }
  if (url.pathname === '/__dir') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ dir, files: fs.readdirSync(dir) }))
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  let file = path.resolve(root, rel)
  // the fonts live in desktop/assets (the stylesheet reaches them as ../../assets from blocks/)
  if (rel.startsWith('assets/')) file = path.resolve(root, '..', rel)
  if (!file.startsWith(path.resolve(root, '..'))) return res.writeHead(403).end()
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end('not found')
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(buf)
  })
}).listen(port, '127.0.0.1', () => console.log(`canvas harness on http://127.0.0.1:${port}/blocks/_harness/canvas.html  (data: ${dir})`))

process.on('SIGINT', () => {
  handler.dispose()
  process.exit(0)
})
