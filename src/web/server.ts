import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { APP_CSS, APP_JS, INDEX_HTML } from './assets.js'
import { docsData, statsData, type StatsSources } from './site.js'

const ASSETS: Record<string, [type: string, body: string]> = {
  '/': ['text/html; charset=utf-8', INDEX_HTML],
  '/app.css': ['text/css; charset=utf-8', APP_CSS],
  '/app.js': ['text/javascript; charset=utf-8', APP_JS],
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Serves the docs and the usage stats on 127.0.0.1, read-only. Every URL starts with a random token, so a web page in
 * your browser cannot read it (DNS rebinding included: the Host header must match too).
 */
export async function startDocsServer(src: StatsSources): Promise<{ url: string; close(): void }> {
  const token = randomBytes(18).toString('hex')
  let host = ''
  const server = http.createServer((req, res) => {
    const send = (code: number, type: string, body: string): void => {
      res.writeHead(code, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      })
      res.end(body)
    }
    try {
      if (req.method !== 'GET') return send(405, 'text/plain', 'method not allowed')
      if (req.headers.host !== host) return send(403, 'text/plain', 'forbidden')
      const m = /^\/([0-9a-f]+)(\/[^?#]*)?/.exec(req.url ?? '')
      if (m === null || !same(m[1]!, token)) return send(404, 'text/plain', 'not found')
      const route = m[2] ?? ''
      if (route === '') {
        res.writeHead(302, { location: `/${token}/` })
        return res.end()
      }
      if (route === '/api/docs') return send(200, 'application/json', JSON.stringify(docsData(src.version)))
      if (route === '/api/stats') return send(200, 'application/json', JSON.stringify(statsData(src)))
      const asset = ASSETS[route]
      if (asset === undefined) return send(404, 'text/plain', 'not found')
      send(200, asset[0], asset[1])
    } catch {
      send(500, 'text/plain', 'error')
    }
  })
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
  await promise
  const port = (server.address() as { port: number }).port
  host = `127.0.0.1:${port}`
  server.on('error', () => {})
  server.unref()
  return {
    url: `http://${host}/${token}/`,
    close() {
      server.closeAllConnections()
      server.close()
    },
  }
}
