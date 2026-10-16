// Fake ACP agent used by acp tests: `node testAcpAgent.js` speaks JSON-RPC over stdio.
// Task lines (after the TASK marker): ECHO text | TOOL title | WRITE f=x | CWD | SESSION | PERM | SLEEP ms | FAIL | ASK agent: request
// Env: TEST_ACP_BAD_INIT=1 makes `initialize` fail; TEST_ACP_NO_LOAD=1 hides the loadSession capability.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { isRecord } from '../guards.js'
import { REPLIES_MARKER, TASK_MARKER } from './protocol.js'

const cwds = new Map<string, string>()
const loaded = new Set<string>()
const waiting = new Map<number, (result: Record<string, unknown>) => void>()
let nextOutgoing = 1000

const send = (message: object): void => void process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const update = (sessionId: string, body: Record<string, unknown>): void =>
  send({ method: 'session/update', params: { sessionId, update: body } })
const say = (sessionId: string, text: string): void =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${text}\n` } })

async function runTask(sessionId: string, taskText: string): Promise<void> {
  const [task = '', replyText] = taskText.split(REPLIES_MARKER)
  const cwd = cwds.get(sessionId) ?? process.cwd()
  for (const line of task.split('\n')) {
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
    else if (op === 'PERM') {
      const id = nextOutgoing++
      const answered = new Promise<Record<string, unknown>>((resolve) => waiting.set(id, resolve))
      send({
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 't-perm' },
          options: [
            { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
            { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
          ],
        },
      })
      const result = await answered
      const outcome = isRecord(result.outcome) ? result.outcome : {}
      say(sessionId, `perm:${String(outcome.optionId)}`)
    } else if (op === 'SLEEP') await sleep(Number(arg))
    else if (op === 'FAIL') {
      // Flush the earlier chunks before dying so the client sees them.
      process.stderr.write('boom\n', () => process.stdout.write('', () => process.exit(3)))
      await sleep(60_000)
    } else if (op === 'ASK' && replyText === undefined) {
      const colon = arg.indexOf(':')
      say(sessionId, `@@ask ${arg.slice(0, colon).trim()}\n${arg.slice(colon + 1).trim()}\n@@end`)
    }
  }
  if (replyText !== undefined) say(sessionId, `replies: ${replyText.trim()}`)
}

async function handle(msg: Record<string, unknown>): Promise<void> {
  const { id, method } = msg
  const params = isRecord(msg.params) ? msg.params : {}
  if (typeof method !== 'string') {
    if (typeof id === 'number') waiting.get(id)?.(isRecord(msg.result) ? msg.result : {})
    return
  }
  if (method === 'initialize') {
    if (process.env.TEST_ACP_BAD_INIT === '1') return send({ id, error: { code: -32603, message: 'bad init' } })
    return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: process.env.TEST_ACP_NO_LOAD !== '1' }, authMethods: [] } })
  }
  if (method === 'session/new') {
    const sessionId = `sess-${randomBytes(3).toString('hex')}`
    cwds.set(sessionId, String(params.cwd))
    send({ id, result: { sessionId } })
    return update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes' }] })
  }
  if (method === 'session/load') {
    const sessionId = String(params.sessionId)
    if (!sessionId.startsWith('sess-')) return send({ id, error: { code: -32602, message: 'unknown session' } })
    cwds.set(sessionId, String(params.cwd))
    loaded.add(sessionId)
    // A real agent replays the old transcript; the client must not show it.
    update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } })
    say(sessionId, 'REPLAYED')
    return send({ id, result: {} })
  }
  if (method === 'session/prompt') {
    const sessionId = String(params.sessionId)
    const blocks = Array.isArray(params.prompt) ? params.prompt.filter(isRecord) : []
    const text = blocks.map((b) => String(b.text)).join('\n')
    if (!text.includes(TASK_MARKER)) say(sessionId, `raw: ${text}`)
    await runTask(sessionId, text.split(TASK_MARKER)[1] ?? '')
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
