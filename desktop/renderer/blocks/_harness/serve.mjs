// Harness server for the Database block: node serve.mjs [port]
// Serves desktop/renderer/ and forwards POST /rpc/database/<method> to the real main-process handler
// (desktop/electron/blocks/database.cjs, which spawns the worker under this node). Dialogs are faked into a temp dir.
import { createReadStream, mkdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeSample } from './make-sample.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const renderer = resolve(here, '..', '..')
const require = createRequire(import.meta.url)
const db = require('../../../electron/blocks/database.cjs')
const out = join(tmpdir(), 'pager-db-harness')
mkdirSync(out, { recursive: true })
const sample = makeSample(join(out, 'sample.db'))
const events = []
const ctx = {
  node: process.execPath,
  emit: (event, payload) => events.push({ event, payload }),
  dialog: {
    showSaveDialog: async (o) => ({ canceled: false, filePath: join(out, basename(o.defaultPath || 'saved.out')) }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [sample] }),
  },
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'POST' && url.pathname.startsWith('/rpc/database/')) {
    let body = ''
    for await (const c of req) body += c
    const method = url.pathname.slice('/rpc/database/'.length)
    res.setHeader('content-type', 'application/json')
    try {
      const fn = db.methods[method]
      if (!fn) throw new Error('No such method: ' + method)
      res.end(JSON.stringify({ ok: true, result: await fn(JSON.parse(body || '{}'), ctx) }))
    } catch (e) {
      res.end(JSON.stringify({ ok: false, error: { message: e.message, code: e.code } }))
    }
    return
  }
  if (url.pathname === '/config.json') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ sample, out, events: events.splice(0) }))
    return
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '')
  const file = resolve(renderer, rel || 'blocks/_harness/database.html')
  if (!file.startsWith(renderer)) { res.statusCode = 403; res.end('no'); return }
  try {
    const st = statSync(file)
    if (!st.isFile()) throw new Error('not a file')
    res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream')
    createReadStream(file).pipe(res)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})

const port = Number(process.argv[2]) || 5871
server.listen(port, '127.0.0.1', () => console.log(`database harness: http://127.0.0.1:${port}/blocks/_harness/database.html  (sample ${sample})`))
process.on('SIGINT', async () => { await db.dispose(); process.exit(0) })
