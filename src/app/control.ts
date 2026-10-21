import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** Ask the running pager to open a terminal tab, optionally in a folder and typing a command. */
export interface RunRequest {
  type: 'run'
  cwd?: string
  command?: string
}
/** Ask the running pager for the address of its local docs and stats site, or of the bot studio on it. */
export interface DocsRequest {
  type: 'docs'
  page?: 'studio'
}
export type ControlRequest = RunRequest | DocsRequest | { type: 'ping' }
export type ControlReply = { ok: true; id?: string; pid?: number; url?: string } | { ok: false; error: string }
export type SendResult = { kind: 'ok'; reply: ControlReply } | { kind: 'none' }

const MAX_LINE = 64 * 1024
const IDLE_MS = 5000
const TOKEN_FILE = 'control.token'

/** Where the running pager listens for `dir`: a named pipe on Windows, a socket file elsewhere. */
export function controlAddress(dir: string, platform: NodeJS.Platform = process.platform, tmp: string = os.tmpdir()): string {
  const h = createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16)
  return platform === 'win32' ? `\\\\.\\pipe\\pager-${h}` : path.join(tmp, `pager-${h}.sock`)
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Listens for requests from other processes of the same user (`pager run`, the desktop host). Every request carries
 * the token in `<dir>/control.token`, so a local process that cannot read the data dir cannot drive the terminal.
 */
export async function startControl(
  dir: string,
  handle: (r: RunRequest | DocsRequest) => ControlReply | Promise<ControlReply>,
): Promise<{ close(): void }> {
  const token = randomBytes(24).toString('hex')
  const address = controlAddress(dir)
  const tokenFile = path.join(dir, TOKEN_FILE)

  const server = net.createServer((socket) => {
    let buf = ''
    let answered = false
    socket.setTimeout(IDLE_MS, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    const reply = (r: ControlReply): void => {
      if (answered) return
      answered = true
      socket.end(`${JSON.stringify(r)}\n`)
    }
    socket.on('data', (chunk) => {
      if (answered) return
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) {
        if (buf.length > MAX_LINE) reply({ ok: false, error: 'request too large' })
        return
      }
      if (nl > MAX_LINE) return reply({ ok: false, error: 'request too large' })
      let req: (ControlRequest & { token?: unknown }) | undefined
      try {
        req = JSON.parse(buf.slice(0, nl)) as ControlRequest & { token?: unknown }
      } catch {
        return reply({ ok: false, error: 'bad request' })
      }
      if (typeof req !== 'object' || req === null) return reply({ ok: false, error: 'bad request' })
      if (typeof req.token !== 'string' || !same(req.token, token)) return reply({ ok: false, error: 'unauthorized' })
      if (req.type === 'ping') return reply({ ok: true, pid: process.pid })
      if (req.type === 'docs') {
        Promise.resolve()
          .then(() => handle(req.page === 'studio' ? { type: 'docs', page: 'studio' } : { type: 'docs' }))
          .then(reply, (e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        return
      }
      if (req.type !== 'run') return reply({ ok: false, error: 'bad request' })
      const run: RunRequest = { type: 'run' }
      if (typeof req.cwd === 'string') run.cwd = req.cwd
      if (typeof req.command === 'string') run.command = req.command
      Promise.resolve()
        .then(() => handle(run))
        .then(reply, (e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    })
  })

  if (process.platform !== 'win32') fs.rmSync(address, { force: true })
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.once('error', reject)
  server.listen(address, resolve)
  await promise
  server.off('error', reject)
  server.on('error', () => {})
  if (process.platform !== 'win32') fs.chmodSync(address, 0o600)
  fs.writeFileSync(tokenFile, token, { mode: 0o600 })

  let closed = false
  return {
    close() {
      if (closed) return
      closed = true
      server.close()
      fs.rmSync(tokenFile, { force: true })
      if (process.platform !== 'win32') fs.rmSync(address, { force: true })
    },
  }
}

/** Sends one request to the pager that owns `dir`. `none`: no pager is listening there. */
export async function sendControl(dir: string, req: ControlRequest, timeoutMs = 3000): Promise<SendResult> {
  let token: string
  try {
    token = fs.readFileSync(path.join(dir, TOKEN_FILE), 'utf8').trim()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' }
    throw e
  }
  const { promise, resolve, reject } = Promise.withResolvers<SendResult>()
  const socket = net.createConnection(controlAddress(dir))
  let buf = ''
  const timer = setTimeout(() => finish(new Error('pager did not answer')), timeoutMs)
  const finish = (r: SendResult | Error): void => {
    clearTimeout(timer)
    socket.destroy()
    if (r instanceof Error) reject(r)
    else resolve(r)
  }
  socket.on('connect', () => socket.write(`${JSON.stringify({ token, ...req })}\n`))
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    try {
      finish({ kind: 'ok', reply: JSON.parse(buf.slice(0, nl)) as ControlReply })
    } catch {
      finish(new Error('pager sent an unreadable reply'))
    }
  })
  socket.on('error', (e: NodeJS.ErrnoException) => {
    finish(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? { kind: 'none' } : e)
  })
  socket.on('close', () => finish(new Error('pager closed the connection')))
  return promise
}
