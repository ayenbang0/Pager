import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { GEIST_MONO_WOFF2, GEIST_WOFF2 } from '../web/fonts.js'
import { LOGO_MARK_SVG } from '../web/logo.js'
import { clearedCookie, cookieValue, FailLimiter, HostPolicy, isWildcard, lanAddresses, newToken, sameOrigin, sameSecret, Sessions, sessionCookie } from './auth.js'
import { RemoteSession, type DaemonLink } from './session.js'
import { WEB_ASSETS } from './webAssets.js'
import { acceptUpgrade, upgradeProblem, type WsConnection } from './ws.js'

/** One browser message may be this big (input is capped lower); bigger closes the connection with 1009. */
export const MAX_MESSAGE = 256 * 1024
const MAX_BODY = 2048

export interface RemoteOptions {
  host: string
  /** 0 picks a free port. */
  port: number
  readOnly: boolean
  tls?: { cert: string | Buffer; key: string | Buffer }
  /** Opens one daemon connection (one per browser connection). */
  connect: () => Promise<DaemonLink>
  version: string
  /** Host names besides the loopback ones and this machine's, for a reverse proxy or a tailnet name. */
  allowHosts?: readonly string[]
  /** A fixed access token (tests); a random one by default. */
  token?: string
  /** The secret `pager serve --stop|--status` present. */
  control?: string
  maxConnections?: number
  pingMs?: number
  log?: (s: string) => void
  now?: () => number
}

export interface RemoteHandle {
  host: string
  port: number
  tls: boolean
  token: string
  control: string
  /** Where to open it, the token in the fragment (it never reaches a server log or a Referer). One per address a client can use. */
  urls: string[]
  stats(): { clients: number; sessions: number; startedAt: number; readOnly: boolean }
  close(): Promise<void>
  stopped: Promise<void>
}

const bracket = (h: string): string => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h)

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function csp(host: string): string {
  return ["default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'", `connect-src 'self' ws://${host} wss://${host}`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ')
}

const inflated = new Map<string, Buffer>()
const deflated = new Map<string, Buffer>()
const etags = new Map<string, string>()

const FIXED: Record<string, { body: Buffer; type: string }> = {
  '/favicon.svg': { body: Buffer.from(LOGO_MARK_SVG), type: 'image/svg+xml' },
  '/assets/fonts/geist.woff2': { body: GEIST_WOFF2, type: 'font/woff2' },
  '/assets/fonts/geist-mono.woff2': { body: GEIST_MONO_WOFF2, type: 'font/woff2' },
}

/** The asset, gzipped when the client takes it and inflated (once, cached) when not; `etag` names the content, not the encoding. */
function assetBody(route: string, gzip: boolean): { body: Buffer; type: string; etag: string } | undefined {
  let etag = etags.get(route)
  const fixed = Object.hasOwn(FIXED, route) ? FIXED[route] : undefined
  if (fixed !== undefined) {
    if (etag === undefined) etags.set(route, (etag = `"${createHash('sha1').update(fixed.body).digest('base64url').slice(0, 16)}"`))
    return { ...fixed, etag }
  }
  if (!Object.hasOwn(WEB_ASSETS, route)) return undefined
  const a = WEB_ASSETS[route]!
  let gz = deflated.get(route)
  if (gz === undefined) deflated.set(route, (gz = Buffer.from(a.gzip, 'base64')))
  if (etag === undefined) etags.set(route, (etag = `"${createHash('sha1').update(gz).digest('base64url').slice(0, 16)}"`))
  if (gzip) return { body: gz, type: a.type, etag }
  let raw = inflated.get(route)
  if (raw === undefined) inflated.set(route, (raw = zlib.gunzipSync(gz)))
  return { body: raw, type: a.type, etag }
}

/** The whole body of a small JSON request, or undefined when it is too big. */
async function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > MAX_BODY) return undefined
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function startRemoteServer(o: RemoteOptions): Promise<RemoteHandle> {
  const token = o.token ?? newToken()
  const control = o.control ?? newToken()
  const secure = o.tls !== undefined
  const now = o.now ?? Date.now
  const startedAt = now()
  const sessions = new Sessions(now)
  const perAddress = new FailLimiter(5, 60_000, 60_000, now)
  const everyone = new FailLimiter(40, 60_000, 60_000, now)
  const live = new Set<{ ws: WsConnection; link: DaemonLink }>()
  const maxConnections = o.maxConnections ?? 32
  let hosts: HostPolicy

  const server: http.Server | https.Server = secure ? https.createServer({ cert: o.tls!.cert, key: o.tls!.key, maxHeaderSize: 16 * 1024 }, (q, s) => void onRequest(q, s)) : http.createServer({ maxHeaderSize: 16 * 1024 }, (q, s) => void onRequest(q, s))
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000

  function send(res: http.ServerResponse, req: http.IncomingMessage, status: number, body: Buffer | string, type: string, extra: http.OutgoingHttpHeaders = {}): void {
    const buf = typeof body === 'string' ? Buffer.from(body) : body
    res.writeHead(status, {
      'content-type': type,
      'content-length': buf.length,
      'content-security-policy': csp(req.headers.host ?? ''),
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'cache-control': 'no-store',
      ...extra,
    })
    res.end(req.method === 'HEAD' ? undefined : buf)
  }

  const json = (res: http.ServerResponse, req: http.IncomingMessage, status: number, value: unknown, extra: http.OutgoingHttpHeaders = {}): void => send(res, req, status, JSON.stringify(value), 'application/json; charset=utf-8', extra)

  /** Seconds a failed-auth lockout still has to run for this client, or 0. */
  const locked = (addr: string): number => Math.max(perAddress.retryAfter(addr), everyone.retryAfter('*'))
  const failed = (addr: string): void => {
    perAddress.fail(addr)
    everyone.fail('*')
  }

  function authorized(req: http.IncomingMessage): boolean {
    return sessions.valid(cookieValue(req.headers.cookie))
  }

  async function onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await route(req, res)
    } catch (e) {
      o.log?.(`request failed: ${e instanceof Error ? e.message : String(e)}`)
      if (!res.headersSent) json(res, req, 500, { error: 'server error' })
      else res.destroy()
    }
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hosts.allows(req.headers.host)) return json(res, req, 403, { error: 'this host name is not allowed' })
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      return json(res, req, 400, { error: 'bad request' })
    }
    const addr = req.socket.remoteAddress ?? '?'
    const method = req.method ?? 'GET'

    if (method === 'POST') {
      if (path === '/api/auth') {
        if (!sameOrigin(req.headers.origin, req.headers.host)) return json(res, req, 403, { error: 'another site may not log in here' })
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return json(res, req, 415, { error: 'send JSON' })
        const wait = locked(addr)
        if (wait > 0) return json(res, req, 429, { error: 'too many failed attempts' }, { 'retry-after': String(wait) })
        const raw = await readBody(req)
        let given: unknown
        try {
          given = raw === undefined ? undefined : (JSON.parse(raw) as { token?: unknown }).token
        } catch {
          given = undefined
        }
        if (typeof given !== 'string' || given.length > 256 || !sameSecret(given, token)) {
          failed(addr)
          o.log?.(`refused a login from ${addr}`)
          return json(res, req, 401, { error: 'wrong token' })
        }
        return json(res, req, 200, { ok: true, readOnly: o.readOnly }, { 'set-cookie': sessionCookie(sessions.create(), secure) })
      }
      if (path === '/api/logout') {
        if (!sameOrigin(req.headers.origin, req.headers.host)) return json(res, req, 403, { error: 'another site may not log out here' })
        sessions.revoke(cookieValue(req.headers.cookie))
        return json(res, req, 200, { ok: true }, { 'set-cookie': clearedCookie(secure) })
      }
      if (path === '/api/control/stop') {
        if (!controlOk(req, res, addr)) return
        json(res, req, 200, { ok: true })
        setImmediate(() => void close())
        return
      }
      return json(res, req, 404, { error: 'not found' })
    }

    if (method !== 'GET' && method !== 'HEAD') return json(res, req, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD, POST' })

    if (path === '/api/session') {
      if (!authorized(req)) return json(res, req, 401, { error: 'log in with the link from pager serve' })
      return json(res, req, 200, { ok: true, readOnly: o.readOnly, version: o.version })
    }
    if (path === '/api/control/status') {
      if (!controlOk(req, res, addr)) return
      return json(res, req, 200, { ok: true, pid: process.pid, startedAt, readOnly: o.readOnly, clients: live.size, sessions: sessions.size })
    }
    const asset = assetBody(path, String(req.headers['accept-encoding'] ?? '').includes('gzip'))
    if (asset === undefined) return json(res, req, 404, { error: 'not found' })
    // Revalidated on every load (a 304 is cheap): a new pager must never serve its page with an older build's script.
    const headers = { 'cache-control': 'no-cache', etag: asset.etag, vary: 'Accept-Encoding', ...(asset.body === deflated.get(path) ? { 'content-encoding': 'gzip' } : {}) }
    if (req.headers['if-none-match'] === asset.etag) return send(res, req, 304, '', asset.type, headers)
    send(res, req, 200, asset.body, asset.type, headers)
  }

  /** The control routes: loopback peers only, no browser Origin, and the control secret. Failures count towards the lockout. */
  function controlOk(req: http.IncomingMessage, res: http.ServerResponse, addr: string): boolean {
    const wait = locked(addr)
    if (wait > 0) {
      json(res, req, 429, { error: 'too many failed attempts' }, { 'retry-after': String(wait) })
      return false
    }
    const auth = String(req.headers.authorization ?? '')
    const sameHost = LOOPBACK_ADDRS.has(addr) || addr === req.socket.localAddress // a peer on this machine, whichever of its addresses it dialled
    const ok = sameHost && req.headers.origin === undefined && auth.startsWith('Bearer ') && sameSecret(auth.slice(7), control)
    if (!ok) {
      failed(addr)
      json(res, req, 401, { error: 'not allowed' })
    }
    return ok
  }

  function refuse(socket: net.Socket, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  server.on('upgrade', (req: http.IncomingMessage, sock, head: Buffer) => {
    if (!(sock instanceof net.Socket)) return void sock.destroy()
    sock.on('error', () => {})
    void onUpgrade(req, sock, head)
  })

  async function onUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    let path = ''
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      // handled by the path check
    }
    if (path !== '/ws') return refuse(socket, '404 Not Found')
    if (!hosts.allows(req.headers.host)) return refuse(socket, '403 Forbidden')
    // A page on another site can open a WebSocket here with the user's cookies: only this very site's own origin gets in.
    if (!sameOrigin(req.headers.origin, req.headers.host)) return refuse(socket, '403 Forbidden')
    if (!authorized(req)) return refuse(socket, '401 Unauthorized')
    if (upgradeProblem(req) !== undefined) return refuse(socket, '400 Bad Request')
    if (live.size >= maxConnections) return refuse(socket, '503 Service Unavailable')
    let link: DaemonLink
    try {
      link = await o.connect()
    } catch (e) {
      o.log?.(`no daemon for a browser: ${e instanceof Error ? e.message : String(e)}`)
      return refuse(socket, '503 Service Unavailable')
    }
    if (socket.destroyed) return link.close()
    const ws = acceptUpgrade(req, socket, head, MAX_MESSAGE, o.pingMs)
    const entry = { ws, link }
    live.add(entry)
    ws.on('close', () => live.delete(entry))
    const session = new RemoteSession(ws, link, { readOnly: o.readOnly, version: o.version, ...(o.log === undefined ? {} : { log: o.log }) })
    session.start().catch((e: unknown) => {
      o.log?.(`session start: ${e instanceof Error ? e.message : String(e)}`)
      ws.close(1011, 'the session daemon did not answer')
    })
  }

  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(o.port, o.host, () => listening.resolve())
  try {
    await listening.promise
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`port ${o.port} on ${o.host} is already in use`, { cause: e })
    throw e
  }
  server.on('error', (e) => o.log?.(`server error: ${e.message}`))
  const port = (server.address() as net.AddressInfo).port
  hosts = new HostPolicy(o.host, port, o.allowHosts ?? [])

  const scheme = secure ? 'https' : 'http'
  const targets = isWildcard(o.host) ? ['127.0.0.1', ...lanAddresses()] : [o.host]
  const urls = targets.map((h) => `${scheme}://${bracket(h)}:${port}/#token=${token}`)

  const stopped = Promise.withResolvers<void>()
  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    closing ??= (async () => {
      for (const { ws, link } of live) {
        ws.close(1001, 'the server is stopping')
        link.close()
      }
      const down = Promise.withResolvers<void>()
      server.close(() => down.resolve())
      server.closeAllConnections()
      setTimeout(down.resolve, 1500).unref()
      await down.promise
      for (const { ws } of live) ws.terminate(1001)
      stopped.resolve()
    })()
    return closing
  }

  return { host: o.host, port, tls: secure, token, control, urls, stats: () => ({ clients: live.size, sessions: sessions.size, startedAt, readOnly: o.readOnly }), close, stopped: stopped.promise }
}

/** The PEM files `--tls-cert` and `--tls-key` name. */
export function readTls(certPath: string, keyPath: string): { cert: Buffer; key: Buffer } {
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }
}
