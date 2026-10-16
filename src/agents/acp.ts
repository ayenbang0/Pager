// Minimal Agent Client Protocol client: newline-delimited JSON-RPC 2.0 over a child's stdio.
// Pager only needs prompts, live message/tool updates, slash-command lists and session resume.
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { isRecord } from '../guards.js'
import { VERSION } from '../version.js'

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
  }
}

export interface AcpToolCall {
  id: string
  title: string
  kind: string
  status: string
}
export interface AcpCommand {
  name: string
  description: string
}
export interface AcpHandlers {
  onText(chunk: string): void
  onTool(call: AcpToolCall): void
  onCommands(commands: AcpCommand[]): void
}

type Json = Record<string, unknown>

const STDERR_KEEP = 4096
const STDERR_IN_ERROR = 300
const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_AUTH_REQUIRED = -32000

export class AcpConnection {
  /** While true, session updates are ignored (session/load replays the old transcript). */
  muted = false
  private nextId = 1
  private readonly pending = new Map<number, { resolve(result: Json): void; reject(err: Error): void; timer?: NodeJS.Timeout }>()
  private readonly tools = new Map<string, AcpToolCall>()
  private buffer = ''
  private stderr = ''
  private dead: AcpError | undefined

  constructor(
    private readonly child: ChildProcess,
    private readonly handlers: Partial<AcpHandlers>,
  ) {
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_KEEP)
    })
    child.stdin?.on('error', () => {
      // The agent exited; the close handler reports it.
    })
    child.on('error', (err) => this.fail(new AcpError(`agent failed to start: ${err.message}`)))
    child.on('close', (code) => this.fail(new AcpError(`agent exited (code ${code}): ${this.stderrTail}`.trim())))
  }

  get stderrTail(): string {
    return this.stderr.trim().slice(-STDERR_IN_ERROR)
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<Json> {
    if (this.dead !== undefined) return Promise.reject(this.dead)
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<Json>()
    const entry: { resolve(result: Json): void; reject(err: Error): void; timer?: NodeJS.Timeout } = { resolve, reject }
    if (timeoutMs !== undefined) {
      entry.timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AcpError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
    }
    this.pending.set(id, entry)
    this.send({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  private fail(err: AcpError): void {
    this.dead ??= err
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(this.dead)
      this.pending.delete(id)
    }
  }

  private send(message: Json): void {
    const line = JSON.stringify(message)
    log('>', line)
    this.child.stdin?.write(`${line}\n`)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let at = this.buffer.indexOf('\n')
    while (at >= 0) {
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      if (line !== '') this.onLine(line)
      at = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    log('<', line)
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return // agents may print banners on stdout; only JSON-RPC lines matter
    }
    if (!isRecord(msg)) return
    const { id, method, params } = msg
    if (typeof method === 'string') {
      if (typeof id === 'number' || typeof id === 'string') this.onRequest(id, method, isRecord(params) ? params : {})
      else this.onNotification(method, isRecord(params) ? params : {})
      return
    }
    if (typeof id !== 'number') return
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (isRecord(msg.error)) {
      const { message, code } = msg.error
      entry.reject(new AcpError(typeof message === 'string' ? message : 'request failed', typeof code === 'number' ? code : undefined))
    } else entry.resolve(isRecord(msg.result) ? msg.result : {})
  }

  /** Pager runs agents in a throwaway worktree and always had auto-approval, so permission asks are granted. */
  private onRequest(id: number | string, method: string, params: Json): void {
    if (method !== 'session/request_permission') {
      this.send({ jsonrpc: '2.0', id, error: { code: JSON_RPC_METHOD_NOT_FOUND, message: 'Method not found' } })
      return
    }
    const options = Array.isArray(params.options) ? params.options.filter(isRecord) : []
    const pick = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always')
    const outcome = pick !== undefined && typeof pick.optionId === 'string' ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' }
    this.send({ jsonrpc: '2.0', id, result: { outcome } })
  }

  private onNotification(method: string, params: Json): void {
    if (method !== 'session/update' || !isRecord(params.update)) return
    const update = params.update
    switch (update.sessionUpdate) {
      case 'available_commands_update': {
        const list = Array.isArray(update.availableCommands) ? update.availableCommands.filter(isRecord) : []
        this.handlers.onCommands?.(
          list.flatMap((c) => (typeof c.name === 'string' ? [{ name: c.name, description: typeof c.description === 'string' ? c.description : '' }] : [])),
        )
        return
      }
      case 'agent_message_chunk': {
        if (this.muted || !isRecord(update.content)) return
        if (update.content.type === 'text' && typeof update.content.text === 'string') this.handlers.onText?.(update.content.text)
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (this.muted || typeof update.toolCallId !== 'string') return
        const before = this.tools.get(update.toolCallId)
        const call: AcpToolCall = {
          id: update.toolCallId,
          title: typeof update.title === 'string' ? update.title : (before?.title ?? 'tool'),
          kind: typeof update.kind === 'string' ? update.kind : (before?.kind ?? 'other'),
          status: typeof update.status === 'string' ? update.status : (before?.status ?? 'pending'),
        }
        this.tools.set(call.id, call)
        this.handlers.onTool?.(call)
        return
      }
      default:
        return // thoughts, plans, usage and mode changes are not shown
    }
  }
}

function log(direction: '>' | '<', line: string): void {
  const file = process.env.PAGER_ACP_LOG
  if (file === undefined || file === '') return
  try {
    fs.appendFileSync(file, `${direction} ${line}\n`)
  } catch {
    // debugging aid only
  }
}

/** Handshake; resumes `resumeId` when the agent supports it, otherwise (or on failure) starts a fresh session. */
export async function openSession(
  conn: AcpConnection,
  opts: { cwd: string; resumeId?: string; timeoutMs: number },
): Promise<{ sessionId: string; resumed: boolean }> {
  const init = await conn.request(
    'initialize',
    {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'pager', title: 'pager', version: VERSION },
    },
    opts.timeoutMs,
  )
  const canLoad = isRecord(init.agentCapabilities) && init.agentCapabilities.loadSession === true
  const methodId = (Array.isArray(init.authMethods) ? init.authMethods : []).filter(isRecord).map((m) => m.id).find((id) => typeof id === 'string')
  if (opts.resumeId !== undefined && canLoad) {
    conn.muted = true
    try {
      await conn.request('session/load', { sessionId: opts.resumeId, cwd: opts.cwd, mcpServers: [] }, opts.timeoutMs)
      return { sessionId: opts.resumeId, resumed: true }
    } catch (err) {
      if (!(err instanceof AcpError)) throw err // the stored session is gone or unreadable: start a new one
    } finally {
      conn.muted = false
    }
  }
  const create = (): Promise<Json> => conn.request('session/new', { cwd: opts.cwd, mcpServers: [] }, opts.timeoutMs)
  let created: Json
  try {
    created = await create()
  } catch (err) {
    if (!(err instanceof AcpError) || err.code !== JSON_RPC_AUTH_REQUIRED || methodId === undefined) throw err
    await conn.request('authenticate', { methodId }, opts.timeoutMs)
    created = await create()
  }
  if (typeof created.sessionId !== 'string') throw new AcpError('session/new returned no sessionId')
  return { sessionId: created.sessionId, resumed: false }
}

/** Sends one prompt turn; updates arrive through the connection's handlers. No timeout: the caller kills the child. */
export async function sendPrompt(conn: AcpConnection, sessionId: string, text: string): Promise<{ stopReason: string }> {
  const res = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  return { stopReason: typeof res.stopReason === 'string' ? res.stopReason : 'end_turn' }
}
