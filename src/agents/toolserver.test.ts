import assert from 'node:assert/strict'
import net from 'node:net'
import readline from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isRecord } from '../guards.js'
import { type AskQuestion, type ToolHost, type ToolResult, ToolServer, type TurnToken, TOOLS, shimSpec } from './toolserver.js'

interface Call {
  method: string
  args: unknown[]
}

/** A host that records every call. `sendMessage` with text `slow` waits on `gate` so tests control completion order. */
function fakeHost(): { host: ToolHost; calls: Call[]; gate: PromiseWithResolvers<string> } {
  const calls: Call[] = []
  const gate = Promise.withResolvers<string>()
  const rec = (method: string, args: unknown[]): void => void calls.push({ method, args })
  const host: ToolHost = {
    sendMessage(from, to, text, wait) {
      rec('sendMessage', [from.agent, to, text, wait])
      if (to === 'nobody') throw new Error('no such teammate: nobody (ready: a, b)')
      return text === 'slow' ? gate.promise : Promise.resolve(`sent to ${to}`)
    },
    listAgents(from) {
      rec('listAgents', [from.agent])
      return 'BOARD'
    },
    setStatus(from, task, fits) {
      rec('setStatus', [from.agent, task, fits])
      return 'status set'
    },
    askUser(from, questions) {
      rec('askUser', [from.agent, questions])
      return Promise.resolve('{"answers":[]}')
    },
    remember(from, note) {
      rec('remember', [from.agent, note])
      return 'noted'
    },
    docRead(from, name) {
      rec('docRead', [from.agent, name])
      return `text of ${name}`
    },
    docWrite(from, name, text, append) {
      rec('docWrite', [from.agent, name, text, append])
      return 'written'
    },
    submitReview(from, verdict, comments) {
      rec('submitReview', [from.agent, verdict, comments])
      return 'review recorded'
    },
  }
  return { host, calls, gate }
}

const normal: TurnToken = { agent: 'omp', kind: 'normal', chain: [] }
const review: TurnToken = { agent: 'claude', kind: 'review', chain: ['omp'] }

test('each tool forwards its parsed arguments to the host', async () => {
  const { host, calls } = fakeHost()
  const server = new ToolServer(host)
  const t = server.issue(normal)
  const questions: AskQuestion[] = [
    { question: 'Which db?', options: ['pg', 'sqlite'], multi: true, recommended: 1 },
    { question: 'Ship?', options: ['yes', 'no'] },
  ]
  const run = (tool: string, args: unknown) => server.handle(t, tool, args)
  assert.deepEqual(await run('send_message', { to: 'claude', text: 'hi', wait: true }), { ok: true, result: 'sent to claude' })
  await run('send_message', { to: 'claude', text: 'hi' })
  assert.deepEqual(await run('list_agents', {}), { ok: true, result: 'BOARD' })
  await run('list_agents', undefined) // agents may omit the arguments object
  await run('set_status', { task: 'fix parser', fits: 'part of the goal' })
  await run('set_status', { task: 'fix parser' })
  await run('ask_user', { questions })
  await run('remember', { note: 'use tabs' })
  await run('doc_read', { name: 'plan.md' })
  await run('doc_write', { name: 'plan.md', text: 'v2', append: true })
  await run('doc_write', { name: 'plan.md', text: '' })
  assert.deepEqual(calls, [
    { method: 'sendMessage', args: ['omp', 'claude', 'hi', true] },
    { method: 'sendMessage', args: ['omp', 'claude', 'hi', false] },
    { method: 'listAgents', args: ['omp'] },
    { method: 'listAgents', args: ['omp'] },
    { method: 'setStatus', args: ['omp', 'fix parser', 'part of the goal'] },
    { method: 'setStatus', args: ['omp', 'fix parser', undefined] },
    { method: 'askUser', args: ['omp', questions] },
    { method: 'remember', args: ['omp', 'use tabs'] },
    { method: 'docRead', args: ['omp', 'plan.md'] },
    { method: 'docWrite', args: ['omp', 'plan.md', 'v2', true] },
    { method: 'docWrite', args: ['omp', 'plan.md', '', false] },
  ])
})

test('invalid arguments are refused before the host is called', async () => {
  const { host, calls } = fakeHost()
  const server = new ToolServer(host)
  const t = server.issue(normal)
  const q = (extra: Record<string, unknown> = {}) => ({ question: 'Q?', options: ['a', 'b'], ...extra })
  const cases: [string, unknown, RegExp][] = [
    ['send_message', { text: 'hi' }, /to is required/],
    ['send_message', { to: 'a', text: 5 }, /text must be a string/],
    ['send_message', { to: 'a', text: '' }, /text must not be empty/],
    ['send_message', { to: 'a', text: 'x'.repeat(20001) }, /text is too long/],
    ['send_message', { to: 'a', text: 'x', wait: 'yes' }, /wait must be true or false/],
    ['send_message', 'hello', /args must be an object/],
    ['send_message', [], /args must be an object/],
    ['set_status', { task: 'x'.repeat(301) }, /task is too long/],
    ['set_status', { task: 'ok', fits: 'x'.repeat(301) }, /fits is too long/],
    ['remember', { note: 'x'.repeat(501) }, /note is too long/],
    ['ask_user', {}, /questions is required/],
    ['ask_user', { questions: [] }, /at least 1/],
    ['ask_user', { questions: [q(), q(), q(), q(), q()] }, /at most 4/],
    ['ask_user', { questions: [q({ options: ['only'] })] }, /options needs at least 2/],
    ['ask_user', { questions: [q({ options: ['1', '2', '3', '4', '5', '6', '7'] })] }, /options allows at most 6/],
    ['ask_user', { questions: [q({ options: ['a', 3] })] }, /options\[1\] must be a string/],
    ['ask_user', { questions: [q({ recommended: 1.5 })] }, /recommended must be an integer/],
    ['ask_user', { questions: [q({ recommended: -1 })] }, /recommended must be at least 0/],
    ['ask_user', { questions: [q({ recommended: 2 })] }, /recommended 2 is not an index/],
    ['ask_user', { questions: ['what?'] }, /questions\[0\] must be an object/],
    ['doc_read', { name: 7 }, /name must be a string/],
    ['doc_write', { name: 'a' }, /text is required/],
  ]
  for (const [tool, args, pattern] of cases) {
    const res = await server.handle(t, tool, args)
    assert.equal(res.ok, false, `${tool} ${JSON.stringify(args)} should fail`)
    assert.match(res.ok ? '' : res.error, pattern)
  }
  assert.deepEqual(calls, [])
  const longest = await server.handle(t, 'set_status', { task: 'x'.repeat(300) })
  assert.equal(longest.ok, true, 'the limit itself is allowed')
})

test('unknown token, revoked token and unknown tool are refused', async () => {
  const { host, calls } = fakeHost()
  const server = new ToolServer(host)
  const t = server.issue(normal)
  assert.match(tokenError(await server.handle('f'.repeat(32), 'list_agents', {})), /unknown or expired token/)
  assert.match(tokenError(await server.handle(t, 'rm_rf', {})), /unknown tool: rm_rf/)
  assert.match(tokenError(await server.handle(t, 'constructor', {})), /unknown tool: constructor/, 'prototype names are not tools')
  server.revoke(t)
  assert.match(tokenError(await server.handle(t, 'list_agents', {})), /unknown or expired token/)
  assert.match(tokenError(await server.handle(t, '__list', {})), /unknown or expired token/)
  assert.deepEqual(calls, [])
  assert.notEqual(server.issue(normal), server.issue(normal), 'tokens are unique')
  assert.match(server.issue(normal), /^[0-9a-f]{32}$/)
})

function tokenError(res: ToolResult): string {
  return res.ok ? `unexpected success: ${res.result}` : res.error
}

test('submit_review needs a review token', async () => {
  const { host, calls } = fakeHost()
  const server = new ToolServer(host)
  const args = { verdict: 'changes', comments: 'rename x' }
  assert.match(tokenError(await server.handle(server.issue(normal), 'submit_review', args)), /only available during a review/)
  assert.deepEqual(calls, [])
  const t = server.issue(review)
  assert.deepEqual(await server.handle(t, 'submit_review', args), { ok: true, result: 'review recorded' })
  await server.handle(t, 'submit_review', { verdict: 'approve', comments: '' })
  assert.deepEqual(calls, [
    { method: 'submitReview', args: ['claude', 'changes', 'rename x'] },
    { method: 'submitReview', args: ['claude', 'approve', ''] },
  ])
  assert.match(tokenError(await server.handle(t, 'submit_review', { verdict: 'maybe', comments: '' })), /verdict must be one of: approve, changes/)
})

test('the host receives the full turn token', async () => {
  const seen: TurnToken[] = []
  const { host } = fakeHost()
  const server = new ToolServer({
    ...host,
    listAgents(from) {
      seen.push(from)
      return 'ok'
    },
  })
  await server.handle(server.issue(review), 'list_agents', {})
  assert.deepEqual(seen, [review])
})

test('__list shows review tools only to review tokens', async () => {
  const server = new ToolServer(fakeHost().host)
  const names = async (turn: TurnToken): Promise<string[]> => {
    const res = await server.handle(server.issue(turn), '__list', undefined)
    assert.equal(res.ok, true)
    const list: { name: string; description: string; inputSchema: unknown }[] = JSON.parse(res.ok ? res.result : '[]')
    for (const t of list) assert.deepEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name'])
    return list.map((t) => t.name)
  }
  const normalNames = await names(normal)
  assert.ok(!normalNames.includes('submit_review'))
  assert.deepEqual(normalNames.sort(), ['ask_user', 'doc_read', 'doc_write', 'list_agents', 'remember', 'send_message', 'set_status'])
  assert.deepEqual((await names(review)).sort(), [...Object.keys(TOOLS)].sort())
})

test('host exceptions and rejections become tool errors', async () => {
  const { host, calls } = fakeHost()
  const server = new ToolServer({
    ...host,
    remember() {
      throw new Error('note cap reached')
    },
    askUser: () => Promise.reject(new Error('user is away')),
  })
  const t = server.issue(normal)
  assert.deepEqual(await server.handle(t, 'send_message', { to: 'nobody', text: 'hi' }), {
    ok: false,
    error: 'no such teammate: nobody (ready: a, b)',
  })
  // A synchronous throw and an async rejection take the same path.
  assert.deepEqual(await server.handle(t, 'remember', { note: 'n' }), { ok: false, error: 'note cap reached' })
  const ask = { questions: [{ question: 'Q?', options: ['a', 'b'] }] }
  assert.deepEqual(await server.handle(t, 'ask_user', ask), { ok: false, error: 'user is away' })
  assert.equal(calls.length, 1)
})

/** Newline-delimited JSON client with a queue of parsed replies. */
function tcpClient(port: number): { socket: net.Socket; write(line: string): void; next(): Promise<Record<string, unknown>>; closed: Promise<void> } {
  const socket = net.connect({ host: '127.0.0.1', port })
  const rl = readline.createInterface({ input: socket })
  const it = rl[Symbol.asyncIterator]()
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
  socket.on('error', () => undefined)
  return {
    socket,
    write: (line) => void socket.write(line),
    async next() {
      const r = await it.next()
      assert.ok(!r.done, 'connection closed before a reply')
      const parsed: unknown = JSON.parse(r.value)
      assert.ok(isRecord(parsed))
      return parsed
    },
    closed,
  }
}

test('TCP: concurrent requests are answered out of order, bad lines do not close the connection', async () => {
  const { host, gate } = fakeHost()
  const server = new ToolServer(host)
  const port = await server.start()
  assert.equal(await server.start(), port, 'start is idempotent')
  const token = server.issue(normal)
  const c = tcpClient(port)
  try {
    const req = (id: number, text: string): string => `${JSON.stringify({ id, token, tool: 'send_message', args: { to: 'b', text, wait: true } })}\n`
    c.write(req(1, 'slow') + req(2, 'fast'))
    assert.deepEqual(await c.next(), { id: 2, ok: true, result: 'sent to b' }, 'the fast call is not blocked by the slow one')
    c.write('this is not json\n')
    assert.deepEqual(await c.next(), { ok: false, error: 'bad request' })
    c.write(`${JSON.stringify({ id: 3, tool: 'list_agents' })}\n`) // no token
    assert.deepEqual(await c.next(), { id: 3, ok: false, error: 'bad request' })
    c.write(`${JSON.stringify({ id: 4, token, tool: 'list_agents', args: {} })}\n`)
    assert.deepEqual(await c.next(), { id: 4, ok: true, result: 'BOARD' }, 'connection still serves after bad lines')
    gate.resolve('late reply')
    assert.deepEqual(await c.next(), { id: 1, ok: true, result: 'late reply' })
    c.write(`${JSON.stringify({ id: 5, token: 'nope', tool: 'list_agents', args: {} })}\n`)
    assert.deepEqual(await c.next(), { id: 5, ok: false, error: 'unknown or expired token' })
    // A request split across two writes is reassembled.
    const whole = JSON.stringify({ id: 6, token, tool: 'list_agents', args: {} })
    c.write(whole.slice(0, 10))
    c.write(`${whole.slice(10)}\n`)
    assert.deepEqual(await c.next(), { id: 6, ok: true, result: 'BOARD' })
  } finally {
    c.socket.destroy()
    await server.close()
  }
})

test('TCP: a connection that sends over 1 MB without a newline is dropped', async () => {
  const server = new ToolServer(fakeHost().host)
  const c = tcpClient(await server.start())
  try {
    c.write('x'.repeat(1_100_000))
    await c.closed
  } finally {
    await server.close()
  }
})

test('close() drops open connections and stops accepting new ones', async () => {
  const server = new ToolServer(fakeHost().host)
  const port = await server.start()
  const c = tcpClient(port)
  c.write(`${JSON.stringify({ id: 1, token: 'x', tool: 'list_agents' })}\n`)
  await c.next() // the connection is established and registered
  await server.close()
  await c.closed
  await server.close() // idempotent
  const { promise, resolve } = Promise.withResolvers<string>()
  const late = net.connect({ host: '127.0.0.1', port })
  late.on('connect', () => resolve('connected'))
  late.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'))
  assert.equal(await promise, 'ECONNREFUSED')
  late.destroy()
  const port2 = await server.start() // a closed server can start again
  assert.ok(port2 > 0)
  await server.close()
})

test('shimSpec points at the compiled shim with the port and token in the environment', () => {
  const spec = shimSpec(4321, 'abc123')
  assert.equal(spec.command, process.execPath)
  assert.deepEqual(spec.args, [fileURLToPath(new URL('./mcp-shim.js', import.meta.url))])
  assert.deepEqual(spec.env, [
    { name: 'PAGER_TOOL_PORT', value: '4321' },
    { name: 'PAGER_TOOL_TOKEN', value: 'abc123' },
  ])
})
