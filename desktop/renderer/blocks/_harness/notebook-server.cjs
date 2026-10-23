'use strict'
// Dev harness for the notebook block: serves desktop/renderer and forwards /rpc to the REAL main-process handler
// (electron/blocks/notebook.cjs), so notebook.html exercises the code the app runs, kernel included.
//   node desktop/renderer/blocks/_harness/notebook-server.cjs [port]   then open http://127.0.0.1:<port>/blocks/_harness/notebook.html
// Loopback only; /rpc requires the harness header, which a foreign web page cannot send without a preflight.
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const RENDERER = path.resolve(__dirname, '..', '..')
const nb = require(path.resolve(RENDERER, '..', 'electron', 'blocks', 'notebook.cjs'))
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png' }

const dir = path.join(os.tmpdir(), 'pager-nb-harness')
fs.mkdirSync(dir, { recursive: true })

const cell = (type, source, extra = {}) => ({ cell_type: type, id: Math.random().toString(16).slice(2, 10), metadata: {}, source: source.split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l)), ...(type === 'code' ? { execution_count: null, outputs: [] } : {}), ...extra })
const TOUR = {
  cells: [
    cell('code', 'import sys, platform\nprint("Hello from Python", platform.python_version())\nprint("Running on", sys.platform)'),
    cell('code', 'import time, sys\nfrom tqdm import tqdm\nfor _ in tqdm(range(40), desc="Loading", ncols=72):\n    time.sleep(0.01)\nprint("done", file=sys.stderr)'),
    cell('markdown', '# Data\n\nA `pandas` frame renders as a table:'),
    cell('code', 'import pandas as pd\ndf = pd.DataFrame({\n    "city": ["Lisbon", "Oslo", "Kyoto", "Lima"],\n    "population": [545_000, 709_000, 1_464_000, 9_751_000],\n    "rainy_days": [99, 166, 128, 9],\n})\ndf'),
    cell('code', "%config InlineBackend.figure_format = 'retina'\nimport numpy as np\nimport matplotlib.pyplot as plt\nx = np.linspace(0, 4 * np.pi, 400)\nfig, ax = plt.subplots(figsize=(6, 2.6))\nax.plot(x, np.sin(x), label=\"sin\")\nax.legend()"),
    cell('code', '1 / 0'),
  ],
  metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' }, custom_unknown_field: { keep: true } },
  nbformat: 4,
  nbformat_minor: 5,
}
const tour = path.join(dir, 'tour.ipynb')
if (!fs.existsSync(tour)) fs.writeFileSync(tour, JSON.stringify(TOUR, null, 1) + '\n')

const clients = new Set()
const ctx = {
  emit(event, payload) {
    const line = `data: ${JSON.stringify({ event, payload })}\n\n`
    for (const res of clients) res.write(line)
  },
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return void res.writeHead(403).end()
  if (url.pathname === '/info') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ dir, tour, platform: process.platform }))
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    res.write(': hi\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (url.pathname.startsWith('/rpc/') && req.method === 'POST') {
    if (req.headers['x-pager-harness'] !== '1') return void res.writeHead(403).end()
    const method = url.pathname.slice(5)
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      if (!Object.prototype.hasOwnProperty.call(nb.methods, method)) throw new Error('Unknown method: ' + method)
      const result = await nb.methods[method](raw ? JSON.parse(raw) : {}, ctx)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: result === undefined ? null : result }))
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: { message: String((err && err.message) || err) } }))
    }
    return
  }
  const rel = decodeURIComponent(url.pathname === '/' ? '/blocks/_harness/notebook.html' : url.pathname)
  const file = path.resolve(RENDERER, '.' + rel)
  if (!file.startsWith(RENDERER + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.writeHead(404).end('not found')
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(file).pipe(res)
})

const port = Number(process.argv[2]) || 5178
server.listen(port, '127.0.0.1', () => console.log(`notebook harness: http://127.0.0.1:${port}/blocks/_harness/notebook.html  (files in ${dir})`))
process.on('SIGINT', () => (nb.dispose(), process.exit(0)))
