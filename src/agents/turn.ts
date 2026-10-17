// Runs one agent turn as a child process: over ACP when the agent has it, otherwise as a one-shot CLI call.
import type { ChildProcess } from 'node:child_process'
import type { AdapterSpec, RunOptions } from './adapters.js'
import {
  AcpConnection,
  openSession,
  sendPrompt,
  setConfigOption,
  type AcpCommand,
  type AcpConfigOption,
  type AcpHandlers,
  type McpServerSpec,
} from './acp.js'
import { killTree, runProcess, startProcess } from './process.js'
import { errMsg } from './store.js'

export const ACP_OPEN_TIMEOUT_MS = 20_000
export const ACP_PROBE_TIMEOUT_MS = 15_000
export const ACP_EXIT_GRACE_MS = 1500
export const COMMANDS_WAIT_MS = 500

export type Reply = { kind: 'text'; text: string; stopReason: string } | { kind: 'failed'; reason: string } | { kind: 'cancelled' }
export type AcpReply = Reply | { kind: 'fallback'; reason: string }

/** Closes the agent's stdin and waits for it to exit, killing the process tree after `graceMs`. */
export async function endChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.stdin?.end()
  const kill = setTimeout(() => killTree(child), graceMs)
  await closed
  clearTimeout(kill)
}

export interface AcpTurn {
  bin: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  prompt: string
  /** The stored session to resume, when the agent supports it. */
  resumeId: string | undefined
  mcpServers: McpServerSpec[]
  want: RunOptions
  handlers: Partial<AcpHandlers>
  timeoutMs: number
  isCancelled(): boolean
  onChild(child: ChildProcess | undefined): void
  timeoutReason(): string
}

export interface AcpOutcome {
  reply: AcpReply
  sessionId?: string
  /** The agent's own lists of models and thinking levels, as of the end of the turn. */
  options: AcpConfigOption[]
  /** Settings that could not be applied (the agent rejected them). */
  notes: string[]
}

/** Maps a wanted model or effort onto the agent's advertised option of that category. */
async function applyWanted(conn: AcpConnection, sessionId: string, options: AcpConfigOption[], want: RunOptions, notes: string[]): Promise<AcpConfigOption[]> {
  let latest = options
  const wanted: [string, string | undefined][] = [
    ['model', want.model],
    ['thought_level', want.effort],
  ]
  for (const [category, value] of wanted) {
    const option = latest.find((o) => o.category === category)
    if (value === undefined || option === undefined || option.current === value) continue
    try {
      const updated = await setConfigOption(conn, sessionId, option.id, value)
      if (updated.length > 0) latest = updated
    } catch (err) {
      notes.push(`could not set ${category} to ${value}: ${errMsg(err)}`)
    }
  }
  return latest
}

/**
 * One ACP child per turn, working in the agent's worktree. The agent's own session is resumed when possible so it
 * remembers earlier tasks; any trouble before the prompt is sent falls back to the one-shot path.
 */
export async function runViaAcp(turn: AcpTurn): Promise<AcpOutcome> {
  const child = startProcess(turn.bin, turn.args, { cwd: turn.cwd, env: turn.env, stdin: 'pipe' })
  turn.onChild(child)
  if (turn.isCancelled()) killTree(child)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, turn.timeoutMs)
  const conn = new AcpConnection(child, turn.handlers)
  const notes: string[] = []
  let options: AcpConfigOption[] = []
  try {
    let session
    try {
      session = await openSession(conn, { cwd: turn.cwd, resumeId: turn.resumeId, timeoutMs: ACP_OPEN_TIMEOUT_MS, mcpServers: turn.mcpServers })
    } catch (err) {
      return { reply: turn.isCancelled() ? { kind: 'cancelled' } : { kind: 'fallback', reason: timedOut ? turn.timeoutReason() : errMsg(err) }, options, notes }
    }
    options = await applyWanted(conn, session.sessionId, session.configOptions, turn.want, notes)
    turn.handlers.onConfig?.(options)
    let stopReason: string
    try {
      stopReason = (await sendPrompt(conn, session.sessionId, turn.prompt)).stopReason
    } catch (err) {
      const reply: Reply = turn.isCancelled() ? { kind: 'cancelled' } : { kind: 'failed', reason: timedOut ? turn.timeoutReason() : errMsg(err) }
      return { reply, options, notes }
    }
    if (turn.isCancelled()) return { reply: { kind: 'cancelled' }, options, notes }
    return { reply: { kind: 'text', text: '', stopReason }, sessionId: session.sessionId, options, notes }
  } finally {
    clearTimeout(timer)
    await endChild(child, ACP_EXIT_GRACE_MS)
    turn.onChild(undefined)
  }
}

export interface OneShotTurn {
  bin: string
  spec: AdapterSpec
  prompt: string
  cwd: string
  env: NodeJS.ProcessEnv
  want: RunOptions
  timeoutMs: number
  isCancelled(): boolean
  onChild(child: ChildProcess | undefined): void
  timeoutReason(): string
}

export async function runOneShot(turn: OneShotTurn): Promise<Reply> {
  if (turn.spec.args === undefined) return { kind: 'failed', reason: 'this agent needs its ACP mode, which is not available' }
  let res
  try {
    res = await runProcess(turn.bin, turn.spec.args(turn.prompt, turn.cwd, turn.want), {
      cwd: turn.cwd,
      env: turn.env,
      timeoutMs: turn.timeoutMs,
      onSpawn: (c) => {
        turn.onChild(c)
        if (turn.isCancelled()) killTree(c)
      },
    })
  } catch (err) {
    return turn.isCancelled() ? { kind: 'cancelled' } : { kind: 'failed', reason: errMsg(err) }
  }
  turn.onChild(undefined)
  if (turn.isCancelled()) return { kind: 'cancelled' }
  if (res.timedOut) return { kind: 'failed', reason: turn.timeoutReason() }
  if (res.code !== 0) return { kind: 'failed', reason: `exit ${res.code}: ${res.stderr.trim().slice(-300)}` }
  return { kind: 'text', text: (turn.spec.extract ?? ((s: string) => s.trim()))(res.stdout), stopReason: 'end_turn' }
}

export type Probe = { ok: true; commands: AcpCommand[]; options: AcpConfigOption[] } | { ok: false; error: string }

/** Starts an agent's ACP server in `dir` and handshakes; also captures the first command list the agent advertises. */
export async function probeAcp(bin: string, args: string[], dir: string, env: NodeJS.ProcessEnv, waitMs = COMMANDS_WAIT_MS): Promise<Probe> {
  const child = startProcess(bin, args, { cwd: dir, env, stdin: 'pipe' })
  let commands: AcpCommand[] = []
  const got = Promise.withResolvers<void>()
  const conn = new AcpConnection(child, {
    onCommands: (list) => {
      commands = list
      got.resolve()
    },
  })
  try {
    const session = await openSession(conn, { cwd: dir, timeoutMs: ACP_PROBE_TIMEOUT_MS })
    const wait = setTimeout(() => got.resolve(), waitMs)
    await got.promise
    clearTimeout(wait)
    return { ok: true, commands, options: session.configOptions }
  } catch (err) {
    return { ok: false, error: errMsg(err) }
  } finally {
    await endChild(child, 0)
  }
}
