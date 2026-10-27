import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { VERSION } from '../app/version.js'
import { connectOrStart, resolvePaths } from '../daemon/client.js'
import { isLoopback, isWildcard } from './auth.js'
import type { ServeArgs } from './args.js'
import { readTls, startRemoteServer } from './server.js'

const out = (s: string): void => void process.stdout.write(`${s}\n`)
const err = (s: string): void => void process.stderr.write(`${s}\n`)

/** What a running `pager serve` leaves in the data dir so `--stop` and `--status` can find it. Not the access token. */
interface ServeState {
  pid: number
  host: string
  port: number
  tls: boolean
  readOnly: boolean
  startedAt: number
  /** The secret the control routes want; the file is private to the user like the rest of the data dir. */
  control: string
}

export const stateFile = (dir: string): string => path.join(dir, 'serve.json')

function readState(dir: string): ServeState | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')) as Partial<ServeState>
    if (typeof s.pid === 'number' && typeof s.host === 'string' && typeof s.port === 'number' && typeof s.control === 'string') return s as ServeState
  } catch {
    // none, or not ours
  }
  return undefined
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** One request to a running server's control routes, from this machine. */
function control(s: ServeState, method: 'GET' | 'POST', route: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const host = isWildcard(s.host) ? '127.0.0.1' : s.host
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: Record<string, unknown> }>()
  const options: https.RequestOptions = { host, port: s.port, path: route, method, headers: { authorization: `Bearer ${s.control}` }, timeout: 4000, rejectUnauthorized: false } // loopback: a self-signed certificate is the usual one
  const req = (s.tls ? https : http).request(options, (res) => {
    const chunks: Buffer[] = []
    res.on('data', (c: Buffer) => chunks.push(c))
    res.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        // not JSON: the status says enough
      }
      resolve({ status: res.statusCode ?? 0, body })
    })
  })
  req.on('timeout', () => req.destroy(new Error('no answer')))
  req.on('error', reject)
  req.end()
  return promise
}

async function probe(s: ServeState): Promise<Record<string, unknown> | undefined> {
  if (!alive(s.pid)) return undefined
  try {
    const r = await control(s, 'GET', '/api/control/status')
    return r.status === 200 ? r.body : undefined
  } catch {
    return undefined
  }
}

async function status(dir: string): Promise<number> {
  const s = readState(dir)
  const info = s === undefined ? undefined : await probe(s)
  if (s === undefined || info === undefined) {
    out('pager serve is not running')
    return 1
  }
  out(`running: pid ${s.pid}, ${s.tls ? 'https' : 'http'}://${s.host}:${s.port}, up ${Math.round((Date.now() - s.startedAt) / 1000)} s`)
  out(`  ${String(info.clients)} browser connection(s), ${String(info.sessions)} logged-in session(s)${s.readOnly ? ', read-only' : ''}`)
  return 0
}

async function stop(dir: string): Promise<number> {
  const s = readState(dir)
  if (s === undefined) {
    out('pager serve is not running')
    return 0
  }
  if (alive(s.pid)) {
    let asked = false
    try {
      asked = (await control(s, 'POST', '/api/control/stop')).status === 200
    } catch {
      // fall through to the signal
    }
    for (let i = 0; i < 50 && alive(s.pid); i++) await sleep(100)
    if (alive(s.pid)) {
      if (!asked) err('pager serve did not answer its control route; stopping its process')
      process.kill(s.pid)
      for (let i = 0; i < 30 && alive(s.pid); i++) await sleep(100)
    }
  }
  fs.rmSync(stateFile(dir), { force: true })
  out('pager serve stopped')
  return 0
}

async function run(args: ServeArgs, dir: string): Promise<number> {
  const existing = readState(dir)
  if (existing !== undefined) {
    if ((await probe(existing)) !== undefined) {
      err(`pager serve is already running (pid ${existing.pid}, ${existing.tls ? 'https' : 'http'}://${existing.host}:${existing.port}). Stop it first: pager serve --stop`)
      return 1
    }
    fs.rmSync(stateFile(dir), { force: true }) // left behind by a crash
  }
  const paths = resolvePaths({ dir })
  // Starts the daemon when none runs (like every pager command that needs it); browsers then connect through their own links.
  const first = await connectOrStart(paths, { client: 'cli', name: 'serve' })
  first.client.close()

  let tls: { cert: Buffer; key: Buffer } | undefined
  if (args.tlsCert !== undefined && args.tlsKey !== undefined) {
    try {
      tls = readTls(args.tlsCert, args.tlsKey)
    } catch (e) {
      err(`pager serve: cannot read the TLS files: ${e instanceof Error ? e.message : String(e)}`)
      return 2
    }
  }
  const handle = await startRemoteServer({
    host: args.host,
    port: args.port,
    readOnly: args.readOnly,
    version: VERSION,
    allowHosts: args.allowHosts,
    ...(tls === undefined ? {} : { tls }),
    connect: async () => (await connectOrStart(paths, { client: 'cli', name: 'remote' })).client,
    log: (m) => err(`[${new Date().toISOString()}] ${m}`),
  })

  const state: ServeState = { pid: process.pid, host: args.host, port: handle.port, tls: handle.tls, readOnly: args.readOnly, startedAt: Date.now(), control: handle.control }
  fs.writeFileSync(stateFile(dir), JSON.stringify(state), { mode: 0o600 })

  if (!isLoopback(args.host)) {
    err(`warning: listening on ${args.host}, not only this machine. Anyone who can reach port ${handle.port} and has the token below can type into your terminals.${tls === undefined ? ' This is plain http: use --tls-cert/--tls-key, or a tunnel or reverse proxy that adds TLS.' : ''}`)
  }
  out(`pager serve: open ${handle.urls[0]}`)
  for (const u of handle.urls.slice(1)) out(`             or ${u}`)
  out(`The token is in the part after #; the page swaps it for a cookie and removes it from the address bar. It is shown only now: restart to get a new one.`)
  if (args.readOnly) out('Read-only: browsers can watch, not type or change anything.')
  out('Stop with Ctrl+C or: pager serve --stop')

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void handle.close())
  await handle.stopped
  fs.rmSync(stateFile(dir), { force: true })
  return 0
}

/** `pager serve ...`: returns the exit code. */
export async function runServe(args: ServeArgs, dir: string): Promise<number> {
  try {
    if (args.action === 'status') return await status(dir)
    if (args.action === 'stop') return await stop(dir)
    return await run(args, dir)
  } catch (e) {
    err(`pager serve: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
