// The shim runs as a real child process (the way agents spawn it), against a real ToolServer on loopback.
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import readline from 'node:readline'
import { test } from 'node:test'
import { isRecord } from '../../util/guards.js'
import { type ToolHost, ToolServer, type TurnToken, shimSpec } from './toolserver.js'

const turn: TurnToken = { agent: 'omp', kind: 'normal', chain: [] }

function host(seen: string[], gate?: PromiseWithResolvers<string>): ToolHost {
  const unused = (): string => {
    throw new Error('not used here')
  }
  return {
    sendMessage(from, to, text, wait) {
      seen.push(`${from.agent}>${to}:${text}:${wait}`)
      if (to === 'nobody') throw new Error('no such teammate: nobody')
      return text === 'slow' && gate ? gate.promise : Promise.resolve(`sent to ${to}`)
    },
    listAgents: unused,
    setStatus: unused,
    askUser: () => Promise.resolve('{"answers":[]}'),
    remember: unused,
    docRead: unused,
    docWrite: unused,
    submitReview: unused,
  }
}

interface Shim {
  child: ChildProcess
  call(msg: Record<string, unknown>): void
  next(): Promise<Record<string, unknown>>
  exited: Promise<number | null>
  stderr(): string
}

function startShim(env: { name: string; value: string }[]): Shim {
  const spec = shimSpec(0, '')
  const childEnv: Record<string, string | undefined> = { ...process.env, PAGER_TOOL_PORT: undefined, PAGER_TOOL_TOKEN: undefined }
  for (const e of env) childEnv[e.name] = e.value
  const child = spawn(spec.command, spec.args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  const it = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let err = ''
  child.stderr.on('data', (d: Buffer) => void (err += d.toString()))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return {
    child,
    call: (msg) => void child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`),
    async next() {
      const r = await it.next()
      assert.ok(!r.done, 'shim closed stdout before replying')
      const parsed: unknown = JSON.parse(r.value) // every stdout line must be JSON
      assert.ok(isRecord(parsed))
      assert.equal(parsed.jsonrpc, '2.0')
      return parsed
    },
    exited,
    stderr: () => err,
  }
}

async function withShim(h: ToolHost, fn: (shim: Shim, server: ToolServer) => Promise<void>): Promise<void> {
  const server = new ToolServer(h)
  const port = await server.start()
  const shim = startShim(shimSpec(port, server.issue(turn)).env)
  try {
    await fn(shim, server)
    shim.child.stdin?.end()
    assert.equal(await shim.exited, 0, 'stdin close ends the process cleanly')
  } finally {
    shim.child.kill()
    await server.close()
  }
}

test('shim handshake, tool list and tool calls', async () => {
  const seen: string[] = []
  await withShim(host(seen), async (shim) => {
    shim.call({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't' } } })
    assert.deepEqual(await shim.next(), {
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'pager', version: '1' } },
    })
    shim.call({ method: 'notifications/initialized' }) // a notification gets no reply, so the next reply is the ping's
    shim.call({ id: 2, method: 'ping' })
    assert.deepEqual(await shim.next(), { jsonrpc: '2.0', id: 2, result: {} })

    shim.call({ id: 3, method: 'tools/list' })
    const list = await shim.next()
    assert.ok(isRecord(list.result) && Array.isArray(list.result.tools))
    const tools = list.result.tools.filter(isRecord)
    const names = tools.map((t) => t.name)
    assert.ok(names.includes('send_message') && names.includes('ask_user'))
    assert.ok(!names.includes('submit_review'), 'a normal turn does not see review tools')
    for (const t of tools) {
      assert.equal(typeof t.description, 'string')
      assert.ok(isRecord(t.inputSchema), `${String(t.name)} has a schema`)
    }

    shim.call({ id: 4, method: 'tools/call', params: { name: 'send_message', arguments: { to: 'claude', text: 'hello', wait: true } } })
    assert.deepEqual(await shim.next(), { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'sent to claude' }], isError: false } })
    assert.deepEqual(seen, ['omp>claude:hello:true'])

    // Tool refusals: host error, bad arguments, unknown tool and review-only tool all come back as isError text.
    shim.call({ id: 5, method: 'tools/call', params: { name: 'send_message', arguments: { to: 'nobody', text: 'hi' } } })
    assert.deepEqual(await shim.next(), { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: 'no such teammate: nobody' }], isError: true } })
    shim.call({ id: 6, method: 'tools/call', params: { name: 'send_message', arguments: { to: 'x' } } })
    const bad = await shim.next()
    assert.ok(isRecord(bad.result) && bad.result.isError === true)
    assert.match(JSON.stringify(bad.result.content), /text is required/)
    shim.call({ id: 7, method: 'tools/call', params: { name: 'submit_review', arguments: { verdict: 'approve', comments: '' } } })
    assert.match(JSON.stringify((await shim.next()).result), /only available during a review/)
    shim.call({ id: 8, method: 'tools/call', params: { name: 'send_message' } }) // arguments omitted
    assert.match(JSON.stringify((await shim.next()).result), /"isError":true/)

    // Protocol errors.
    shim.call({ id: 9, method: 'resources/list' })
    assert.deepEqual(await shim.next(), { jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'method not found: resources/list' } })
    shim.call({ id: 10, method: 'tools/call', params: {} })
    const nameless = await shim.next()
    assert.ok(isRecord(nameless.error) && nameless.error.code === -32602)
    shim.child.stdin?.write('not json\n')
    const parseErr = await shim.next()
    assert.equal(parseErr.id, null)
    assert.ok(isRecord(parseErr.error) && parseErr.error.code === -32700)
    shim.call({ id: 11, method: 'ping' }) // still alive after garbage
    assert.deepEqual(await shim.next(), { jsonrpc: '2.0', id: 11, result: {} })
  })
})

test('shim initialize defaults the protocol version', async () => {
  await withShim(host([]), async (shim) => {
    shim.call({ id: 1, method: 'initialize' })
    const res = await shim.next()
    assert.ok(isRecord(res.result))
    assert.equal(res.result.protocolVersion, '2024-11-05')
  })
})

test('a slow tools/call does not block later calls', async () => {
  const gate = Promise.withResolvers<string>()
  await withShim(host([], gate), async (shim) => {
    shim.call({ id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { to: 'b', text: 'slow', wait: true } } })
    shim.call({ id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { to: 'b', text: 'fast' } } })
    assert.equal((await shim.next()).id, 2)
    gate.resolve('the late reply')
    const late = await shim.next()
    assert.equal(late.id, 1)
    assert.match(JSON.stringify(late.result), /the late reply/)
  })
})

test('stdin close waits for a call that is still in flight', async () => {
  const gate = Promise.withResolvers<string>()
  const server = new ToolServer(host([], gate))
  const port = await server.start()
  const shim = startShim(shimSpec(port, server.issue(turn)).env)
  try {
    shim.call({ id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { to: 'b', text: 'slow', wait: true } } })
    shim.child.stdin?.end()
    // Resolving the gate early is fine: the reply still needs a TCP round trip, which a shim that exits on close would lose.
    gate.resolve('answer after close')
    assert.match(JSON.stringify((await shim.next()).result), /answer after close/)
    assert.equal(await shim.exited, 0)
  } finally {
    shim.child.kill()
    await server.close()
  }
})

test('missing environment makes tool calls fail without crashing the shim', async () => {
  const shim = startShim([])
  shim.call({ id: 1, method: 'initialize', params: {} })
  assert.ok(isRecord((await shim.next()).result))
  shim.call({ id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { to: 'a', text: 'x' } } })
  const res = await shim.next()
  assert.ok(isRecord(res.result) && res.result.isError === true)
  assert.match(JSON.stringify(res.result.content), /not configured/)
  shim.call({ id: 3, method: 'tools/list' })
  const list = await shim.next()
  assert.ok(isRecord(list.error), 'tools/list reports the problem as a JSON-RPC error')
  shim.call({ id: 4, method: 'ping' })
  assert.deepEqual(await shim.next(), { jsonrpc: '2.0', id: 4, result: {} })
  shim.child.stdin?.end()
  assert.equal(await shim.exited, 0)
})

test('an unreachable pager or a revoked token is reported as a tool error', async () => {
  const server = new ToolServer(host([]))
  const port = await server.start()
  const token = server.issue(turn)
  const shim = startShim(shimSpec(port, token).env)
  try {
    server.revoke(token)
    shim.call({ id: 1, method: 'tools/call', params: { name: 'list_agents', arguments: {} } })
    assert.match(JSON.stringify((await shim.next()).result), /unknown or expired token/)
    await server.close()
    shim.call({ id: 2, method: 'tools/call', params: { name: 'list_agents', arguments: {} } })
    const res = await shim.next()
    assert.ok(isRecord(res.result) && res.result.isError === true)
    assert.match(JSON.stringify(res.result.content), /cannot reach pager/)
    assert.equal(shim.stderr(), '', 'nothing but protocol on stdout, no noise on stderr')
  } finally {
    shim.child.kill()
    await server.close()
  }
})
