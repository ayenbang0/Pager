// MCP stdio server that pager hands to agents. It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout
// and forwards every tool call to the ToolServer in the pager process (PAGER_TOOL_PORT / PAGER_TOOL_TOKEN).
// stdout carries JSON-RPC lines only; diagnostics go to stderr.
import net from 'node:net'
import readline from 'node:readline'
import { isRecord } from '../../util/guards.js'

const DEFAULT_PROTOCOL = '2024-11-05'
const pending = new Set<Promise<void>>()

type Reply = { ok: true; result: string } | { ok: false; error: string }

/** One request per connection, so calls that wait for minutes never block each other. */
function callServer(tool: string, args: unknown): Promise<Reply> {
  const port = Number(process.env.PAGER_TOOL_PORT)
  const token = process.env.PAGER_TOOL_TOKEN
  if (!Number.isInteger(port) || port <= 0 || !token) {
    return Promise.resolve({ ok: false, error: 'pager tools are not configured (PAGER_TOOL_PORT / PAGER_TOOL_TOKEN missing)' })
  }
  const { promise, resolve } = Promise.withResolvers<Reply>()
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.setEncoding('utf8')
  let buf = ''
  let done = false
  const finish = (reply: Reply): void => {
    if (done) return
    done = true
    socket.destroy()
    resolve(reply)
  }
  socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, token, tool, args })}\n`))
  socket.on('data', (chunk: string) => {
    buf += chunk
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    try {
      const msg: unknown = JSON.parse(buf.slice(0, nl))
      if (!isRecord(msg)) throw new Error('not an object')
      finish(msg.ok === true ? { ok: true, result: String(msg.result ?? '') } : { ok: false, error: String(msg.error ?? 'tool failed') })
    } catch {
      finish({ ok: false, error: 'pager sent an unreadable reply' })
    }
  })
  socket.on('error', (err) => finish({ ok: false, error: `cannot reach pager: ${err.message}` }))
  socket.on('close', () => finish({ ok: false, error: 'pager closed the connection before answering' }))
  return promise
}

const send = (msg: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
}
const fail = (id: unknown, code: number, message: string): void => send({ id, error: { code, message } })

async function handle(id: unknown, method: string, params: Record<string, unknown>): Promise<void> {
  if (method === 'initialize') {
    const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL
    send({ id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'pager', version: '1' } } })
  } else if (method === 'ping') {
    send({ id, result: {} })
  } else if (method === 'tools/list') {
    const reply = await callServer('__list', {})
    if (!reply.ok) return fail(id, -32603, reply.error)
    try {
      const parsed: unknown = JSON.parse(reply.result)
      const tools = (Array.isArray(parsed) ? parsed : []).filter(isRecord).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      send({ id, result: { tools } })
    } catch {
      fail(id, -32603, 'pager sent an unreadable tool list')
    }
  } else if (method === 'tools/call') {
    if (typeof params.name !== 'string') return fail(id, -32602, 'tools/call needs a tool name')
    const reply = await callServer(params.name, params.arguments ?? {})
    send({ id, result: { content: [{ type: 'text', text: reply.ok ? reply.result : reply.error }], isError: !reply.ok } })
  } else {
    fail(id, -32601, `method not found: ${method}`)
  }
}

function onLine(line: string): void {
  if (!line.trim()) return
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return fail(null, -32700, 'parse error')
  }
  if (!isRecord(msg) || typeof msg.method !== 'string') {
    if (isRecord(msg) && msg.id !== undefined && msg.method === undefined) return // a response to a request we never send
    return fail(isRecord(msg) ? (msg.id ?? null) : null, -32600, 'invalid request')
  }
  const id = msg.id
  const method = msg.method
  if (id === undefined || id === null) return // notifications (notifications/initialized, cancelled, …) need no reply
  const params = isRecord(msg.params) ? msg.params : {}
  const job = (async () => {
    try {
      await handle(id, method, params)
    } catch (err) {
      process.stderr.write(`pager mcp shim: ${err instanceof Error ? err.message : String(err)}\n`)
      fail(id, -32603, 'internal error')
    }
  })()
  pending.add(job)
  void job.then(() => pending.delete(job))
}

process.stdout.on('error', () => process.exit(0)) // the agent went away
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', onLine)
rl.on('close', () => {
  void Promise.allSettled([...pending]).then(() => process.exit(0))
})
