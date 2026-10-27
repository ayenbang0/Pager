import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import type net from 'node:net'
import { waitFor } from '../testing/testutil.js'
import zlib from 'node:zlib'
import { describe, test } from 'node:test'
import type { DaemonState } from '../daemon/protocol.js'
import { parseArgs } from '../app/args.js'
import { parseServeArgs } from './args.js'
import { FailLimiter, HostPolicy, Sessions, cookieValue, sameOrigin, sameSecret } from './auth.js'
import { MAX_MESSAGE, startRemoteServer, type RemoteHandle, type RemoteOptions } from './server.js'
import { MAX_INPUT, type DaemonLink } from './session.js'
import { FrameParser, OP_BINARY, OP_CLOSE, OP_CONT, OP_PING, OP_PONG, OP_TEXT, WsError, encodeFrame, type WsFrame } from './ws.js'

// ---------------------------------------------------------------- a fake daemon connection

const STATE = {
  sessions: [{ id: 's1', name: 'Session 1', tabs: [{ id: 't1', title: 'home', root: { type: 'pane', paneId: '5' }, focus: '5' }], activeTab: 't1' }],
  panes: [{ id: '5', kind: 'shell', title: 'home', cwd: '/home', cols: 80, rows: 24, state: 'running' }],
  activeSession: 's1',
  clients: 0,
  settings: { secret: 'must not reach a browser' },
} as unknown as DaemonState

class FakeLink extends EventEmitter implements DaemonLink {
  calls: Array<{ type: string; args: Record<string, unknown> }> = []
  inputs: Array<{ paneId: string; data: string | Uint8Array }> = []
  closed = false
  paused = 0
  /** Output delivered in the very tick that the attach answer is, as one socket chunk would. */
  lateOutput: Buffer | undefined
  readonly alive = true

  call<T>(type: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ type, args })
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    setImmediate(() => {
      switch (type) {
        case 'state':
          return resolve(STATE)
        case 'pane.attach':
          resolve({ replay: Buffer.from('replayed screen').toString('base64'), cols: 80, rows: 24, seq: 15 })
          if (this.lateOutput !== undefined) this.emit('data', Number(args.paneId), this.lateOutput)
          return
        case 'pane.capture':
          return resolve({ text: 'captured text', cols: 80, rows: 24, cursor: { x: 0, y: 0 }, alternate: false })
        case 'pane.run':
          resolve({ paneId: '9' })
          return void setImmediate(() => setImmediate(() => this.emit('event', { event: 'command_finished', paneId: '9', exit: 3 })))
        case 'tab.new':
          return resolve({ sessionId: 's1', tabId: 't2', paneId: '6' })
        case 'pane.fail':
          return reject(new Error('boom'))
        default:
          return resolve(undefined)
      }
    })
    return promise as Promise<T>
  }

  input(paneId: string, data: string | Uint8Array): void {
    this.inputs.push({ paneId, data })
  }
  pause(): void {
    this.paused++
  }
  resume(): void {}
  close(): void {
    this.closed = true
    this.emit('close')
  }
  count(type: string): number {
    return this.calls.filter((c) => c.type === type).length
  }
}

// ---------------------------------------------------------------- http and websocket test clients

interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

function request(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  const { promise, resolve, reject } = Promise.withResolvers<Res>()
  const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    const chunks: Buffer[] = []
    res.on('data', (c: Buffer) => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
  })
  r.on('error', reject)
  r.end(body)
  return promise
}

class TestWs {
  readonly messages: Array<string | Buffer> = []
  closeCode: number | undefined
  private readonly parser = new FrameParser(64 * 1024 * 1024, false)
  private readonly waiters: Array<() => void> = []

  constructor(
    readonly socket: net.Socket,
    head: Buffer,
  ) {
    socket.on('data', (c: Buffer) => this.onData(c))
    socket.on('close', () => this.wake())
    if (head.length > 0) this.onData(head)
  }

  private onData(c: Buffer): void {
    for (const f of this.parser.push(c)) {
      if (f.opcode === OP_TEXT) this.messages.push(f.payload.toString('utf8'))
      else if (f.opcode === OP_BINARY) this.messages.push(f.payload)
      else if (f.opcode === OP_CLOSE) this.closeCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005
      else if (f.opcode === OP_PING) this.socket.write(encodeFrame(OP_PONG, f.payload, true))
    }
    this.wake()
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  async until<T>(pick: () => T | undefined, ms = 3000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const v = pick()
      if (v !== undefined) return v
      if (Date.now() > end) throw new Error('timed out waiting for a websocket message')
      const { promise, resolve } = Promise.withResolvers<void>()
      this.waiters.push(resolve)
      setTimeout(resolve, 50)
      await promise
    }
  }

  /** The first not-yet-taken JSON message matching `t` (and `id` when given). */
  json(t: string, id?: number): Promise<Record<string, unknown>> {
    return this.until(() => {
      const i = this.messages.findIndex((m) => {
        if (typeof m !== 'string') return false
        const j = JSON.parse(m) as { t?: string; id?: number }
        return j.t === t && (id === undefined || j.id === id)
      })
      return i < 0 ? undefined : (JSON.parse(this.messages.splice(i, 1)[0] as string) as Record<string, unknown>)
    })
  }

  binary(): Promise<Buffer> {
    return this.until(() => {
      const i = this.messages.findIndex((m) => typeof m !== 'string')
      return i < 0 ? undefined : (this.messages.splice(i, 1)[0] as Buffer)
    })
  }

  send(v: unknown): void {
    this.socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify(v)), true))
  }

  raw(buf: Buffer): void {
    this.socket.write(buf)
  }

  closed(): Promise<number> {
    return this.until(() => (this.closeCode !== undefined ? this.closeCode : undefined))
  }

  end(): void {
    this.socket.destroy()
  }
}

/** Opens `/ws`: the websocket, or the HTTP status the server refused with. */
function connectWs(port: number, headers: Record<string, string>): Promise<TestWs | number> {
  const { promise, resolve, reject } = Promise.withResolvers<TestWs | number>()
  const r = http.request({
    host: '127.0.0.1',
    port,
    path: '/ws',
    headers: { host: `127.0.0.1:${port}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'), ...headers },
  })
  r.on('upgrade', (_res, socket, head) => resolve(new TestWs(socket, head)))
  r.on('response', (res) => {
    res.resume()
    resolve(res.statusCode ?? 0)
  })
  r.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve(0) : reject(e)))
  r.end()
  return promise
}

// ---------------------------------------------------------------- harness

const TOKEN = 'a-test-token-of-some-length-0123456789'

interface Rig {
  srv: RemoteHandle
  links: FakeLink[]
  port: number
  origin: string
  login(): Promise<string>
  open(extra?: Record<string, string>): Promise<TestWs>
}

async function withServer(opts: Partial<RemoteOptions>, body: (rig: Rig) => Promise<void>): Promise<void> {
  const links: FakeLink[] = []
  const srv = await startRemoteServer({
    host: '127.0.0.1',
    port: 0,
    readOnly: false,
    version: 'test',
    token: TOKEN,
    pingMs: 60_000,
    connect: async () => {
      const l = new FakeLink()
      links.push(l)
      return l
    },
    ...opts,
  })
  const port = srv.port
  const origin = `http://127.0.0.1:${port}`
  const login = async (): Promise<string> => {
    const r = await request(port, 'POST', '/api/auth', { origin, 'content-type': 'application/json' }, JSON.stringify({ token: TOKEN }))
    assert.equal(r.status, 200)
    return String(r.headers['set-cookie']?.[0]).split(';')[0]!
  }
  const open = async (extra: Record<string, string> = {}): Promise<TestWs> => {
    const cookie = await login()
    const ws = await connectWs(port, { origin, cookie, ...extra })
    assert.ok(typeof ws !== 'number', `websocket refused with ${String(ws)}`)
    await ws.json('state')
    return ws
  }
  try {
    await body({ srv, links, port, origin, login, open })
  } finally {
    await srv.close()
  }
}

// ---------------------------------------------------------------- tests

describe('websocket framing', () => {
  const mk = (op: number, payload: Buffer, fin = true): Buffer => encodeFrame(op, payload, true, fin)

  test('masked frames of every length class decode, however the bytes arrive', () => {
    const small = Buffer.from('héllo')
    const mid = Buffer.alloc(300, 7)
    const big = Buffer.alloc(70_000, 9)
    const bytes = Buffer.concat([mk(OP_TEXT, small), mk(OP_BINARY, mid), mk(OP_BINARY, big)])
    const p = new FrameParser(1 << 20)
    const got: WsFrame[] = []
    for (let i = 0; i < bytes.length; i += 4099) got.push(...p.push(bytes.subarray(i, i + 4099)))
    assert.equal(got.length, 3)
    assert.equal(got[0]!.payload.toString(), 'héllo')
    assert.deepEqual(got[1]!.payload, mid)
    assert.deepEqual(got[2]!.payload, big)
    assert.equal(new FrameParser(1 << 20).push(bytes).length, 3)
  })

  test('an unmasked client frame, reserved bits, unknown opcodes and bad control frames are protocol errors', () => {
    const code = (b: Buffer): number | undefined => {
      try {
        new FrameParser(1000).push(b)
      } catch (e) {
        return e instanceof WsError ? e.code : -1
      }
      return undefined
    }
    assert.equal(code(encodeFrame(OP_TEXT, Buffer.from('x'))), 1002)
    const rsv = mk(OP_TEXT, Buffer.from('x'))
    rsv[0]! |= 0x40
    assert.equal(code(rsv), 1002)
    assert.equal(code(mk(3, Buffer.from('x'))), 1002)
    assert.equal(code(mk(OP_PING, Buffer.from('x'), false)), 1002, 'a control frame is never fragmented')
    assert.equal(code(mk(OP_PING, Buffer.alloc(126))), 1002)
  })

  test('a frame declaring too many bytes is refused before it is buffered', () => {
    const head = Buffer.alloc(14)
    head[0] = 0x82
    head[1] = 0x80 | 127
    head.writeBigUInt64BE(10n ** 12n, 2)
    assert.throws(() => new FrameParser(1000).push(head), (e: unknown) => e instanceof WsError && e.code === 1009)
    const two = Buffer.alloc(8)
    two[0] = 0x82
    two[1] = 0x80 | 126
    two.writeUInt16BE(2000, 2)
    assert.throws(() => new FrameParser(1000).push(two), (e: unknown) => e instanceof WsError && e.code === 1009)
  })
})

describe('auth helpers', () => {
  test('secrets compare by value; cookies parse', () => {
    assert.equal(sameSecret('abc', 'abc'), true)
    assert.equal(sameSecret('abc', 'abd'), false)
    assert.equal(sameSecret('abc', 'abcd'), false)
    assert.equal(cookieValue('a=1; pager_session=xyz; b=2'), 'xyz')
    assert.equal(cookieValue('a=1'), undefined)
    assert.equal(cookieValue(undefined), undefined)
  })

  test('Host policy: loopback names and the bound address with the port; strangers and wrong ports are refused', () => {
    const lo = new HostPolicy('127.0.0.1', 8377)
    for (const h of ['127.0.0.1:8377', 'localhost:8377', '[::1]:8377', 'LOCALHOST:8377']) assert.equal(lo.allows(h), true, h)
    for (const h of ['evil.example:8377', 'evil.example', '127.0.0.1:1', '127.0.0.1', undefined, '192.168.1.5:8377']) assert.equal(lo.allows(h), false, String(h))
    const lan = new HostPolicy('0.0.0.0', 9, ['box.tail.ts.net'], { hostname: 'mybox', addresses: ['192.168.1.5'] })
    for (const h of ['192.168.1.5:9', 'mybox:9', 'mybox.local:9', 'box.tail.ts.net', 'box.tail.ts.net:443']) assert.equal(lan.allows(h), true, h)
    assert.equal(lan.allows('192.168.1.6:9'), false)
  })

  test('Origin must be this very site', () => {
    assert.equal(sameOrigin('http://127.0.0.1:8377', '127.0.0.1:8377'), true)
    assert.equal(sameOrigin('https://localhost:8377', 'localhost:8377'), true)
    assert.equal(sameOrigin('http://evil.example', '127.0.0.1:8377'), false)
    assert.equal(sameOrigin('http://127.0.0.1:8378', '127.0.0.1:8377'), false)
    assert.equal(sameOrigin('http://127.0.0.1:8377.evil.example', '127.0.0.1:8377'), false)
    assert.equal(sameOrigin('null', '127.0.0.1:8377'), false)
    assert.equal(sameOrigin(undefined, '127.0.0.1:8377'), false)
    assert.equal(sameOrigin('file://', '127.0.0.1:8377'), false)
  })

  test('failed logins lock a key out after five, and the lock ends', () => {
    let t = 1000
    const l = new FailLimiter(5, 60_000, 30_000, () => t)
    for (let i = 0; i < 4; i++) l.fail('a')
    assert.equal(l.retryAfter('a'), 0)
    l.fail('a')
    assert.equal(l.retryAfter('a'), 30)
    assert.equal(l.retryAfter('b'), 0)
    t += 30_001
    assert.equal(l.retryAfter('a'), 0)
  })

  test('sessions expire and can be revoked', () => {
    let t = 0
    const s = new Sessions(() => t)
    const id = s.create()
    assert.equal(s.valid(id), true)
    assert.equal(s.valid(`${id}x`), false)
    assert.equal(s.valid(undefined), false)
    s.revoke(id)
    assert.equal(s.valid(id), false)
    const id2 = s.create()
    t += 13 * 3600 * 1000
    assert.equal(s.valid(id2), false)
  })
})

describe('serve arguments', () => {
  test('defaults, flags, and the stop and status forms', () => {
    assert.deepEqual(parseServeArgs([]), { verb: 'serve', action: 'run', port: 8377, host: '127.0.0.1', readOnly: false, allowHosts: [] })
    assert.deepEqual(parseServeArgs(['--port', '0', '--host', '0.0.0.0', '--read-only', '--allow-host', 'a.b']), { verb: 'serve', action: 'run', port: 0, host: '0.0.0.0', readOnly: true, allowHosts: ['a.b'] })
    assert.equal((parseServeArgs(['--stop']) as { action: string }).action, 'stop')
    assert.equal((parseServeArgs(['--status']) as { action: string }).action, 'status')
    for (const bad of [['--port'], ['--port', '70000'], ['--port', 'x'], ['--host'], ['--stop', '--port', '1'], ['--stop', '--status'], ['--tls-cert', 'a.pem'], ['--wat']]) assert.ok('error' in parseServeArgs(bad), bad.join(' '))
    assert.deepEqual(parseServeArgs(['--tls-cert', 'c.pem', '--tls-key', 'k.pem']), { verb: 'serve', action: 'run', port: 8377, host: '127.0.0.1', readOnly: false, allowHosts: [], tlsCert: 'c.pem', tlsKey: 'k.pem' })
    const viaCli = parseArgs(['serve', '--read-only', '--port', '9000'])
    assert.ok(!('error' in viaCli) && viaCli.command === 'daemon' && viaCli.daemon?.verb === 'serve' && viaCli.daemon.readOnly)
    assert.ok('error' in parseArgs(['serve', '--nope']))
  })
})

describe('http', () => {
  test('the page and assets carry a CSP and no CORS headers; gzip or plain, same bytes', async () => {
    await withServer({}, async ({ port }) => {
      const page = await request(port, 'GET', '/', { 'accept-encoding': 'gzip' })
      assert.equal(page.status, 200)
      assert.match(String(page.headers['content-type']), /text\/html/)
      const policy = String(page.headers['content-security-policy'])
      assert.match(policy, /default-src 'none'/)
      assert.match(policy, /script-src 'self'(;|$)/)
      assert.match(policy, /frame-ancestors 'none'/)
      assert.equal(page.headers['access-control-allow-origin'], undefined)
      assert.equal(page.headers['x-content-type-options'], 'nosniff')
      assert.match(zlib.gunzipSync(page.body).toString(), /<title>Pager<\/title>/)
      const plain = await request(port, 'GET', '/')
      assert.equal(plain.headers['content-encoding'], undefined)
      assert.deepEqual(plain.body, zlib.gunzipSync(page.body))
      for (const p of ['/assets/app.js', '/assets/app.css', '/assets/tokens.css', '/assets/xterm.js', '/assets/xterm.css', '/assets/addon-fit.js', '/assets/fonts/geist.woff2', '/assets/fonts/geist-mono.woff2', '/favicon.svg']) {
        assert.equal((await request(port, 'GET', p)).status, 200, p)
      }
      const etag = String(page.headers.etag)
      assert.equal(page.headers['cache-control'], 'no-cache')
      const again = await request(port, 'GET', '/', { 'if-none-match': etag, 'accept-encoding': 'gzip' })
      assert.equal(again.status, 304)
      assert.equal(again.body.length, 0)
      assert.equal((await request(port, 'GET', '/', { 'if-none-match': '"other"' })).status, 200)
      assert.equal((await request(port, 'GET', '/nope')).status, 404)
      const opt = await request(port, 'OPTIONS', '/api/auth', { origin: 'http://evil.example', 'access-control-request-method': 'POST' })
      assert.equal(opt.status, 405)
      assert.equal(opt.headers['access-control-allow-origin'], undefined)
      assert.equal((await request(port, 'PUT', '/')).status, 405)
    })
  })

  test('a wrong Host header is refused (DNS rebinding)', async () => {
    await withServer({}, async ({ port }) => {
      assert.equal((await request(port, 'GET', '/', { host: `evil.example:${port}` })).status, 403)
      assert.equal((await request(port, 'GET', '/', { host: '127.0.0.1:1' })).status, 403)
      assert.equal((await request(port, 'GET', '/', { host: `localhost:${port}` })).status, 200)
    })
  })

  test('login: right token gets an HttpOnly SameSite=Strict cookie that is not the token; session needs it', async () => {
    await withServer({}, async ({ port, origin }) => {
      assert.equal((await request(port, 'GET', '/api/session')).status, 401)
      const ok = await request(port, 'POST', '/api/auth', { origin, 'content-type': 'application/json' }, JSON.stringify({ token: TOKEN }))
      assert.equal(ok.status, 200)
      const cookie = String(ok.headers['set-cookie']?.[0])
      assert.match(cookie, /^pager_session=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Strict; Path=\//)
      assert.doesNotMatch(cookie, /Secure/, 'plain http cannot carry a Secure cookie')
      assert.ok(!cookie.includes(TOKEN))
      const me = await request(port, 'GET', '/api/session', { cookie: cookie.split(';')[0]! })
      assert.equal(me.status, 200)
      assert.deepEqual(JSON.parse(me.body.toString()), { ok: true, readOnly: false, version: 'test' })
      assert.equal((await request(port, 'GET', '/api/session', { cookie: 'pager_session=forged' })).status, 401)
      await request(port, 'POST', '/api/logout', { origin, cookie: cookie.split(';')[0]! })
      assert.equal((await request(port, 'GET', '/api/session', { cookie: cookie.split(';')[0]! })).status, 401)
    })
  })

  test('login refuses another origin, a missing origin, non-JSON, and wrong tokens', async () => {
    await withServer({}, async ({ port, origin }) => {
      const body = JSON.stringify({ token: TOKEN })
      const json = { 'content-type': 'application/json' }
      assert.equal((await request(port, 'POST', '/api/auth', { ...json, origin: 'http://evil.example' }, body)).status, 403)
      assert.equal((await request(port, 'POST', '/api/auth', { ...json }, body)).status, 403)
      assert.equal((await request(port, 'POST', '/api/auth', { origin, 'content-type': 'text/plain' }, body)).status, 415)
      const bad = await request(port, 'POST', '/api/auth', { origin, ...json }, JSON.stringify({ token: `${TOKEN}x` }))
      assert.equal(bad.status, 401)
      assert.equal(bad.headers['set-cookie'], undefined)
      assert.equal((await request(port, 'POST', '/api/auth', { origin, ...json }, '{not json')).status, 401)
      assert.equal((await request(port, 'POST', '/api/auth', { origin, ...json }, 'x'.repeat(5000))).status, 401)
    })
  })

  test('five wrong tokens lock the address out, even for the right token, with Retry-After', async () => {
    let t = 1_000_000
    await withServer({ now: () => t }, async ({ port, origin }) => {
      const json = { origin, 'content-type': 'application/json' }
      for (let i = 0; i < 5; i++) assert.equal((await request(port, 'POST', '/api/auth', json, JSON.stringify({ token: `wrong${i}` }))).status, 401)
      const locked = await request(port, 'POST', '/api/auth', json, JSON.stringify({ token: TOKEN }))
      assert.equal(locked.status, 429)
      assert.ok(Number(locked.headers['retry-after']) > 0)
      t += 61_000
      assert.equal((await request(port, 'POST', '/api/auth', json, JSON.stringify({ token: TOKEN }))).status, 200)
    })
  })

  test('control routes want the secret from this machine; stop ends the server', async () => {
    await withServer({ control: 'control-secret' }, async ({ port, srv }) => {
      assert.equal((await request(port, 'GET', '/api/control/status')).status, 401)
      assert.equal((await request(port, 'GET', '/api/control/status', { authorization: 'Bearer nope' })).status, 401)
      assert.equal((await request(port, 'GET', '/api/control/status', { authorization: 'Bearer control-secret', origin: 'http://evil.example' })).status, 401, 'a browser request never counts')
      const st = await request(port, 'GET', '/api/control/status', { authorization: 'Bearer control-secret' })
      assert.equal(st.status, 200)
      assert.equal((JSON.parse(st.body.toString()) as { clients: number }).clients, 0)
      assert.equal((await request(port, 'POST', '/api/control/stop', { authorization: 'Bearer control-secret' })).status, 200)
      await srv.stopped
    })
  })
})

describe('websocket sessions against a fake daemon', () => {
  test('refused without a cookie, from another origin, with no origin, or on a wrong host', async () => {
    await withServer({}, async ({ port, origin, login, links }) => {
      const cookie = await login()
      assert.equal(await connectWs(port, { origin }), 401)
      assert.equal(await connectWs(port, { origin, cookie: 'pager_session=forged' }), 401)
      assert.equal(await connectWs(port, { origin: 'http://evil.example', cookie }), 403)
      assert.equal(await connectWs(port, { origin: `http://127.0.0.1:${port + 1}`, cookie }), 403)
      assert.equal(await connectWs(port, { cookie }), 403, 'a browser always sends Origin')
      assert.equal(await connectWs(port, { origin: `http://evil.example:${port}`, host: `evil.example:${port}`, cookie }), 403)
      assert.equal(await connectWs(port, { origin, cookie, 'sec-websocket-version': '8' }), 400)
      assert.equal(links.length, 0, 'no daemon connection was opened for a refused browser')
    })
  })

  test('hello, then the state without the daemon settings', async () => {
    await withServer({}, async ({ port, origin, login }) => {
      const ws = (await connectWs(port, { origin, cookie: await login() })) as TestWs
      const hello = await ws.json('hello')
      assert.deepEqual(hello, { t: 'hello', readOnly: false, version: 'test' })
      const state = await ws.json('state')
      const text = JSON.stringify(state)
      assert.match(text, /"paneId":"5"/)
      assert.doesNotMatch(text, /must not reach a browser/)
      ws.end()
    })
  })

  test('attach answers first, output follows, even output that arrived with the answer', async () => {
    await withServer({}, async ({ open, links }) => {
      const ws = await open()
      links[0]!.lateOutput = Buffer.from('late bytes')
      ws.send({ t: 'attach', id: 1, pane: '5', cols: 100, rows: 30 })
      const r = (await ws.json('reply', 1)) as { ok: boolean; result: { replay: string; cols: number } }
      assert.equal(r.ok, true)
      assert.equal(Buffer.from(r.result.replay, 'base64').toString(), 'replayed screen')
      const frame = await ws.binary()
      assert.equal(frame.readUInt32LE(0), 5)
      assert.equal(frame.subarray(4).toString(), 'late bytes')
      assert.deepEqual(links[0]!.calls.find((c) => c.type === 'pane.attach')?.args, { paneId: '5', cols: 100, rows: 30 })
      // live output after that
      links[0]!.emit('data', 5, Buffer.from('more'))
      assert.equal((await ws.binary()).subarray(4).toString(), 'more')
      // output for a pane this browser did not attach is not forwarded
      links[0]!.emit('data', 6, Buffer.from('nope'))
      links[0]!.emit('data', 5, Buffer.from('again'))
      assert.equal((await ws.binary()).subarray(4).toString(), 'again')
      ws.end()
    })
  })

  test('keyboard input, resize, new, split, close and capture reach the daemon', async () => {
    await withServer({}, async ({ open, links }) => {
      const ws = await open()
      ws.send({ t: 'input', pane: '5', data: 'echo hi\r' })
      ws.send({ t: 'input', pane: '5', b64: Buffer.from([27, 91, 65]).toString('base64'), id: 2 })
      await ws.json('reply', 2)
      assert.equal(links[0]!.inputs[0]!.data, 'echo hi\r')
      assert.deepEqual([...(links[0]!.inputs[1]!.data as Uint8Array)], [27, 91, 65])
      ws.send({ t: 'resize', id: 3, pane: '5', cols: 120, rows: 40 })
      await ws.json('reply', 3)
      ws.send({ t: 'new', id: 4, kind: 'shell', cwd: '/tmp' })
      assert.deepEqual(((await ws.json('reply', 4)) as { result: unknown }).result, { sessionId: 's1', tabId: 't2', paneId: '6' })
      ws.send({ t: 'split', id: 5, pane: '5', dir: 'col', kind: 'shell' })
      await ws.json('reply', 5)
      ws.send({ t: 'close', id: 6, pane: '5' })
      await ws.json('reply', 6)
      ws.send({ t: 'capture', id: 7, pane: '5', lines: 50 })
      assert.equal(((await ws.json('reply', 7)) as { result: { text: string } }).result.text, 'captured text')
      const by = (t: string): Record<string, unknown> | undefined => links[0]!.calls.find((c) => c.type === t)?.args
      assert.deepEqual(by('pane.resize'), { paneId: '5', cols: 120, rows: 40 })
      assert.deepEqual(by('tab.new'), { kind: 'shell', cwd: '/tmp' })
      assert.deepEqual(by('pane.split'), { paneId: '5', dir: 'col', kind: 'shell' })
      assert.deepEqual(by('pane.close'), { paneId: '5' })
      assert.deepEqual(by('pane.capture'), { paneId: '5', plain: true, lines: 50 })
      ws.end()
    })
  })

  test('bad arguments are refused with an error reply, never passed on', async () => {
    await withServer({}, async ({ open, links }) => {
      const ws = await open()
      const refused = async (id: number, msg: Record<string, unknown>): Promise<string> => {
        ws.send({ ...msg, id })
        const r = (await ws.json('reply', id)) as { ok: boolean; error: string }
        assert.equal(r.ok, false)
        return r.error
      }
      assert.match(await refused(1, { t: 'attach', pane: '5; rm' }), /pane id/)
      assert.match(await refused(2, { t: 'resize', pane: '5', cols: 0, rows: 5 }), /cols/)
      assert.match(await refused(3, { t: 'split', pane: '5', dir: 'diagonal' }), /dir/)
      assert.match(await refused(4, { t: 'new', kind: 'block:files' }), /kind/)
      assert.match(await refused(5, { t: 'input', pane: '5', data: 'x'.repeat(MAX_INPUT + 1) }), /data/)
      assert.match(await refused(6, { t: 'teleport' }), /unknown message/)
      assert.match(await refused(7, { t: 'run' }), /command/)
      assert.equal(links[0]!.inputs.length, 0)
      assert.equal(links[0]!.count('pane.attach') + links[0]!.count('pane.resize') + links[0]!.count('pane.split') + links[0]!.count('tab.new') + links[0]!.count('pane.run'), 0)
      ws.end()
    })
  })

  test('run: a pane runs the command, we wait for it to finish, and answer with its capture', async () => {
    await withServer({}, async ({ open, links }) => {
      const ws = await open()
      ws.send({ t: 'run', id: 1, command: 'echo hi', pane: '5', dir: 'row', waitMs: 5000 })
      const r = (await ws.json('reply', 1)) as { ok: boolean; result: { paneId: string; text: string; finished: boolean; exit: number } }
      assert.deepEqual(r.result, { paneId: '9', text: 'captured text', finished: true, exit: 3 })
      assert.deepEqual(links[0]!.calls.find((c) => c.type === 'pane.run')?.args, { command: 'echo hi', paneId: '5', dir: 'row' })
      ws.end()
    })
  })

  test('daemon events and state pushes are forwarded; the daemon settings never are', async () => {
    await withServer({}, async ({ open, links }) => {
      const ws = await open()
      links[0]!.emit('event', { event: 'state', state: STATE })
      links[0]!.emit('event', { event: 'pane_title', paneId: '5', title: 'new title' })
      assert.doesNotMatch(JSON.stringify(await ws.json('state')), /must not reach/)
      assert.equal(((await ws.json('event')) as { title: string }).title, 'new title')
      ws.end()
    })
  })

  test('a pane the daemon says we fell behind on is re-attached and pushed again', async () => {
    await withServer({}, async ({ open, links }) => {
      const ws = await open()
      ws.send({ t: 'attach', id: 1, pane: '5' })
      await ws.json('reply', 1)
      links[0]!.emit('event', { event: 'pane_resync', paneId: '5' })
      const push = (await ws.json('resync')) as { pane: string; replay: string }
      assert.equal(push.pane, '5')
      assert.equal(Buffer.from(push.replay, 'base64').toString(), 'replayed screen')
      assert.equal(links[0]!.count('pane.detach'), 1)
      assert.equal(links[0]!.count('pane.attach'), 2)
      ws.end()
    })
  })

  test('closing the browser closes its daemon connection', async () => {
    await withServer({}, async ({ open, links, srv }) => {
      const ws = await open()
      assert.equal(srv.stats().clients, 1)
      ws.end()
      await waitFor(() => links[0]!.closed, 5000, 'the daemon connection to close')
      assert.equal(links[0]!.closed, true)
    })
  })

  test('a daemon that goes away closes the browser with 1011', async () => {
    await withServer({}, async ({ open, links }) => {
      const ws = await open()
      links[0]!.close()
      assert.equal(await ws.closed(), 1011)
    })
  })

  test('message caps: too big closes 1009, bad JSON 1007, binary 1003, an unmasked frame 1002', async () => {
    await withServer({}, async ({ open }) => {
      const big = await open()
      big.raw(encodeFrame(OP_TEXT, Buffer.alloc(MAX_MESSAGE + 1, 0x61), true))
      assert.equal(await big.closed(), 1009)
      const fragments = await open()
      fragments.raw(encodeFrame(OP_TEXT, Buffer.alloc(MAX_MESSAGE - 10, 0x61), true, false))
      fragments.raw(encodeFrame(OP_CONT, Buffer.alloc(100, 0x61), true))
      assert.equal(await fragments.closed(), 1009, 'a message in pieces is capped as a whole')
      const bad = await open()
      bad.raw(encodeFrame(OP_TEXT, Buffer.from('{nope'), true))
      assert.equal(await bad.closed(), 1007)
      const bin = await open()
      bin.raw(encodeFrame(OP_BINARY, Buffer.from([1, 2, 3]), true))
      assert.equal(await bin.closed(), 1003)
      const unmasked = await open()
      unmasked.raw(encodeFrame(OP_TEXT, Buffer.from('{"t":"ping"}')))
      assert.equal(await unmasked.closed(), 1002)
      const shape = await open()
      shape.raw(encodeFrame(OP_TEXT, Buffer.from('[1]'), true))
      assert.equal(await shape.closed(), 1008)
    })
  })

  test('a fragmented message and a ping are handled', async () => {
    await withServer({}, async ({ open }) => {
      const ws = await open()
      const text = Buffer.from(JSON.stringify({ t: 'ping', id: 1 }))
      ws.raw(encodeFrame(OP_TEXT, text.subarray(0, 5), true, false))
      ws.raw(encodeFrame(OP_PING, Buffer.from('p'), true))
      ws.raw(encodeFrame(OP_CONT, text.subarray(5), true))
      assert.equal(((await ws.json('reply', 1)) as { ok: boolean }).ok, true)
      ws.end()
    })
  })

  test('a failing daemon call comes back as an error reply', async () => {
    await withServer({}, async ({ open, links }) => {
      const ws = await open()
      const real = links[0]!.call.bind(links[0]!)
      links[0]!.call = <T>(type: string, args: Record<string, unknown> = {}): Promise<T> => real<T>(type === 'pane.close' ? 'pane.fail' : type, args)
      ws.send({ t: 'close', id: 1, pane: '5' })
      assert.deepEqual(await ws.json('reply', 1), { t: 'reply', id: 1, ok: false, error: 'boom' })
      ws.end()
    })
  })

  test('the connection limit is enforced', async () => {
    await withServer({ maxConnections: 1 }, async ({ open, port, origin, login }) => {
      const first = await open()
      assert.equal(await connectWs(port, { origin, cookie: await login() }), 503)
      first.end()
    })
  })

  test('no daemon: the upgrade is answered with 503', async () => {
    await withServer(
      {
        connect: async () => {
          throw new Error('no daemon')
        },
      },
      async ({ port, origin, login }) => {
        assert.equal(await connectWs(port, { origin, cookie: await login() }), 503)
      },
    )
  })
})

describe('read-only mode', () => {
  test('every change is refused and nothing reaches the daemon; watching still works', async () => {
    await withServer({ readOnly: true }, async ({ open, links, port }) => {
      const ws = await open()
      const hello = await request(port, 'GET', '/api/session', { cookie: '' })
      assert.equal(hello.status, 401)
      const refused = async (id: number, msg: Record<string, unknown>): Promise<void> => {
        ws.send({ ...msg, id })
        const r = (await ws.json('reply', id)) as { ok: boolean; error: string }
        assert.equal(r.ok, false, String(msg.t))
        assert.match(r.error, /read-only/)
      }
      await refused(1, { t: 'input', pane: '5', data: 'rm -rf /\r' })
      await refused(2, { t: 'resize', pane: '5', cols: 10, rows: 10 })
      await refused(3, { t: 'new' })
      await refused(4, { t: 'split', pane: '5', dir: 'row' })
      await refused(5, { t: 'close', pane: '5' })
      await refused(6, { t: 'run', command: 'echo hi' })
      const link = links[0]!
      assert.equal(link.inputs.length, 0)
      for (const t of ['pane.resize', 'tab.new', 'pane.split', 'pane.close', 'pane.run', 'pane.input']) assert.equal(link.count(t), 0, t)
      // watching: attach (without sending the browser's size, which would resize the program), capture, state, ping
      ws.send({ t: 'attach', id: 7, pane: '5', cols: 20, rows: 5 })
      assert.equal(((await ws.json('reply', 7)) as { ok: boolean }).ok, true)
      assert.deepEqual(link.calls.find((c) => c.type === 'pane.attach')?.args, { paneId: '5' })
      ws.send({ t: 'capture', id: 8, pane: '5' })
      assert.equal(((await ws.json('reply', 8)) as { ok: boolean }).ok, true)
      ws.send({ t: 'state', id: 9 })
      assert.equal(((await ws.json('reply', 9)) as { ok: boolean }).ok, true)
      link.emit('data', 5, Buffer.from('output'))
      assert.equal((await ws.binary()).subarray(4).toString(), 'output')
      ws.end()
    })
  })

  test('the hello and the session say read-only', async () => {
    await withServer({ readOnly: true }, async ({ port, origin, login }) => {
      const cookie = await login()
      assert.equal(JSON.parse((await request(port, 'GET', '/api/session', { cookie })).body.toString()).readOnly, true)
      const ws = (await connectWs(port, { origin, cookie })) as TestWs
      assert.equal(((await ws.json('hello')) as { readOnly: boolean }).readOnly, true)
      ws.end()
    })
  })
})
