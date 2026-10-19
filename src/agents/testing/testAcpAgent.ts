// Fake ACP agent used by acp tests: `node testAcpAgent.js` speaks JSON-RPC over stdio.
// Message lines (after the NEW MESSAGES marker): ECHO text | TOOL title | WRITE f=x | CWD | SESSION | PERM [{toolCall fields json}] | SLEEP ms | FAIL
//   | MCP | CFG | USAGE used/size | ELICIT {requestedSchema json} | PAGER name {json}
// Env: TEST_ACP_BAD_INIT=1 makes `initialize` fail; TEST_ACP_NO_LOAD=1 hides the loadSession capability.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { isRecord } from '../../util/guards.js'
import { MESSAGES_MARKER } from '../run/protocol.js'

const cwds = new Map<string, string>()
const loaded = new Set<string>()
const mcp = new Map<string, Record<string, unknown>[]>()
const config = new Map<string, Record<string, string>>()
const waiting = new Map<number, (result: Record<string, unknown>) => void>()
let nextOutgoing = 1000
let clientCaps: Record<string, unknown> = {}

const send = (message: object): void => void process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const update = (sessionId: string, body: Record<string, unknown>): void =>
  send({ method: 'session/update', params: { sessionId, update: body } })
const say = (sessionId: string, text: string): void =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${text}\n` } })

/** A request to the client; resolves with its result. */
function ask(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextOutgoing++
  const answered = new Promise<Record<string, unknown>>((resolve) => waiting.set(id, resolve))
  send({ id, method, params })
  return answered
}

const configOptions = (sessionId: string): object[] => {
  const now = config.get(sessionId) ?? {}
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: now.model ?? 'fast-1',
      options: [
        { value: 'fast-1', name: 'Fast' },
        { value: 'smart-2', name: 'Smart' },
      ],
    },
    {
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: now.thinking ?? 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
  ]
}

/** One call to the pager tool server, using the env the client put in the session's mcpServers. */
function pagerTool(sessionId: string, tool: string, args: unknown): Promise<string> {
  const env = (mcp.get(sessionId)?.[0]?.env ?? []) as { name: string; value: string }[]
  const pick = (name: string): string => env.find((e) => e.name === name)?.value ?? ''
  const { promise, resolve } = Promise.withResolvers<string>()
  const socket = net.connect(Number(pick('PAGER_TOOL_PORT')), '127.0.0.1', () => socket.write(`${JSON.stringify({ id: 1, token: pick('PAGER_TOOL_TOKEN'), tool, args })}\n`))
  let buf = ''
  socket.on('data', (d) => {
    buf += d.toString()
    if (!buf.includes('\n')) return
    socket.end()
    const res = JSON.parse(buf.split('\n')[0] ?? '{}') as { ok?: boolean; result?: string; error?: string }
    resolve(res.ok === true ? `ok ${res.result}` : `error ${res.error}`)
  })
  socket.on('error', (e) => resolve(`error ${e.message}`))
  return promise
}

async function runTask(sessionId: string, task: string): Promise<void> {
  const cwd = cwds.get(sessionId) ?? process.cwd()
  for (const raw of task.split('\n')) {
    const line = raw.replace(/^\[[^\]\s]+ \w+\](?: \(also sent to: [^)]*\))? ?/, '')
    const [, op = '', arg = ''] = /^(\w+)\s?(.*)$/.exec(line.trim()) ?? []
    if (op === 'ECHO') say(sessionId, arg)
    else if (op === 'TOOL') {
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `t-${arg}`, title: arg, kind: arg.split(' ', 1)[0], status: 'pending' })
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: `t-${arg}`, status: 'completed' })
    } else if (op === 'WRITE') {
      const eq = arg.indexOf('=')
      fs.writeFileSync(path.join(cwd, arg.slice(0, eq)), arg.slice(eq + 1))
    } else if (op === 'CWD') say(sessionId, `cwd:${cwd}`)
    else if (op === 'SESSION') say(sessionId, `session:${sessionId} loaded:${loaded.has(sessionId)}`)
    else if (op === 'MCP') say(sessionId, `mcp:${mcp.get(sessionId)?.map((s) => String(s.name)).join(',') ?? 'none'}`)
    else if (op === 'CFG') say(sessionId, `cfg:${JSON.stringify(config.get(sessionId) ?? {})}`)
    else if (op === 'CAPS') say(sessionId, `caps:${JSON.stringify(clientCaps)}`)
    else if (op === 'USAGE') {
      const [used = '0', size = '1'] = arg.split('/')
      update(sessionId, { sessionUpdate: 'usage_update', used: Number(used), size: Number(size) })
    } else if (op === 'ELICIT') {
      const result = await ask('elicitation/create', { mode: 'form', sessionId, message: 'pick one', ...(JSON.parse(arg) as object) })
      say(sessionId, `elicit:${JSON.stringify(result)}`)
    } else if (op === 'PAGER') {
      const space = arg.indexOf(' ')
      say(sessionId, `pager ${arg.slice(0, space < 0 ? undefined : space)}: ${await pagerTool(sessionId, space < 0 ? arg : arg.slice(0, space), space < 0 ? {} : JSON.parse(arg.slice(space + 1)))}`)
    } else if (op === 'PERM') {
      const result = await ask('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 't-perm', ...(arg === '' ? {} : (JSON.parse(arg) as object)) },
        options: [
          { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
          { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
        ],
      })
      const outcome = isRecord(result.outcome) ? result.outcome : {}
      say(sessionId, `perm:${String(outcome.optionId)}`)
    } else if (op === 'SLEEP') await sleep(Number(arg))
    else if (op === 'FAIL') {
      // Flush the earlier chunks before dying so the client sees them.
      process.stderr.write('boom\n', () => process.stdout.write('', () => process.exit(3)))
      await sleep(60_000)
    }
  }
}

async function handle(msg: Record<string, unknown>): Promise<void> {
  const { id, method } = msg
  const params = isRecord(msg.params) ? msg.params : {}
  if (typeof method !== 'string') {
    if (typeof id === 'number') waiting.get(id)?.(isRecord(msg.result) ? msg.result : {})
    return
  }
  const servers = (Array.isArray(params.mcpServers) ? params.mcpServers.filter(isRecord) : []) as Record<string, unknown>[]
  if (method === 'initialize') {
    if (process.env.TEST_ACP_BAD_INIT === '1') return send({ id, error: { code: -32603, message: 'bad init' } })
    clientCaps = isRecord(params.clientCapabilities) ? params.clientCapabilities : {}
    return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: process.env.TEST_ACP_NO_LOAD !== '1' }, authMethods: [] } })
  }
  if (method === 'session/new') {
    const sessionId = `sess-${randomBytes(3).toString('hex')}`
    cwds.set(sessionId, String(params.cwd))
    mcp.set(sessionId, servers)
    send({ id, result: { sessionId, configOptions: configOptions(sessionId) } })
    return update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes' }, { name: 'usage', description: 'Show usage' }, { name: 'compact', description: 'Compact context', input: { hint: 'focus' } }] })
  }
  if (method === 'session/load') {
    const sessionId = String(params.sessionId)
    if (!sessionId.startsWith('sess-')) return send({ id, error: { code: -32602, message: 'unknown session' } })
    cwds.set(sessionId, String(params.cwd))
    mcp.set(sessionId, servers)
    loaded.add(sessionId)
    // A real agent replays the old transcript; the client must not show it.
    update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } })
    say(sessionId, 'REPLAYED')
    return send({ id, result: { configOptions: configOptions(sessionId) } })
  }
  if (method === 'session/set_config_option') {
    const sessionId = String(params.sessionId)
    config.set(sessionId, { ...config.get(sessionId), [String(params.configId)]: String(params.value) })
    return send({ id, result: { configOptions: configOptions(sessionId) } })
  }
  if (method === 'session/prompt') {
    const sessionId = String(params.sessionId)
    const blocks = Array.isArray(params.prompt) ? params.prompt.filter(isRecord) : []
    const text = blocks.map((b) => String(b.text)).join('\n')
    if (!text.includes(MESSAGES_MARKER)) say(sessionId, `raw: ${text}`)
    await runTask(sessionId, text.split(MESSAGES_MARKER)[1] ?? '')
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  send({ id, error: { code: -32601, message: 'Method not found' } })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  try {
    const msg: unknown = JSON.parse(line)
    if (isRecord(msg)) void handle(msg)
  } catch {
    // ignore garbage
  }
})
rl.on('close', () => process.exit(0))
