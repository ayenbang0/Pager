'use strict'
// Static server for the surface harness: node desktop/renderer/surface/_harness/serve.cjs [port]
// then open http://127.0.0.1:<port>/surface/_harness/index.html[?demo=all|mermaid|math|diff|image|html|xss]. Loopback only.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const RENDERER = path.resolve(__dirname, '..', '..')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '')
  const file = path.resolve(RENDERER, rel || 'surface/_harness/index.html')
  if (!file.startsWith(RENDERER + path.sep)) { res.statusCode = 403; res.end('no'); return }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; res.end('not found'); return }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream')
    res.setHeader('cache-control', 'no-store')
    fs.createReadStream(file).pipe(res)
  })
})

const port = Number(process.argv[2]) || 0
server.listen(port, '127.0.0.1', () => console.log(`surface harness http://127.0.0.1:${server.address().port}/surface/_harness/index.html`))
