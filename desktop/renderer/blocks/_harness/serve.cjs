'use strict'
// Dev harness for the board / tasks / screen blocks: serves desktop/renderer and forwards /rpc to the REAL main-process
// handlers (electron/blocks/<name>.cjs) so the pages in this folder exercise the same code the app runs.
//   node desktop/renderer/blocks/_harness/serve.cjs [port]      then open http://127.0.0.1:<port>/blocks/_harness/board.html
// Loopback only; a request must carry the harness header, which a foreign web page cannot send without a preflight.
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const RENDERER = path.resolve(__dirname, '..', '..')
const BLOCKS = path.resolve(RENDERER, '..', 'electron', 'blocks')
const ALLOWED = new Set(['board', 'tasks'])
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' }

const SAMPLE_TODO = `# TODO

Notes above the lanes are kept exactly as written.

## Todo

- [ ] Draft the launch post #docs 📅 2099-03-01
  - [x] outline
  - [ ] first draft
  - [ ] screenshots
- [ ] Fix flaky reconnect test #bug #core 📅 2020-01-15
- [ ] Wire the settings sheet to the daemon #core
- [ ] Update the changelog #docs
- plain bullets are not cards

## Doing

- [ ] Task manager block #core 📅 ${new Date().toISOString().slice(0, 10)}
  - [x] process sampler
  - [ ] confirmation dialog
- [ ] Review the board parser #review

## Done

- [x] Daemon protocol #core
- [x] Files sidebar #ui
`

const boardDir = path.join(os.tmpdir(), 'pager-board-harness')
fs.mkdirSync(boardDir, { recursive: true })
if (!fs.existsSync(path.join(boardDir, 'TODO.md'))) fs.writeFileSync(path.join(boardDir, 'TODO.md'), SAMPLE_TODO)

const clients = new Set() // { block, res }
const modules = new Map()
const load = (name) => {
  if (!ALLOWED.has(name)) throw new Error('Unknown block: ' + name)
  if (!modules.has(name)) modules.set(name, require(path.join(BLOCKS, name + '.cjs')))
  return modules.get(name)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const host = req.headers.host || ''
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return void res.writeHead(403).end()
  if (url.pathname === '/config') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ boardDir, platform: process.platform }))
    return
  }
  if (url.pathname === '/events') {
    const block = url.searchParams.get('block')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    res.write(': hi\n\n')
    const c = { block, res }
    clients.add(c)
    req.on('close', () => clients.delete(c))
    return
  }
  if (url.pathname === '/rpc' && req.method === 'POST') {
    if (req.headers['x-pager-harness'] !== '1') return void res.writeHead(403).end()
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const { block, method, args } = JSON.parse(raw)
      const mod = load(block)
      if (!Object.prototype.hasOwnProperty.call(mod.methods, method)) throw new Error('Unknown method: ' + method)
      const ctx = { emit: (event, payload) => {
        for (const c of clients) if (c.block === block) c.res.write(`data: ${JSON.stringify({ event, payload })}\n\n`)
      } }
      const result = await mod.methods[method](args || {}, ctx)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: result === undefined ? null : result }))
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String((e && e.message) || e) }))
    }
    return
  }
  // static files under desktop/renderer
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  const file = path.resolve(RENDERER, rel)
  if (path.relative(RENDERER, file).startsWith('..')) return void res.writeHead(403).end()
  fs.readFile(file, (err, data) => {
    if (err) return void res.writeHead(404).end('not found')
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(data)
  })
})

const port = Number(process.argv[2]) || 0
server.listen(port, '127.0.0.1', () => {
  console.log(`harness http://127.0.0.1:${server.address().port}/blocks/_harness/board.html  (board dir ${boardDir})`)
})
process.on('SIGINT', () => {
  for (const m of modules.values()) m.dispose && m.dispose()
  process.exit(0)
})
