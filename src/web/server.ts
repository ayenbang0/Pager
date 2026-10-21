import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { APP_CSS, APP_JS, INDEX_HTML } from './assets.js'
import { LOGO_PNG } from './logo.js'
import { docsData, statsData, type StatsSources } from './site.js'
import { parseBotInput, type StudioApi } from './studio.js'
import { STUDIO_CSS, STUDIO_HTML, STUDIO_JS } from './studioAssets.js'

const ASSETS: Record<string, [type: string, body: string]> = {
  '/': ['text/html; charset=utf-8', INDEX_HTML],
  '/app.css': ['text/css; charset=utf-8', APP_CSS],
  '/app.js': ['text/javascript; charset=utf-8', APP_JS],
  '/studio/': ['text/html; charset=utf-8', STUDIO_HTML],
  '/studio.css': ['text/css; charset=utf-8', STUDIO_CSS],
  '/studio.js': ['text/javascript; charset=utf-8', STUDIO_JS],
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const MAX_BODY = 64 * 1024

/** The whole request body as JSON; rejects when it is too big or not JSON. */
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('too big')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** The studio's changing routes. */
async function postStudio(route: string, req: http.IncomingMessage, studio: StudioApi): Promise<[number, unknown]> {
  const body = await readJson(req)
  const fail = (error: string): [number, unknown] => [400, { error }]
  if (route === '/api/studio/remove') {
    const b = body as { conv?: unknown; name?: unknown }
    return typeof b.conv === 'string' && typeof b.name === 'string' && studio.remove(b.conv, b.name) ? [200, { ok: true }] : fail('No such bot')
  }
  const cfg = parseBotInput(body)
  if (typeof cfg === 'string') return fail(cfg)
  const message = typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message.slice(0, 2000) : '@' + cfg.name + ' hello'
  if (route === '/api/studio/save') {
    const why = studio.save(cfg, (body as { create?: unknown }).create === true)
    return why === undefined ? [200, { ok: true }] : fail(why)
  }
  if (route === '/api/studio/preview') return [200, studio.preview(cfg, message)]
  if (route === '/api/studio/test') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('The bot took longer than 2 minutes')), 120_000)
    try {
      return [200, await studio.test(cfg, message, controller.signal)]
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    } finally {
      clearTimeout(timer)
    }
  }
  return [404, { error: 'not found' }]
}

/**
 * Serves the docs, the usage stats and the bot studio on 127.0.0.1. Every URL starts with a random token, so a web page in
 * your browser cannot reach it (DNS rebinding included: the Host header must match too). Reading is open to the page;
 * changing bots takes a POST with a JSON body and the `x-pager: studio` header, which a foreign page cannot send without
 * a CORS preflight this server never answers.
 */
export async function startDocsServer(src: StatsSources, studio?: StudioApi): Promise<{ url: string; close(): void }> {
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
      if (req.method !== 'GET' && req.method !== 'POST') return send(405, 'text/plain', 'method not allowed')
      if (req.headers.host !== host) return send(403, 'text/plain', 'forbidden')
      const m = /^\/([0-9a-f]+)(\/[^?#]*)?/.exec(req.url ?? '')
      if (m === null || !same(m[1]!, token)) return send(404, 'text/plain', 'not found')
      const route = m[2] ?? ''
      if (req.method === 'POST') {
        if (req.headers['x-pager'] !== 'studio' || !(req.headers['content-type'] ?? '').startsWith('application/json')) return send(403, 'text/plain', 'forbidden')
        if (studio === undefined) return send(503, 'application/json', JSON.stringify({ error: 'Bots need agents: start pager without --no-agents' }))
        void postStudio(route, req, studio).then(
          ([code, body]) => send(code, 'application/json', JSON.stringify(body)),
          () => send(400, 'application/json', JSON.stringify({ error: 'Bad request' })),
        )
        return
      }
      if (route === '/api/studio') {
        if (studio === undefined) return send(503, 'application/json', JSON.stringify({ error: 'Bots need agents: start pager without --no-agents' }))
        return send(200, 'application/json', JSON.stringify(studio.state()))
      }
      if (route === '') {
        res.writeHead(302, { location: `/${token}/` })
        return res.end()
      }
      if (route === '/api/docs') return send(200, 'application/json', JSON.stringify(docsData(src.version)))
      if (route === '/api/stats') return send(200, 'application/json', JSON.stringify(statsData(src)))
      if (route === '/logo.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        return res.end(LOGO_PNG)
      }
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
