import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { isRecord } from '../guards.js'

/** Who a tool call comes from. `chain` lists the agents that delegated down to this turn (cycle checks live in the host). */
export interface TurnToken {
  agent: string
  kind: 'normal' | 'review'
  chain: string[]
}

export interface AskQuestion {
  question: string
  options: string[]
  multi?: boolean
  recommended?: number
}

/** What pager does for each tool. Hosts refuse by throwing `Error(message)`; the message reaches the agent as the tool error. */
export interface ToolHost {
  sendMessage(from: TurnToken, to: string, text: string, wait: boolean): Promise<string>
  listAgents(from: TurnToken): string
  setStatus(from: TurnToken, task: string, fits: string | undefined): string
  askUser(from: TurnToken, questions: AskQuestion[]): Promise<string>
  remember(from: TurnToken, note: string): string
  docRead(from: TurnToken, name: string): string
  docWrite(from: TurnToken, name: string, text: string, append: boolean): string
  submitReview(from: TurnToken, verdict: 'approve' | 'changes', comments: string): string
}

export type ToolResult = { ok: true; result: string } | { ok: false; error: string }

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  reviewOnly?: boolean
}

/** Server tool that returns the tools visible to a token; the stdio shim answers `tools/list` with it. */
export const LIST_TOOL = '__list'
const MAX_LINE_CHARS = 1_000_000
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

/** The one table of tools: the validator, `tools/list` and the docs for agents all read it. */
export const TOOLS: Record<string, ToolDef> = {
  send_message: {
    name: 'send_message',
    description:
      'Send a message to a teammate agent. With wait=true this blocks until that teammate finishes the turn it starts and returns its reply; otherwise it returns at once.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', minLength: 1, maxLength: 48, description: 'Name of the teammate (see list_agents).' },
        text: { type: 'string', minLength: 1, maxLength: 20000, description: 'What to tell them.' },
        wait: { type: 'boolean', description: 'Wait for their reply (default false).' },
      },
      required: ['to', 'text'],
    },
  },
  list_agents: {
    name: 'list_agents',
    description: 'Show the board: the goal, your task and every teammate with their task, files and branch.',
    inputSchema: { type: 'object', properties: {} },
  },
  set_status: {
    name: 'set_status',
    description: 'Tell the team what you are working on now and how it fits the goal. Call it whenever your task changes.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', minLength: 1, maxLength: 300, description: 'Your current task.' },
        fits: { type: 'string', maxLength: 300, description: 'How the task fits the goal.' },
      },
      required: ['task'],
    },
  },
  ask_user: {
    name: 'ask_user',
    description:
      'Ask the user one to four multiple-choice questions and wait for the answers. The user can also type their own answer. Returns {answers:[{question,selected,other?}]} or {cancelled:true}.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', minLength: 1, maxLength: 500 },
              options: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 200 } },
              multi: { type: 'boolean', description: 'Allow choosing several options.' },
              recommended: { type: 'integer', minimum: 0, description: 'Index into options of the suggested choice.' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
  remember: {
    name: 'remember',
    description: 'Save one short note to the repository memory so future turns see it.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', minLength: 1, maxLength: 500 } },
      required: ['note'],
    },
  },
  doc_read: {
    name: 'doc_read',
    description: 'Read a shared document that was shown to you in this turn.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['name'],
    },
  },
  doc_write: {
    name: 'doc_write',
    description: 'Replace (default) or append to a shared document that was shown to you in this turn.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        text: { type: 'string', maxLength: 200000 },
        append: { type: 'boolean', description: 'Append instead of replacing (default false).' },
      },
      required: ['name', 'text'],
    },
  },
  submit_review: {
    name: 'submit_review',
    description: 'Finish a review: approve the change or ask for changes, with comments for the author.',
    inputSchema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['approve', 'changes'] },
        comments: { type: 'string', maxLength: 20000 },
      },
      required: ['verdict', 'comments'],
    },
    reviewOnly: true,
  },
}

/** Checks `value` against the JSON-schema subset used in TOOLS (type, required, properties, items, enum, length and count bounds). */
function validate(value: unknown, schema: unknown, path: string): string | undefined {
  if (!isRecord(schema)) return undefined
  const at = path || 'args'
  const { type } = schema
  if (type === 'object') {
    if (!isRecord(value)) return `${at} must be an object`
    const { required, properties } = schema
    for (const key of Array.isArray(required) ? required : []) {
      if (typeof key === 'string' && value[key] === undefined) return `${path ? `${path}.` : ''}${key} is required`
    }
    for (const [key, sub] of Object.entries(isRecord(properties) ? properties : {})) {
      const v = value[key]
      const err = v === undefined ? undefined : validate(v, sub, path ? `${path}.${key}` : key)
      if (err) return err
    }
    return undefined
  }
  if (type === 'string') {
    if (typeof value !== 'string') return `${at} must be a string`
    const { minLength, maxLength, enum: allowed } = schema
    if (typeof minLength === 'number' && value.length < minLength) return `${at} must not be empty`
    if (typeof maxLength === 'number' && value.length > maxLength) return `${at} is too long (${value.length} > ${maxLength} characters)`
    if (Array.isArray(allowed) && !allowed.includes(value)) return `${at} must be one of: ${allowed.join(', ')}`
    return undefined
  }
  if (type === 'boolean') return typeof value === 'boolean' ? undefined : `${at} must be true or false`
  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return `${at} must be an integer`
    const { minimum } = schema
    return typeof minimum === 'number' && value < minimum ? `${at} must be at least ${minimum}` : undefined
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return `${at} must be an array`
    const { minItems, maxItems, items } = schema
    if (typeof minItems === 'number' && value.length < minItems) return `${at} needs at least ${minItems} items`
    if (typeof maxItems === 'number' && value.length > maxItems) return `${at} allows at most ${maxItems} items`
    for (const [i, item] of value.entries()) {
      const err = validate(item, items, `${path}[${i}]`)
      if (err) return err
    }
  }
  return undefined
}

const strArg = (a: Record<string, unknown>, key: string): string => {
  const v = a[key]
  return typeof v === 'string' ? v : ''
}
const boolArg = (a: Record<string, unknown>, key: string): boolean => a[key] === true

/** Local tool endpoint for agent turns: a token per turn, newline-delimited JSON over loopback TCP. */
export class ToolServer {
  private readonly tokens = new Map<string, TurnToken>()
  private readonly sockets = new Set<net.Socket>()
  private server: net.Server | undefined
  private starting: Promise<number> | undefined

  constructor(private readonly host: ToolHost) {}

  start(): Promise<number> {
    this.starting ??= this.listen()
    return this.starting
  }

  private async listen(): Promise<number> {
    const server = net.createServer((socket) => this.accept(socket))
    this.server = server
    const { promise, resolve, reject } = Promise.withResolvers<number>()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('tool server has no port'))
    })
    try {
      return await promise
    } catch (err) {
      this.server = undefined
      this.starting = undefined
      throw err
    } finally {
      server.off('error', reject)
    }
  }

  private accept(socket: net.Socket): void {
    if (!socket.remoteAddress || !LOOPBACK.includes(socket.remoteAddress)) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    let pending = ''
    socket.on('data', (chunk: string) => {
      pending += chunk
      let nl = pending.indexOf('\n')
      while (nl >= 0) {
        const line = pending.slice(0, nl).trim()
        pending = pending.slice(nl + 1)
        if (line) void this.serve(socket, line)
        nl = pending.indexOf('\n')
      }
      if (pending.length > MAX_LINE_CHARS) socket.destroy()
    })
  }

  private async serve(socket: net.Socket, line: string): Promise<void> {
    let id: unknown
    let reply: Record<string, unknown>
    try {
      const req: unknown = JSON.parse(line)
      if (isRecord(req)) id = req.id
      if (!isRecord(req) || typeof req.token !== 'string' || typeof req.tool !== 'string') throw new Error('bad request')
      const res = await this.handle(req.token, req.tool, req.args)
      reply = res.ok ? { ok: true, result: res.result } : { ok: false, error: res.error }
    } catch {
      reply = { ok: false, error: 'bad request' }
    }
    if (id !== undefined) reply.id = id
    if (socket.writable) socket.write(`${JSON.stringify(reply)}\n`)
  }

  issue(turn: TurnToken): string {
    const token = randomBytes(16).toString('hex')
    this.tokens.set(token, turn)
    return token
  }

  revoke(token: string): void {
    this.tokens.delete(token)
  }

  async handle(token: string, tool: string, args: unknown): Promise<ToolResult> {
    const turn = this.tokens.get(token)
    if (!turn) return { ok: false, error: 'unknown or expired token' }
    if (tool === LIST_TOOL) {
      const visible = Object.values(TOOLS).filter((t) => !t.reviewOnly || turn.kind === 'review')
      const list = visible.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      return { ok: true, result: JSON.stringify(list) }
    }
    const def = Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : undefined
    if (!def) return { ok: false, error: `unknown tool: ${tool}` }
    if (def.reviewOnly && turn.kind !== 'review') return { ok: false, error: `${tool} is only available during a review` }
    const input = args ?? {}
    const bad = validate(input, def.inputSchema, '')
    if (bad || !isRecord(input)) return { ok: false, error: bad ?? 'args must be an object' }
    try {
      return { ok: true, result: await this.call(turn, tool, input) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async call(turn: TurnToken, tool: string, a: Record<string, unknown>): Promise<string> {
    const host = this.host
    switch (tool) {
      case 'send_message':
        return host.sendMessage(turn, strArg(a, 'to'), strArg(a, 'text'), boolArg(a, 'wait'))
      case 'list_agents':
        return host.listAgents(turn)
      case 'set_status': {
        const fits = strArg(a, 'fits')
        return host.setStatus(turn, strArg(a, 'task'), fits === '' ? undefined : fits)
      }
      case 'ask_user': {
        const questions: AskQuestion[] = []
        for (const raw of Array.isArray(a.questions) ? a.questions : []) {
          if (!isRecord(raw)) continue
          const options = (Array.isArray(raw.options) ? raw.options : []).filter((o): o is string => typeof o === 'string')
          const q: AskQuestion = { question: strArg(raw, 'question'), options }
          if (raw.multi === true) q.multi = true
          if (typeof raw.recommended === 'number') {
            if (raw.recommended >= options.length) throw new Error(`recommended ${raw.recommended} is not an index into the ${options.length} options`)
            q.recommended = raw.recommended
          }
          questions.push(q)
        }
        return host.askUser(turn, questions)
      }
      case 'remember':
        return host.remember(turn, strArg(a, 'note'))
      case 'doc_read':
        return host.docRead(turn, strArg(a, 'name'))
      case 'doc_write':
        return host.docWrite(turn, strArg(a, 'name'), strArg(a, 'text'), boolArg(a, 'append'))
      case 'submit_review':
        return host.submitReview(turn, strArg(a, 'verdict') === 'approve' ? 'approve' : 'changes', strArg(a, 'comments'))
      default:
        throw new Error(`unknown tool: ${tool}`)
    }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.starting = undefined
    this.tokens.clear()
    for (const s of this.sockets) s.destroy()
    if (!server) return
    const { promise, resolve } = Promise.withResolvers<void>()
    server.close(() => resolve())
    await promise
  }
}

/** The MCP stdio server spec handed to an agent for one turn: a node child that bridges to this ToolServer. */
export function shimSpec(port: number, token: string): { command: string; args: string[]; env: { name: string; value: string }[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-shim.js', import.meta.url))],
    env: [
      { name: 'PAGER_TOOL_PORT', value: String(port) },
      { name: 'PAGER_TOOL_TOKEN', value: token },
    ],
  }
}
