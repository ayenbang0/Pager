import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { ChildProcess } from 'node:child_process'
import type { MessageView, Toast, ToastKind } from '../engine.js'
import { ADAPTERS, AGENT_NAMES, findBinary, isAgentName, type AdapterSpec, type AgentName } from './adapters.js'
import { isRecord } from '../guards.js'
import {
  addWorktree,
  aheadCount,
  changedFiles,
  commitAll,
  headSha,
  isAncestor,
  isDirty,
  mergeBranch,
  removeWorktree,
  repoRoot,
} from './git.js'
import { AcpConnection, openSession, sendPrompt, type AcpCommand } from './acp.js'
import { LiveMessage } from './live.js'
import { killTree, runProcess, startProcess } from './process.js'
import {
  buildPrompt,
  chainTask,
  MEMORY_FILE_MAX_CHARS,
  NOTE_MAX_CHARS,
  parseAsks,
  parseChain,
  parseRemember,
  splitArgs,
  withReplies,
  type Ask,
} from './protocol.js'

export const ROOM_ID = 'agents'
export const MAX_CONCURRENT = 3
export const CLI_OUTPUT_MAX = 100_000
export const MAX_RUNS_PER_THREAD = 10
export const MAX_ASK_DEPTH = 3
export const RUN_TIMEOUT_MS = 900_000
export const CHECK_TIMEOUT_MS = 120_000
export const ROOM_MAX_MESSAGES = 500
export const ACP_OPEN_TIMEOUT_MS = 20_000
export const ACP_PROBE_TIMEOUT_MS = 15_000
export const ACP_EXIT_GRACE_MS = 1500
export const COMMANDS_WAIT_MS = 5000

export type RunState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export interface RunView {
  id: string
  agent: AgentName
  state: RunState
  files: number
  mergeable: boolean
}
export interface RoomView {
  id: typeof ROOM_ID
  unread: number
  runs: RunView[]
}
export interface OrchestratorOptions {
  dataDir: string
  workdir: string
  /** Test seam: replaces entries of ADAPTERS. */
  adapters?: Partial<Record<AgentName, AdapterSpec>>
  limits?: Partial<{ maxConcurrent: number; maxRunsPerThread: number; runTimeoutMs: number }>
}

interface Thread {
  root: string
  /** Ref the next run is created from. */
  tip: string
  /** Sha the thread started from. */
  start: string
  runs: number
  cancelled: boolean
}
interface Run {
  id: string
  agent: AgentName
  thread: Thread
  state: RunState
  branch: string
  dir: string
  files: string[]
  merged: boolean
  child?: ChildProcess
}
interface RoomEntry {
  n: number
  ts: number
  author: string
  authorKey: string
  kind: 'text' | 'system'
  text: string
}
interface Outcome {
  runId: string
  text: string
  asks: Ask[]
  /** False when the run failed; a chain stops there. */
  ok: boolean
}

class CancelledError extends Error {}

function isRoomEntry(x: unknown): x is RoomEntry {
  return (
    typeof x === 'object' &&
    x !== null &&
    'n' in x &&
    typeof x.n === 'number' &&
    'ts' in x &&
    typeof x.ts === 'number' &&
    'author' in x &&
    typeof x.author === 'string' &&
    'authorKey' in x &&
    typeof x.authorKey === 'string' &&
    'kind' in x &&
    (x.kind === 'text' || x.kind === 'system') &&
    'text' in x &&
    typeof x.text === 'string'
  )
}

/** Directory-safe id for a repository: readable name plus a hash of its absolute path. */
export function repoKey(root: string): string {
  return `${path.basename(root)}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`
}

type Reply = { kind: 'text'; text: string; stopReason: string } | { kind: 'failed'; reason: string } | { kind: 'cancelled' }

/** Closes the agent's stdin and waits for it to exit, killing the process tree after `graceMs`. */
async function endChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.stdin?.end()
  const kill = setTimeout(() => killTree(child), graceMs)
  await closed
  clearTimeout(kill)
}

const ZERO_KEY = '0'.repeat(64)

export class Orchestrator extends EventEmitter {
  private readonly adapters: Record<AgentName, AdapterSpec>
  private readonly limits: { maxConcurrent: number; maxRunsPerThread: number; runTimeoutMs: number }
  private readonly runs = new Map<string, Run>()
  private readonly log: RoomEntry[] = []
  private readonly inflight = new Set<Promise<void>>()
  private readonly waiters: { thread: Thread; wake: (granted: boolean) => void }[] = []
  private active = 0
  private counter = 0
  private readN = 0
  private closing = false
  private readonly live = new Set<Thread>()
  private mergeQueue: Promise<void> = Promise.resolve()
  private root: string | undefined
  private readonly env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' }

  private readonly roomFile: string
  private readonly sessionFile: string
  /** Each agent's own ACP session id per repository, so its memory continues between runs. */
  private readonly sessions = new Map<string, Partial<Record<AgentName, string>>>()
  private readonly busySessions = new Set<string>()
  private readonly commandCache = new Map<AgentName, AcpCommand[]>()

  constructor(private readonly opts: OrchestratorOptions) {
    super()
    this.roomFile = path.join(opts.dataDir, 'agents-room.jsonl')
    this.sessionFile = path.join(opts.dataDir, 'agent-sessions.json')
    this.adapters = { ...ADAPTERS, ...opts.adapters }
    this.limits = {
      maxConcurrent: opts.limits?.maxConcurrent ?? MAX_CONCURRENT,
      maxRunsPerThread: opts.limits?.maxRunsPerThread ?? MAX_RUNS_PER_THREAD,
      runTimeoutMs: opts.limits?.runTimeoutMs ?? RUN_TIMEOUT_MS,
    }
    this.restore()
    this.loadSessions()
  }

  room(): RoomView {
    return {
      id: ROOM_ID,
      unread: this.log.filter((e) => e.n > this.readN && e.author !== 'you').length,
      runs: [...this.runs.values()].map((r) => ({
        id: r.id,
        agent: r.agent,
        state: r.state,
        files: r.files.length,
        mergeable: r.state === 'done' && !r.merged && r.files.length > 0,
      })),
    }
  }

  messages(limit: number): MessageView[] {
    return this.log.slice(-limit).map((e) => ({
      key: `room:${e.n}`,
      ts: e.ts,
      authorName: e.author,
      authorKey: e.authorKey,
      mine: e.author === 'you',
      kind: e.kind,
      text: e.text,
      status: null,
      markdown: e.kind === 'text' && e.author !== 'you',
    }))
  }

  markRead(): void {
    this.readN = this.counter
  }

  say(text: string): void {
    this.append('you', 'text', text)
    const m = /^@(\w+(?:>\w+)*)\s+([\s\S]+)$/.exec(text.trim())
    const name = m?.[1]?.toLowerCase()
    const rest = m?.[2]?.trim()
    const chain = name === undefined ? undefined : parseChain(name)
    if (rest === undefined || name === undefined) {
      this.toast('warn', 'Start with @omp, @claude, @opencode or @hermes (or @omp>claude to chain)')
    } else if (chain !== undefined) {
      void this.chain(chain, rest, false)
    } else if (!isAgentName(name)) {
      this.toast('warn', 'Start with @omp, @claude, @opencode or @hermes (or @omp>claude to chain)')
    } else if (rest.startsWith('!')) {
      const argv = splitArgs(rest.slice(1))
      if (argv.length === 0) this.toast('error', `Usage: @${name} !<cli arguments>`)
      else void this.cli(name, argv)
    } else void this.ask(name, rest, false)
  }

  ask(agent: AgentName, task: string, log = true): Promise<void> {
    return this.track(this.startThread([agent], task, log))
  }

  /** Runs the agents in turn; each continues from the previous one's commit and reviews its work. */
  chain(agents: AgentName[], task: string, log = true): Promise<void> {
    return this.track(this.startThread(agents, task, log))
  }

  private track(p: Promise<void>): Promise<void> {
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
    return p
  }

  stop(target: string): void {
    const threads = new Set<Thread>()
    if (target === 'all') {
      for (const r of this.runs.values()) if (r.state === 'queued' || r.state === 'running') threads.add(r.thread)
    } else {
      const run = this.find(target)
      if (run === undefined) return
      if (run.state !== 'queued' && run.state !== 'running') return this.toast('error', 'No running agent')
      threads.add(run.thread)
    }
    if (threads.size === 0) return this.toast('error', 'No running agent')
    this.cancel(threads)
    this.toast('info', 'Stopped')
  }

  /** Marks threads cancelled, kills their children and wakes their queued runs. */
  private cancel(threads: ReadonlySet<Thread>): void {
    for (const t of threads) t.cancelled = true
    for (const r of this.runs.values()) if (threads.has(r.thread) && r.child !== undefined) killTree(r.child)
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]
      if (w !== undefined && threads.has(w.thread)) {
        this.waiters.splice(i, 1)
        w.wake(false)
      }
    }
  }

  merge(target: string): Promise<void> {
    const job = this.mergeQueue.then(() => this.doMerge(target)).catch((err: unknown) => this.toast('error', errMsg(err)))
    this.mergeQueue = job
    return job
  }

  async drop(target: string): Promise<void> {
    const victims: Run[] = []
    if (target === 'all') {
      for (const r of this.runs.values()) if (r.state !== 'queued' && r.state !== 'running') victims.push(r)
    } else {
      const run = this.find(target)
      if (run === undefined) return
      if (run.state === 'queued' || run.state === 'running') return this.toast('error', 'Stop it first')
      victims.push(run)
    }
    for (const r of victims) {
      await removeWorktree(r.thread.root, r.dir, r.branch)
      this.runs.delete(r.id)
    }
    this.emit('change')
    this.toast('info', `Dropped ${victims.length} run(s)`)
  }

  list(): void {
    if (this.runs.size === 0) return this.append('pager', 'system', 'No agent runs yet.')
    for (const r of this.runs.values()) {
      this.append('pager', 'system', `${r.id}  ${r.state}  ${r.files.length} file(s)${r.merged ? '  merged' : ''}`)
    }
  }

  /** Runs the agent's own CLI with `argv` (e.g. `mcp list`, `models`) in the working directory and posts its output. */
  cli(agent: AgentName, argv: string[]): Promise<void> {
    return this.track(this.runCli(agent, argv))
  }

  private async runCli(agent: AgentName, argv: string[]): Promise<void> {
    const found = await this.resolveBin(agent)
    if ('error' in found) return this.toast('error', found.error)
    this.append('you', 'text', `$ ${agent} ${argv.join(' ')}`)
    try {
      const res = await runProcess(found.bin, argv, { cwd: this.opts.workdir, env: this.env, timeoutMs: CHECK_TIMEOUT_MS })
      const body = stripVTControlCharacters([res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean).join('\n')).replaceAll('\r\n', '\n')
      const status = res.timedOut ? '(timed out; only non-interactive commands work here)' : res.code === 0 ? '' : `(exit ${res.code})`
      this.append(agent, 'text', [body.slice(0, CLI_OUTPUT_MAX), status].filter(Boolean).join('\n') || '(no output)')
    } catch (err) {
      this.append(agent, 'text', `(failed: ${errMsg(err)})`)
    }
  }

  async check(): Promise<void> {
    await Promise.all(
      AGENT_NAMES.map(async (name) => {
        const found = await this.resolveBin(name)
        if ('error' in found) return this.append('pager', 'system', `${name}: ${found.error}`)
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-check-'))
        const started = Date.now()
        try {
          const adapter = this.adapters[name]
          const res = await runProcess(found.bin, adapter.args('Reply with exactly: PAGER_OK', dir), {
            cwd: dir,
            env: this.env,
            timeoutMs: CHECK_TIMEOUT_MS,
          })
          const secs = ((Date.now() - started) / 1000).toFixed(1)
          if (adapter.extract(res.stdout).includes('PAGER_OK')) {
            const acp = adapter.acp !== undefined && process.env.PAGER_NO_ACP !== '1' ? await this.probeAcp(found.bin, adapter.acp, dir) : ''
            this.append('pager', 'system', `${name}: ok (${secs}s)${acp}`)
          } else {
            const tail = (res.stderr.trim() || res.stdout.trim()).slice(-200)
            this.append('pager', 'system', `${name}: failed (exit ${res.code}) ${tail}`)
          }
        } catch (err) {
          this.append('pager', 'system', `${name}: failed ${errMsg(err)}`)
        } finally {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      }),
    )
  }

  /** Shared notes for this repository, fed into every agent prompt. */
  async memory(action: 'show' | 'add' | 'clear', text = ''): Promise<void> {
    const root = await this.rootDir()
    if (root === undefined) return this.toast('error', 'Agents need a git repository. Start pager inside one.')
    if (action === 'add') {
      if (text.trim() === '') return this.toast('error', 'Usage: /agent memory add <text>')
      this.addMemory(root, 'you', text.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_CHARS))
      return this.toast('success', 'Remembered')
    }
    if (action === 'clear') {
      fs.rmSync(this.memoryFile(root), { force: true })
      return this.append('pager', 'system', 'memory cleared')
    }
    const notes = this.readMemory(root).trim()
    this.append('pager', 'system', notes === '' ? 'memory is empty' : `memory (${notes.split('\n').length} notes):\n${notes}`)
  }

  /** Posts the slash commands an agent advertises over ACP (run them with `/agent <name> /<command>`). */
  async commands(agent: AgentName): Promise<void> {
    const spec = this.adapters[agent]
    if (spec.acp === undefined || process.env.PAGER_NO_ACP === '1') {
      return this.toast('error', `${agent} has no ACP mode here; try /agent cli ${agent} --help`)
    }
    let list = this.commandCache.get(agent)
    if (list === undefined) {
      const found = await this.resolveBin(agent)
      if ('error' in found) return this.toast('error', found.error)
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-acp-'))
      const child = startProcess(found.bin, spec.acp, { cwd: dir, env: this.env, stdin: 'pipe' })
      const got = Promise.withResolvers<AcpCommand[]>()
      const conn = new AcpConnection(child, {
        onCommands: (commands) => {
          this.commandCache.set(agent, commands)
          got.resolve(commands)
        },
      })
      const giveUp = setTimeout(() => got.resolve([]), COMMANDS_WAIT_MS)
      try {
        await openSession(conn, { cwd: dir, timeoutMs: ACP_PROBE_TIMEOUT_MS })
        list = await got.promise
      } catch (err) {
        return void this.append('pager', 'system', `${agent}: could not list commands (${errMsg(err)})`)
      } finally {
        clearTimeout(giveUp)
        await endChild(child, 0)
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
      }
    }
    this.append(
      'pager',
      'system',
      list.length === 0
        ? `${agent} advertises no slash commands`
        : `${agent} slash commands:\n${list.map((c) => `  /${c.name}  ${c.description}`.trimEnd()).join('\n')}`,
    )
  }

  async close(): Promise<void> {
    this.closing = true
    this.cancel(this.live)
    await Promise.allSettled([...this.inflight])
    this.removeAllListeners()
  }

  // ---- internals ----

  private toast(kind: ToastKind, text: string): void {
    const t: Toast = { kind, text }
    this.emit('toast', t)
  }

  private append(author: string, kind: 'text' | 'system', text: string): void {
    this.add(author, kind, text, true)
  }

  /** Adds a room message and returns it. `persist: false` is for a streaming entry, written once when it settles. */
  private add(author: string, kind: 'text' | 'system', text: string, persist: boolean): RoomEntry {
    const entry: RoomEntry = {
      n: ++this.counter,
      ts: Date.now(),
      author,
      authorKey: author === 'you' || author === 'pager' ? ZERO_KEY : Buffer.from(author.split('-', 1)[0] ?? author).toString('hex').padEnd(64, '0').slice(0, 64),
      kind,
      text,
    }
    this.log.push(entry)
    if (this.log.length > ROOM_MAX_MESSAGES) this.log.shift()
    if (persist) this.persist(entry)
    this.emit('change')
    return entry
  }

  private persist(entry: RoomEntry): void {
    try {
      fs.appendFileSync(this.roomFile, `${JSON.stringify(entry)}\n`)
    } catch {
      // A read-only data dir must not break the room; the history just won't survive a restart.
    }
  }

  /** Loads the persisted room: tolerant of corrupt lines, bounded to ROOM_MAX_MESSAGES. */
  private restore(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.roomFile, 'utf8')
    } catch {
      return
    }
    const lines = raw.split('\n').filter((l) => l.trim() !== '')
    const kept: RoomEntry[] = []
    for (const line of lines) {
      try {
        const entry: unknown = JSON.parse(line)
        if (isRoomEntry(entry)) kept.push(entry)
      } catch {
        // skip a corrupt line
      }
    }
    this.log.push(...kept.sort((a, b) => a.n - b.n).slice(-ROOM_MAX_MESSAGES))
    this.counter = this.log.reduce((max, e) => Math.max(max, e.n), 0)
    this.readN = this.counter
    if (lines.length > 2 * ROOM_MAX_MESSAGES) {
      const tmp = `${this.roomFile}.tmp`
      try {
        fs.writeFileSync(tmp, this.log.map((e) => `${JSON.stringify(e)}\n`).join(''))
        fs.renameSync(tmp, this.roomFile)
      } catch {
        // compaction is best effort
      }
    }
  }

  private memoryFile(root: string): string {
    return path.join(this.opts.dataDir, 'memory', `${repoKey(root)}.md`)
  }

  private readMemory(root: string): string {
    try {
      return fs.readFileSync(this.memoryFile(root), 'utf8')
    } catch {
      return ''
    }
  }

  /** Appends one dated note, dropping the oldest lines when the file would exceed MEMORY_FILE_MAX_CHARS. */
  private addMemory(root: string, who: string, note: string): void {
    const lines = this.readMemory(root).split('\n').filter((l) => l !== '')
    lines.push(`- ${new Date().toISOString().slice(0, 10)} (${who}) ${note}`)
    while (lines.length > 1 && lines.join('\n').length > MEMORY_FILE_MAX_CHARS) lines.shift()
    try {
      fs.mkdirSync(path.dirname(this.memoryFile(root)), { recursive: true })
      fs.writeFileSync(this.memoryFile(root), `${lines.join('\n')}\n`)
    } catch (err) {
      this.toast('warn', `Could not save agent memory: ${errMsg(err)}`)
    }
  }

  private async rootDir(): Promise<string | undefined> {
    this.root ??= await repoRoot(this.opts.workdir)
    return this.root
  }

  private find(target: string): Run | undefined {
    const exact = this.runs.get(target)
    if (exact !== undefined) return exact
    const matches = target === '' ? [] : [...this.runs.values()].filter((r) => r.id.startsWith(target))
    if (matches.length === 1) return matches[0]
    this.toast('error', matches.length === 0 ? `No run "${target}"` : `"${target}" matches several runs`)
    return undefined
  }

  private async resolveBin(agent: AgentName): Promise<{ bin: string } | { error: string }> {
    const bin = await findBinary(this.adapters[agent].bin)
    if (bin === undefined) return { error: `${agent} was not found on PATH` }
    if (/\.(cmd|bat)$/i.test(bin)) return { error: `${agent} resolves to a .cmd shim; install its native binary` }
    return { bin }
  }

  private async startThread(agents: AgentName[], task: string, log: boolean): Promise<void> {
    for (const agent of agents) {
      const found = await this.resolveBin(agent)
      if ('error' in found) return this.toast('error', found.error)
    }
    const root = await this.rootDir()
    if (root === undefined) return this.toast('error', 'Agents need a git repository. Start pager inside one.')
    let head: string
    try {
      head = await headSha(root)
    } catch (err) {
      return this.toast('error', errMsg(err))
    }
    if (await isDirty(root)) {
      this.append('pager', 'system', 'Uncommitted changes in the working tree are not visible to agents (they start from HEAD).')
    }
    if (log) this.append('you', 'text', `@${agents.join('>')} ${task}`)
    const thread: Thread = { root, tip: head, start: head, runs: 0, cancelled: this.closing }
    this.live.add(thread)
    try {
      let prev: Outcome | undefined
      for (const agent of agents) {
        if (prev !== undefined) {
          if (!prev.ok) {
            this.append('pager', 'system', 'chain stopped: the previous step failed')
            break
          }
          if (thread.runs >= this.limits.maxRunsPerThread) {
            this.append('pager', 'system', 'chain stopped: run limit reached')
            break
          }
        }
        prev = await this.runTask(thread, agent, prev === undefined ? task : chainTask(task, { run: prev.runId, text: prev.text }), 0)
      }
    } catch (err) {
      if (err instanceof CancelledError) this.append('pager', 'system', 'stopped')
      else {
        this.append('pager', 'system', `failed: ${errMsg(err)}`)
        this.toast('error', errMsg(err))
      }
    } finally {
      this.live.delete(thread)
    }
  }

  private async runTask(thread: Thread, agent: AgentName, task: string, depth: number): Promise<Outcome> {
    let current = task
    let result = await this.execute(thread, agent, current)
    while (result.asks.length > 0) {
      const replies: { run: string; text: string }[] = []
      for (const ask of result.asks) replies.push(await this.answer(thread, agent, ask, depth))
      current = withReplies(current, replies, result.text)
      result = await this.execute(thread, agent, current)
    }
    return result
  }

  private async answer(thread: Thread, from: AgentName, ask: Ask, depth: number): Promise<{ run: string; text: string }> {
    const fail = (text: string): { run: string; text: string } => ({ run: ask.agent, text: `(error: ${text})` })
    if (!isAgentName(ask.agent) || ask.agent === from) return fail(`cannot ask "${ask.agent}"`)
    const found = await this.resolveBin(ask.agent)
    if ('error' in found) return fail(found.error)
    if (depth + 1 > MAX_ASK_DEPTH || thread.runs >= this.limits.maxRunsPerThread) return fail('delegation limit reached')
    const out = await this.runTask(thread, ask.agent, ask.request, depth + 1)
    return { run: out.runId, text: out.text }
  }

  private async acquire(thread: Thread): Promise<boolean> {
    if (this.active < this.limits.maxConcurrent) {
      this.active++
      return true
    }
    const { promise, resolve } = Promise.withResolvers<boolean>()
    this.waiters.push({ thread, wake: resolve })
    return promise
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next === undefined) this.active--
    else next.wake(true) // the slot is handed over, `active` stays
  }

  private async execute(thread: Thread, agent: AgentName, task: string): Promise<Outcome> {
    if (thread.cancelled) throw new CancelledError()
    const id = `${agent}-${randomBytes(3).toString('hex')}`
    const run: Run = {
      id,
      agent,
      thread,
      state: 'queued',
      branch: `pager/${id}`,
      dir: path.join(this.opts.dataDir, 'worktrees', repoKey(thread.root), id),
      files: [],
      merged: false,
    }
    this.runs.set(id, run)
    thread.runs++
    this.emit('change')

    const granted = await this.acquire(thread)
    try {
      if (!granted || thread.cancelled) {
        run.state = 'cancelled'
        this.emit('change')
        throw new CancelledError()
      }
      run.state = 'running'
      this.emit('change')
      return await this.runOnce(run, thread, task)
    } finally {
      if (granted) this.release()
    }
  }

  private async runOnce(run: Run, thread: Thread, task: string): Promise<Outcome> {
    let liveEntry: RoomEntry | undefined
    const live = new LiveMessage((body) => {
      if (liveEntry === undefined) liveEntry = this.add(run.id, 'text', body, false)
      else {
        liveEntry.text = body
        this.emit('change')
      }
    })
    // Posts the run's final text: into the streamed entry when there is one, else as a new message.
    const settle = (text: string): void => {
      live.stop()
      if (liveEntry === undefined) this.append(run.id, 'text', text)
      else {
        liveEntry.text = text
        this.persist(liveEntry)
        this.emit('change')
      }
    }
    const failed = (reason: string): Outcome => {
      run.state = 'failed'
      const text = `(failed: ${reason})`
      const partial = live.message()
      settle(partial === '' ? text : `${partial}\n${text}`)
      this.toast('error', `${run.id}: ${reason}`)
      return { runId: run.id, text, asks: [], ok: false }
    }
    const found = await this.resolveBin(run.agent)
    if ('error' in found) return failed(found.error)
    try {
      fs.mkdirSync(path.dirname(run.dir), { recursive: true })
      await addWorktree(thread.root, run.dir, run.branch, thread.tip)
    } catch (err) {
      return failed(errMsg(err))
    }
    if (thread.cancelled) return this.cancelled(run)
    const peers: AgentName[] = []
    for (const n of AGENT_NAMES) if (!('error' in (await this.resolveBin(n)))) peers.push(n)
    // A task that is itself a slash command (e.g. "/review") goes to the agent verbatim so its own CLI interprets it.
    const prompt = task.startsWith('/')
      ? task
      : buildPrompt({
          agent: run.agent,
          branch: run.branch,
          peers,
          memory: this.readMemory(thread.root),
          room: this.log
            .filter((e) => e.kind === 'text' || / changed \d+ file/.test(e.text))
            .map((e) => ({ author: e.author, text: e.text })),
          task,
        })
    const adapter = this.adapters[run.agent]
    let reply: Reply | undefined
    if (adapter.acp !== undefined && process.env.PAGER_NO_ACP !== '1') {
      const tried = await this.runViaAcp(run, thread, found.bin, adapter, adapter.acp, prompt, live)
      if (tried.kind === 'fallback') {
        this.append('pager', 'system', `${run.agent}: ACP unavailable (${tried.reason}); using one-shot mode`)
      } else reply = tried
    }
    reply ??= await this.runOneShot(run, thread, found.bin, adapter, prompt)
    if (reply.kind === 'cancelled') {
      if (live.started) settle(`${live.message()}\n(stopped)`.trim())
      return this.cancelled(run)
    }
    if (reply.kind === 'failed') return failed(reply.reason)
    if (reply.stopReason === 'refusal') return failed('agent refused')
    if (reply.stopReason === 'cancelled') return failed('agent cancelled the turn')

    const parsed = parseAsks(reply.text)
    const { clean, notes } = parseRemember(parsed.clean)
    try {
      await commitAll(run.dir, `agent(${run.agent}): ${(task.split('\n', 1)[0] ?? '').slice(0, 72)}\n\nPager-Run: ${run.id}`)
      run.files = await changedFiles(run.dir, thread.start)
    } catch (err) {
      return failed(errMsg(err))
    }
    thread.tip = run.branch
    run.state = 'done'
    for (const note of notes) this.addMemory(thread.root, run.agent, note)
    const text = clean === '' ? '(no output)' : clean
    settle(text)
    const used = live.summary()
    if (used !== '') this.append('pager', 'system', `${run.id} ${used}`)
    if (reply.stopReason === 'max_tokens' || reply.stopReason === 'max_turn_requests') {
      this.append('pager', 'system', `${run.id} stopped early: ${reply.stopReason}`)
    }
    if (run.files.length > 0) {
      const shown = run.files.slice(0, 5).join(', ')
      this.append('pager', 'system', `${run.id} changed ${run.files.length} file(s): ${shown}${run.files.length > 5 ? ', ...' : ''}`)
    }
    this.toast('info', `${run.id}: ${(text.split('\n', 1)[0] ?? '').slice(0, 80)}`)
    this.warnOverlap(run)
    return { runId: run.id, text, asks: parsed.asks, ok: true }
  }

  private timeoutReason(): string {
    const s = this.limits.runTimeoutMs / 1000
    return `timed out after ${s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`}`
  }

  private async runOneShot(run: Run, thread: Thread, bin: string, adapter: AdapterSpec, prompt: string): Promise<Reply> {
    let res
    try {
      res = await runProcess(bin, adapter.args(prompt, run.dir), {
        cwd: run.dir,
        env: this.env,
        timeoutMs: this.limits.runTimeoutMs,
        onSpawn: (c) => {
          run.child = c
          if (thread.cancelled) killTree(c)
        },
      })
    } catch (err) {
      return thread.cancelled ? { kind: 'cancelled' } : { kind: 'failed', reason: errMsg(err) }
    }
    run.child = undefined
    if (thread.cancelled) return { kind: 'cancelled' }
    if (res.timedOut) return { kind: 'failed', reason: this.timeoutReason() }
    if (res.code !== 0) return { kind: 'failed', reason: `exit ${res.code}: ${res.stderr.trim().slice(-300)}` }
    return { kind: 'text', text: adapter.extract(res.stdout), stopReason: 'end_turn' }
  }

  /**
   * One ACP child per run, working in the run's worktree. The agent's own session (stored per
   * repository and agent) is resumed when possible so it remembers earlier tasks; any trouble before
   * the prompt is sent falls back to the one-shot path.
   */
  private async runViaAcp(
    run: Run,
    thread: Thread,
    bin: string,
    spec: AdapterSpec,
    acpArgs: string[],
    prompt: string,
    live: LiveMessage,
  ): Promise<Reply | { kind: 'fallback'; reason: string }> {
    const child = startProcess(bin, acpArgs, { cwd: run.dir, env: this.env, stdin: 'pipe' })
    run.child = child
    if (thread.cancelled) killTree(child)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, this.limits.runTimeoutMs)
    const conn = new AcpConnection(child, {
      onText: (chunk) => live.text(chunk),
      onTool: (call) => live.tool(call),
      onCommands: (commands) => this.commandCache.set(run.agent, commands),
    })
    // Two runs of one agent must not drive the same stored session at once; the later one starts fresh.
    const slot = `${repoKey(thread.root)}\n${run.agent}`
    const ownsSession = !this.busySessions.has(slot)
    if (ownsSession) this.busySessions.add(slot)
    try {
      let session
      try {
        const resumeId = ownsSession && spec.resume !== false ? this.sessions.get(repoKey(thread.root))?.[run.agent] : undefined
        session = await openSession(conn, { cwd: run.dir, resumeId, timeoutMs: ACP_OPEN_TIMEOUT_MS })
      } catch (err) {
        return thread.cancelled ? { kind: 'cancelled' } : { kind: 'fallback', reason: timedOut ? this.timeoutReason() : errMsg(err) }
      }
      let stopReason: string
      try {
        stopReason = (await sendPrompt(conn, session.sessionId, prompt)).stopReason
      } catch (err) {
        if (thread.cancelled) return { kind: 'cancelled' }
        return { kind: 'failed', reason: timedOut ? this.timeoutReason() : errMsg(err) }
      }
      if (thread.cancelled) return { kind: 'cancelled' }
      if (ownsSession && spec.resume !== false) this.saveSession(thread.root, run.agent, session.sessionId)
      return { kind: 'text', text: live.message(), stopReason }
    } finally {
      clearTimeout(timer)
      if (ownsSession) this.busySessions.delete(slot)
      await endChild(child, ACP_EXIT_GRACE_MS)
      run.child = undefined
    }
  }

  /** Starts the agent's ACP server in `dir` and handshakes: ` · acp` on success, ` · acp unavailable (reason)` otherwise. */
  private async probeAcp(bin: string, args: string[], dir: string): Promise<string> {
    const child = startProcess(bin, args, { cwd: dir, env: this.env, stdin: 'pipe' })
    const conn = new AcpConnection(child, {})
    try {
      await openSession(conn, { cwd: dir, timeoutMs: ACP_PROBE_TIMEOUT_MS })
      return ' · acp'
    } catch (err) {
      return ` · acp unavailable (${errMsg(err)})`
    } finally {
      await endChild(child, 0)
    }
  }

  private saveSession(root: string, agent: AgentName, sessionId: string): void {
    const key = repoKey(root)
    this.sessions.set(key, { ...this.sessions.get(key), [agent]: sessionId })
    try {
      const tmp = `${this.sessionFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sessions), null, 2))
      fs.renameSync(tmp, this.sessionFile)
    } catch {
      // Without the file the agent just starts a fresh session next time.
    }
  }

  private loadSessions(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'))
    } catch {
      return
    }
    if (!isRecord(parsed)) return
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue
      const ids: Partial<Record<AgentName, string>> = {}
      for (const name of AGENT_NAMES) {
        const id = value[name]
        if (typeof id === 'string') ids[name] = id
      }
      this.sessions.set(key, ids)
    }
  }

  private cancelled(run: Run): never {
    run.state = 'cancelled'
    this.emit('change')
    throw new CancelledError()
  }

  private warnOverlap(run: Run): void {
    for (const other of this.runs.values()) {
      if (other === run || other.thread === run.thread || other.state !== 'done' || other.merged) continue
      const shared = run.files.filter((f) => other.files.includes(f))
      if (shared.length === 0) continue
      const text = `${run.id} and ${other.id} both change ${shared.slice(0, 3).join(', ')}`
      this.toast('warn', text)
      this.append('pager', 'system', text)
    }
  }

  private async doMerge(target: string): Promise<void> {
    const run = this.find(target)
    if (run === undefined) return
    if (run.state !== 'done') return this.toast('error', 'Run is not finished')
    const root = run.thread.root
    if (await isDirty(root)) return this.toast('error', 'Commit or stash your changes first, then merge again.')
    if ((await aheadCount(root, run.branch)) === 0) return this.toast('info', 'Nothing to merge')
    const res = await mergeBranch(root, run.branch)
    if (!res.ok) {
      const shown = res.conflicts.slice(0, 3).join(', ')
      this.toast(
        'error',
        res.conflicts.length > 0
          ? `Merge conflict in ${shown}${res.conflicts.length > 3 ? ', ...' : ''}. Nothing was changed.`
          : `Merge failed: ${res.error}. Nothing was changed.`,
      )
      this.append('pager', 'system', `merge of ${run.id} failed; conflicts: ${res.conflicts.join(', ') || res.error}`)
      return
    }
    for (const r of this.runs.values()) {
      if (r.state === 'done' && !r.merged && r.thread.root === root && (await isAncestor(root, r.branch))) {
        await removeWorktree(root, r.dir, r.branch)
        r.merged = true
      }
    }
    this.emit('change')
    this.append('pager', 'system', `merged ${run.id}`)
    this.toast('success', `Merged ${run.id}`)
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
