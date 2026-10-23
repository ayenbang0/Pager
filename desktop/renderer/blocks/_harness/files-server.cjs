'use strict'
// Node shim for the Files block harness: serves desktop/renderer over HTTP and answers `POST /rpc` with the real main-process
// handler (desktop/electron/blocks/files.cjs) against a throwaway fixture repository (git index = the committed version).
//   node desktop/renderer/blocks/_harness/files-server.cjs [port]   then open http://127.0.0.1:<port>/blocks/_harness/files.html?path=CHANGELOG.md
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const path = require('node:path')
const zlib = require('node:zlib')
const { execFileSync } = require('node:child_process')

const block = require('../../../electron/blocks/files.cjs')
const rendererRoot = path.resolve(__dirname, '../..')

// ------------------------------------------------------------------ fixture
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-files-harness-'))
const repo = path.join(dir, 'pager')
const w = (rel, data) => {
  const f = path.join(repo, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, data)
}
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' })

function png(width, height) {
  const crc = (buf) => {
    let c = ~0
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type)
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, cr])
  }
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3
      raw[o] = Math.round(60 + (x / width) * 160); raw[o + 1] = Math.round(120 + (y / height) * 90); raw[o + 2] = 230
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function wav() {
  const n = 8000 * 2
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((i / 8000) * 2 * Math.PI * 440) * 9000), 44 + i * 2)
  return b
}

function pdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = 'BT /F1 22 Tf 30 110 Td (Pager PDF preview) Tj ET'
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offs = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const changelog = `# Changelog

All notable changes to pager are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.11.0] - 2026-10-22

### Added

- **Crash log**: an error nothing caught (a failed background task, a rejected promise) is written with a timestamp to \`crash.log\` in the
  data directory and shown as an error toast; pager keeps running instead of closing the window

### Changed

- A stray error still ends pager when it is not safe to go on: the terminal is gone (EPIPE, EIO), memory ran out, or twenty errors arrive within ten seconds
- If the interface itself throws while rendering, pager exits non-zero with the error and records it in \`crash.log\`

### Fixed

- \`/bot remove\` no longer closes pager when Windows keeps the bot's sandbox folder open (EPERM)
`
const changelogEdited = changelog.replace('## [1.11.0] - 2026-10-22', '## [1.11.0] - 2026-10-22\n\nA short note about this release.').replace('### Fixed', '### Fixed\n\n- A fixed thing nobody noticed')

fs.mkdirSync(repo, { recursive: true })
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'T')
const lan = `import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { test } from 'node:test'
import { startLan } from './lan.js'

/** A free UDP port: bind to 0, read it, close. */
async function freePort(): Promise<number> {
  const s = dgram.createSocket('udp4')
  await new Promise<void>((resolve) => s.bind(0, '127.0.0.1', resolve))
  const port = s.address().port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

const local = (port: number) => ({ address: '127.0.0.1', broadcast: false, port })

test('the first pager hosts, the second discovers it and gets the address', async () => {
  const port = await freePort()
  const first = await startLan(local(port))
  assert.equal(first.hosting, true)
  assert.equal(first.bootstrap.length, 1)
  const second = await startLan(local(port))
  assert.equal(second.hosting, false)
  assert.deepEqual(second.bootstrap, first.bootstrap)
  await second.stop()
  await first.stop()
  // the port is free again: a new host can bind it
  const again = await startLan(local(port))
  assert.equal(again.hosting, true)
  await again.stop()
})
`
w('CHANGELOG.md', changelog)
w('src/net/lan.test.ts', lan)
w('src/net/lan.js', 'export async function startLan(o) {\n  return { hosting: true, bootstrap: [], address: o.address, stop() {} }\n}\n')
w('README.md', '# Pager\n\nA terminal.\n')
w('notes.md', '---\ntitle: Notes\ntags: [a, b]\n---\n\n# Notes\n\n- [ ] write the harness\n- [x] vendor CodeMirror\n  - [ ] nested task\n\n> [!NOTE]\n> Callouts render with an icon and a title.\n\n> [!WARNING] Careful\n> This one has a custom title.\n\nInline math $E = mc^2$ and a block:\n\n$$\n\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\n$$\n\n| Name | Kind |\n| --- | --- |\n| files | block |\n| git | block |\n\n```mermaid\ngraph LR\n  A[Open] --> B{Edit?}\n  B -->|yes| C[Save]\n  B -->|no| D[Close]\n```\n\n```ts\nconst answer: number = 42 // fenced code is coloured\n```\n\n![sample](assets/sample.png)\n\nSee [the source](src/net/lan.test.ts) or [top](#notes).\n')
w('assets/sample.png', png(320, 200))
w('assets/tone.wav', wav())
w('assets/doc.pdf', pdf())
w('assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120"><rect width="120" height="120" rx="26" fill="#1b2a6b"/><path d="M40 90V32h26a18 18 0 0 1 0 36H40" fill="none" stroke="#7fd4ff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>\n')
w('assets/blob.bin', Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 7 + (i >> 3)) & 0xff)))
w('.editorconfig', 'root = true\n[*]\nindent_style = space\nindent_size = 2\n[*.md]\ntrim_trailing_whitespace = false\n')
git('add', '-A')
git('commit', '-q', '-m', 'init')
// working tree: edited after the commit so the change bar has something to show
w('CHANGELOG.md', changelogEdited)
w('src/net/lan.test.ts', lan.replace("assert.equal(first.hosting, true)", "assert.equal(first.hosting, true) // changed").replace("await again.stop()\n", "await again.stop()\n  assert.ok(true)\n"))
w('crlf.txt', 'one\r\ntwo\r\nthree\r\n')
w('utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('h\u00e9llo utf-16\n', 'utf16le')]))
w('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94, 0x0a]))

// ------------------------------------------------------------------ server
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
    res.end(JSON.stringify({ repo, dir }))
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
  console.log(`files harness: http://127.0.0.1:${server.address().port}/blocks/_harness/files.html  (fixture ${repo})`)
})
const stop = () => {
  block.dispose()
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
