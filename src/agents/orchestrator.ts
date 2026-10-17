import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { MessageView, Toast, ToastKind } from '../engine.js'
import { ADAPTERS, findBinary, type AdapterSpec } from './adapters.js'
import type { AcpCommand, AcpConfigOption } from './acp.js'
import { renderBoard } from './board.js'
import { PRESETS } from './catalog.js'
import { changedFiles, commitAll, currentSha, diffSince, ensureWorktree, headSha, isAncestor, isDirty, aheadCount, mergeBranch, removeWorktree, repoRoot, syncWorktree } from './git.js'
import { LiveMessage } from './live.js'
import { killTree, runProcess } from './process.js'
import {
  buildPrompt,
  chainTask,
  docCap,
  DOC_EDIT_MAX_CHARS,
  formatMessages,
  MAX_DOC_EDITS_PER_RUN,
  MAX_NOTES_PER_RUN,
  NOTE_MAX_CHARS,
  splitArgs,
  type PromptMessage,
} from './protocol.js'
import { Registry, type AgentConfig, type Readiness } from './registry.js'
import { askUserResult, contentFromAnswers, fieldsFromAskUser, fieldsFromElicitation, Questions, type QuestionView } from './questions.js'
import { feedbackText, pickReviewer, reviewRequest, REVIEW_MAX_ROUNDS, type Verdict } from './review.js'
import { FORWARD_THRESHOLD, parseMentions, relevance } from './router.js'
import { StatsLog, summarize, type AgentTotals } from './stats.js'
import { BoardState, CommandStore, errMsg, Memory, repoKey, ROOM_ID, RoomLog, SessionStore, type RoomEntry } from './store.js'
import { shimSpec, ToolServer, type AskQuestion, type ToolHost, type TurnToken } from './toolserver.js'
import { probeAcp, runOneShot, runViaAcp, type Reply } from './turn.js'
import type { AgentView } from './types.js'
import { Worker, type Inbox, type Outcome, type TurnCtx } from './worker.js'

export { repoKey, ROOM_ID }
export const MAX_CONCURRENT = 3
export const CLI_OUTPUT_MAX = 100_000
export const RUN_TIMEOUT_MS = 900_000
export const CHECK_TIMEOUT_MS = 120_000
export const VERSION_TIMEOUT_MS = 15_000
export const PEER_MAX_DEPTH = 3
export const PEER_WAIT_TIMEOUT_MS = 600_000
export const COMPACT_AT = 0.85
export const USAGE_STALE_MS = 600_000
const MAX_RUNS_KEPT = 60
const SEED_CLIS = ['omp', 'claude', 'opencode', 'hermes']
const CHECK_CONCURRENCY = 3
const AUTH_HINT = /auth|login|log in|credential|api key|unauthori[sz]ed|token/i

export type RunState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export interface RunView {
  id: string
  agent: string
  state: RunState
  files: number
  mergeable: boolean
}
export interface RoomView {
  id: typeof ROOM_ID
  unread: number
  runs: RunView[]
  agents: AgentView[]
}
export interface DocsPort {
  /** The documents the local user named in `task` (as #name); never any others, because peers can edit shared documents. */
  list(task: string): { name: string; text: string }[]
  /** Replace (or append to) the named document. `base` is the text the agent saw: a replace is refused if the document changed since. Returns null on success, else the reason. */
  write(name: string, text: string, append: boolean, base: string): string | null
}
export interface OrchestratorOptions {
  dataDir: string
  workdir: string
  /** Test seam: replaces entries of ADAPTERS. */
  adapters?: Record<string, AdapterSpec>
  /** Shared documents: agents see them in the prompt and may read and edit them with the doc tools. */
  docs?: DocsPort
  limits?: Partial<{ maxConcurrent: number; runTimeoutMs: number }>
}
export interface SetupRow {
  id: string
  label: string
  readiness: Readiness
  instances: number
  command: string
  install?: string
  auth?: string
  custom: boolean
}
export interface AgentStats {
  perAgent: Record<string, AgentTotals>
  week: number[]
  reviews: { approved: number; changes: number }
}

interface Run {
  id: string
  agent: string
  worker: Worker
  state: RunState
  files: string[]
  merged: boolean
}

class CancelledError extends Error {}

const NO_OUTCOME: Outcome = { runId: '', text: '', ok: false, files: [] }

export class Orchestrator extends EventEmitter {
  readonly registry: Registry
  readonly questions = new Questions()
  private readonly adapters: Record<string, AdapterSpec>
  private readonly limits: { maxConcurrent: number; runTimeoutMs: number }
  private readonly runs = new Map<string, Run>()
  private readonly workers = new Map<string, Worker>()
  private readonly log: RoomLog
  private readonly sessions: SessionStore
  private readonly memoryStore: Memory
  private readonly boardState: BoardState
  private readonly statsLog: StatsLog
  private readonly commandStore: CommandStore
  private readonly cliOptions = new Map<string, AcpConfigOption[]>()
  private readonly tools: ToolServer
  private readonly inflight = new Set<Promise<unknown>>()
  private readonly waiters: { worker: Worker; wake: (granted: boolean) => void }[] = []
  private readonly reviewing = new Map<string, { author: string }>()
  private active = 0
  private closing = false
  private root: string | undefined
  private mergeQueue: Promise<void> = Promise.resolve()
  private reviewCursor = -1
  private checking: Promise<void> = Promise.resolve()
  private checkingNow = false
  private readonly env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' }

  constructor(private readonly opts: OrchestratorOptions) {
    super()
    const dir = opts.dataDir
    this.registry = new Registry(dir)
    this.log = new RoomLog(path.join(dir, 'agents-room.jsonl'))
    this.sessions = new SessionStore(path.join(dir, 'agent-sessions.json'))
    this.memoryStore = new Memory(dir)
    this.boardState = new BoardState(path.join(dir, 'agents-state.json'))
    this.statsLog = new StatsLog(path.join(dir, 'agent-stats.jsonl'))
    this.commandStore = new CommandStore(path.join(dir, 'agents-commands.json'))
    this.adapters = { ...ADAPTERS, ...opts.adapters }
    this.limits = {
      maxConcurrent: opts.limits?.maxConcurrent ?? MAX_CONCURRENT,
      runTimeoutMs: opts.limits?.runTimeoutMs ?? RUN_TIMEOUT_MS,
    }
    this.tools = new ToolServer(this.host())
    this.questions.on('change', () => this.emit('change'))
    this.questions.on('asked', (q: QuestionView) => {
      this.toast('info', `${q.agent} asks: ${q.message.slice(0, 80)}`)
      this.emit('notify', q.agent, `${q.agent} has a question`)
    })
  }

  // ---- views ----

  /** Names of the agents that passed their readiness check, in config order. */
  names(): string[] {
    return this.registry.ready().map((c) => c.name)
  }

  room(): RoomView {
    const latest = new Map<string, Run>()
    for (const r of this.runs.values()) latest.set(r.agent, r)
    return {
      id: ROOM_ID,
      unread: this.log.unread(ROOM_ID),
      agents: this.registry.ready().map((cfg) => {
        const w = this.workers.get(cfg.name)
        const view: AgentView = w?.view(this.log.unread(cfg.name), cfg.model, cfg.effort, this.questions.pendingFor(cfg.name) > 0) ?? {
          name: cfg.name,
          cli: cfg.cli,
          state: 'idle',
          task: '',
          ...(cfg.model === undefined ? {} : { model: cfg.model }),
          ...(cfg.effort === undefined ? {} : { effort: cfg.effort }),
          unread: this.log.unread(cfg.name),
        }
        return cfg.color === undefined ? view : { ...view, color: cfg.color }
      }),
      runs: [...this.runs.values()].map((r) => ({
        id: r.id,
        agent: r.agent,
        state: r.state,
        files: r.files.length,
        mergeable: r.state === 'done' && !r.merged && latest.get(r.agent) === r && r.worker.files.length > 0,
      })),
    }
  }

  /** The messages one tab shows: the hub (default) or a single agent's own chat. */
  messages(limit: number, scope: string = ROOM_ID): MessageView[] {
    return this.log
      .visible(scope)
      .slice(-limit)
      .map((e) => ({
        key: `room:${e.n}`,
        ts: e.ts,
        authorName: e.author,
        authorKey: e.authorKey,
        mine: e.author === 'you',
        kind: e.kind,
        agent: e.author !== 'you' && e.author !== 'pager',
        text: e.text,
        status: null,
        markdown: e.kind === 'text' && e.author !== 'you',
      }))
  }

  markRead(scope: string = ROOM_ID): void {
    this.log.markRead(scope)
  }

  /** True while the named agent has a turn running or queued. */
  busy(name: string): boolean {
    const w = this.workers.get(name)
    return w !== undefined && (w.draining || w.inbox.length > 0)
  }

  agentOptions(name: string): AcpConfigOption[] {
    const cfg = this.registry.instances().find((c) => c.name === name)
    const w = this.workers.get(name)
    if (w !== undefined && w.options.length > 0) return w.options
    return cfg === undefined ? [] : (this.cliOptions.get(cfg.cli) ?? [])
  }

  /** Slash commands the agent advertises over ACP (empty until it has been probed or used once). */
  agentCommands(name: string): AcpCommand[] {
    const cfg = this.registry.instances().find((c) => c.name === name)
    return cfg === undefined ? [] : this.commandStore.get(cfg.cli)
  }

  usageOf(name: string): { text: string; at: number } | undefined {
    return this.workers.get(name)?.usage
  }

  /** Per-agent totals and the 14-day activity strip, from pager's own record of finished turns. */
  stats(now = Date.now()): AgentStats {
    const records = this.statsLog.read()
    const { perAgent, week } = summarize(records, now)
    let approved = 0
    let changes = 0
    for (const t of Object.values(perAgent)) {
      approved += t.approved
      changes += t.changes
    }
    return { perAgent, week, reviews: { approved, changes } }
  }

  pendingReviews(): number {
    return this.reviewing.size
  }

  goal(): string {
    return this.root === undefined ? '' : this.boardState.goal(this.root)
  }

  /** Rows for the agent setup screen: every preset and custom agent with its readiness. */
  setup(): SetupRow[] {
    const custom = this.registry.custom()
    const counts = new Map<string, number>()
    for (const i of this.registry.instances()) counts.set(i.cli, (counts.get(i.cli) ?? 0) + 1)
    const rows: SetupRow[] = this.registry.presets().map((p) => ({
      id: p.id,
      label: p.label,
      readiness: this.registry.readiness(p.id),
      instances: counts.get(p.id) ?? 0,
      command: [p.acpBin ?? p.bin, ...(p.acp ?? [])].join(' '),
      ...(p.install === undefined ? {} : { install: p.install }),
      ...(p.auth === undefined ? {} : { auth: p.auth }),
      custom: false,
    }))
    for (const [id, c] of Object.entries(custom)) {
      const at = rows.findIndex((r) => r.id === id)
      const row: SetupRow = { id, label: id, readiness: this.registry.readiness(id), instances: counts.get(id) ?? 0, command: [c.command, ...c.args].join(' '), custom: true }
      if (at >= 0) rows[at] = row
      else rows.push(row)
    }
    return rows
  }

  // ---- talking to agents ----

  /** The user typed `text` in the hub or in an agent's tab (`tab`). Mentions pick who hears it. */
  say(text: string, tab?: string): void {
    if (this.checkingNow) void this.checking.then(() => this.sayNow(text, tab))
    else this.sayNow(text, tab)
  }

  private sayNow(text: string, tab: string | undefined): void {
    const names = this.names()
    const own = tab !== undefined && tab !== ROOM_ID && names.includes(tab) ? tab : undefined
    const body = text.trim()
    const chainMatch = /^@(\w[\w-]*(?:>\w[\w-]*)+)\s+([\s\S]+)$/.exec(body)
    const chain = chainMatch?.[1] === undefined ? undefined : chainSpec(chainMatch[1], names)
    if (chain !== undefined && chainMatch?.[2] !== undefined) {
      void this.chain(chain, chainMatch[2].trim(), true)
      return
    }
    const passthrough = /^@([a-z][a-z0-9_-]+)\s+!([\s\S]*)$/i.exec(body)
    const target = passthrough?.[1]?.toLowerCase()
    if (target !== undefined && names.includes(target)) {
      this.append('you', 'text', text, [target])
      const argv = splitArgs(passthrough?.[2] ?? '')
      if (argv.length === 0) this.toast('error', `Usage: @${target} !<cli arguments>`)
      else void this.cli(target, argv)
      return
    }
    const { targets } = parseMentions(body, names)
    const to = targets.length > 0 ? targets : own === undefined ? [] : [own]
    this.append('you', 'text', text, to.length > 0 ? to : undefined)
    if (to.length === 0) {
      const hint = names.length === 0 ? 'No agents are ready: /agent setup' : `Name an agent: ${names.map((n) => `@${n}`).join(', ')} or @all`
      this.toast('warn', hint)
      return
    }
    for (const name of to) {
      void this.send(name, { from: 'you', kind: 'user', text: body, also: to.filter((t) => t !== name), chain: [] })
    }
    this.forward(body, to)
  }

  /** Hands a message to every other agent that has a live task it touches. */
  private forward(text: string, already: string[]): void {
    for (const w of this.workers.values()) {
      if (already.includes(w.name) || (w.state === 'idle' && w.task === '') || !this.names().includes(w.name)) continue
      const { score, reason } = relevance(text, { task: w.task, files: w.files })
      if (score < FORWARD_THRESHOLD) continue
      void this.send(w.name, { from: 'you', kind: 'forward', text: `pager forwarded this because it touches your task (${reason}):\n${text}`, chain: [] })
    }
  }

  /** Runs `task` as a message to one agent and resolves when its turn is over. `/agent <name> <task>` and tests use this. */
  ask(agent: string, task: string, log = true): Promise<void> {
    if (log) this.append('you', 'text', `@${agent} ${task}`, [agent])
    return this.track(this.send(agent, { from: 'you', kind: 'user', text: task, chain: [] }).then(() => undefined))
  }

  /** Runs the agents in turn; each continues from the previous one's branch and reviews its work. */
  chain(agents: string[], task: string, log = true): Promise<void> {
    if (log) this.append('you', 'text', `@${agents.join('>')} ${task}`, agents)
    return this.track(this.runChain(agents, task))
  }

  private async runChain(agents: string[], task: string): Promise<void> {
    let prev: Outcome | undefined
    let prevBranch: string | undefined
    for (const name of agents) {
      if (prev !== undefined && !prev.ok) return this.post('chain stopped: the previous step failed', agents)
      const text = prev === undefined ? task : chainTask(task, { run: prev.runId, text: prev.text })
      prev = await this.send(name, { from: 'you', kind: 'user', text, chain: [], ...(prevBranch === undefined ? {} : { mergeBranch: prevBranch }) })
      prevBranch = `pager/${name}`
    }
  }

  /** Queues `msg` for `name`; resolves with the outcome of the turn that handled it. */
  private send(name: string, msg: Inbox): Promise<Outcome> {
    const { promise, resolve } = Promise.withResolvers<Outcome>()
    const done = msg.done
    void this.deliver(name, {
      ...msg,
      done: (o) => {
        done?.(o)
        resolve(o)
      },
    })
    return promise
  }

  private async deliver(name: string, msg: Inbox): Promise<void> {
    const fail = (why: string): void => msg.done?.({ ...NO_OUTCOME, text: `(${why})` })
    const cfg = this.registry.ready().find((c) => c.name === name)
    if (cfg === undefined) return fail(`${name} is not available`)
    const w = await this.workerFor(cfg)
    if (w === undefined || this.closing) return fail('agent unavailable')
    if (msg.kind === 'user') w.reviewRound = 0
    w.inbox.push(msg)
    this.emit('change')
    this.track(this.drain(w))
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p)).catch(() => undefined)
    return p
  }

  private async workerFor(cfg: AgentConfig): Promise<Worker | undefined> {
    const root = await this.rootDir()
    if (root === undefined) {
      this.toast('error', 'Agents need a git repository. Start pager inside one.')
      return undefined
    }
    let w = this.workers.get(cfg.name)
    if (w === undefined) {
      w = new Worker(cfg.name, cfg.cli, `pager/${cfg.name}`, path.join(this.opts.dataDir, 'worktrees', repoKey(root), cfg.name))
      const notes = this.boardState.notes(root, cfg.name)
      if (notes !== undefined) {
        w.task = notes.task
        w.purpose = notes.purpose
      }
      this.workers.set(cfg.name, w)
    }
    return w
  }

  // ---- stopping, merging, housekeeping ----

  stop(target: string): void {
    const targets = new Set<Worker>()
    if (target === 'all') {
      for (const w of this.workers.values()) if (w.draining || w.inbox.length > 0) targets.add(w)
    } else {
      const byName = this.workers.get(target)
      const w = byName ?? this.find(target)?.worker
      if (w === undefined) return byName === undefined && this.find(target) === undefined ? undefined : this.toast('error', 'No running agent')
      if (!w.draining && w.inbox.length === 0) return this.toast('error', 'No running agent')
      targets.add(w)
    }
    if (targets.size === 0) return this.toast('error', 'No running agent')
    this.cancel(targets)
    this.toast('info', 'Stopped')
  }

  /** Marks workers stopped, kills their children, drops their queues and wakes their queued turns. */
  private cancel(workers: ReadonlySet<Worker>): void {
    for (const w of workers) {
      w.stopped = true
      for (const m of w.inbox.splice(0)) m.done?.({ ...NO_OUTCOME, text: '(stopped)' })
      if (w.child !== undefined) killTree(w.child)
      this.questions.cancelAgent(w.name)
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i]
      if (waiter !== undefined && workers.has(waiter.worker)) {
        this.waiters.splice(i, 1)
        waiter.wake(false)
      }
    }
    this.emit('change')
  }

  merge(target: string): Promise<void> {
    const job = this.mergeQueue.then(() => this.doMerge(target)).catch((err: unknown) => this.toast('error', errMsg(err)))
    this.mergeQueue = job
    return job
  }

  /** `drop all|<run>` forgets finished run records; `drop <agent>` also removes that agent's worktree, branch and saved session. */
  async drop(target: string): Promise<void> {
    const w = this.workers.get(target)
    if (w !== undefined) {
      if (w.draining) return this.toast('error', 'Stop it first')
      const root = await this.rootDir()
      if (root !== undefined) {
        await removeWorktree(root, w.dir, w.branch)
        this.sessions.clear(root, w.name)
      }
      for (const [id, r] of this.runs) if (r.worker === w) this.runs.delete(id)
      this.workers.delete(target)
      this.emit('change')
      return this.toast('info', `Removed ${target}'s workspace`)
    }
    const victims: Run[] = []
    if (target === 'all') {
      for (const r of this.runs.values()) if (r.state !== 'queued' && r.state !== 'running') victims.push(r)
    } else {
      const run = this.find(target)
      if (run === undefined) return
      if (run.state === 'queued' || run.state === 'running') return this.toast('error', 'Stop it first')
      victims.push(run)
    }
    for (const r of victims) this.runs.delete(r.id)
    this.emit('change')
    this.toast('info', `Dropped ${victims.length} run(s)`)
  }

  /** Forgets the agent's saved session and queued messages; its next turn starts fresh. */
  async reset(name: string): Promise<void> {
    const root = await this.rootDir()
    if (root === undefined) return this.toast('error', 'Agents need a git repository. Start pager inside one.')
    if (!this.registry.instances().some((c) => c.name === name)) return this.toast('error', `No agent "${name}"`)
    const w = this.workers.get(name)
    if (w !== undefined) {
      for (const m of w.inbox.splice(0)) m.done?.({ ...NO_OUTCOME, text: '(reset)' })
      w.context = undefined
    }
    this.sessions.clear(root, name)
    this.toast('success', `${name} will start a fresh session`)
  }

  list(): void {
    if (this.runs.size === 0) return this.post('No agent runs yet.')
    for (const r of this.runs.values()) this.post(`${r.id}  ${r.state}  ${r.files.length} file(s)${r.merged ? '  merged' : ''}`)
  }

  setGoal(text: string): void {
    void this.rootDir().then((root) => {
      if (root === undefined) return this.toast('error', 'Agents need a git repository. Start pager inside one.')
      this.boardState.setGoal(root, text.trim())
      this.post(text.trim() === '' ? 'goal cleared' : `goal: ${text.trim()}`)
    })
  }

  /** Runs the agent's own CLI with `argv` (e.g. `mcp list`, `models`) in the working directory and posts its output. */
  cli(agent: string, argv: string[]): Promise<void> {
    return this.track(this.runCli(agent, argv))
  }

  private async runCli(name: string, argv: string[]): Promise<void> {
    const cli = this.registry.instances().find((c) => c.name === name)?.cli ?? name
    const found = await this.resolveBin(cli, false)
    if ('error' in found) return this.toast('error', found.error)
    this.append('you', 'text', `$ ${name} ${argv.join(' ')}`, [name])
    try {
      const res = await runProcess(found.bin, argv, { cwd: this.opts.workdir, env: this.env, timeoutMs: CHECK_TIMEOUT_MS })
      const body = stripVTControlCharacters([res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean).join('\n')).replaceAll('\r\n', '\n')
      const status = res.timedOut ? '(timed out; only non-interactive commands work here)' : res.code === 0 ? '' : `(exit ${res.code})`
      this.append(name, 'text', [body.slice(0, CLI_OUTPUT_MAX), status].filter(Boolean).join('\n') || '(no output)', [name])
    } catch (err) {
      this.append(name, 'text', `(failed: ${errMsg(err)})`, [name])
    }
  }

  // ---- readiness, setup and configuration ----

  /** Quiet readiness check of every known agent CLI (at startup and after setup changes); seeds the default team on first run. */
  refresh(clis?: string[]): Promise<void> {
    this.checkingNow = true
    this.checking = this.track(this.doRefresh(clis)).finally(() => {
      this.checkingNow = false
      this.emit('change')
    })
    return this.checking
  }

  private async doRefresh(clis?: string[]): Promise<void> {
    const known = new Set<string>(clis ?? [...Object.keys(PRESETS), ...Object.keys(this.registry.custom()), ...Object.keys(this.adapters), ...this.registry.instances().map((i) => i.cli)])
    const queue = [...known]
    const seeded = !fs.existsSync(path.join(this.opts.dataDir, 'agents.json'))
    for (const cli of queue) this.registry.setReadiness(cli, { state: 'checking' })
    this.emit('change')
    const pool = Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, async () => {
      for (let cli = queue.shift(); cli !== undefined; cli = queue.shift()) {
        this.registry.setReadiness(cli, await this.checkCli(cli))
        this.emit('change')
      }
    })
    await Promise.all(pool)
    if (seeded && !this.registry.hasInstances()) {
      for (const cli of SEED_CLIS) if (this.registry.readiness(cli).state === 'ready') this.registry.addInstance(cli)
    }
  }

  private async checkCli(cli: string): Promise<Readiness> {
    const spec = this.specFor(cli)
    if (spec === undefined) return { state: 'failed', reason: 'unknown agent' }
    const acp = this.acpPossible(spec)
    const acpBin = acp ? await findBinary(spec.acpBin ?? spec.bin) : undefined
    const oneShotBin = spec.args === undefined ? undefined : await findBinary(spec.bin)
    const bin = acpBin ?? oneShotBin
    if (bin === undefined) return { state: 'missing', reason: `${spec.acpBin ?? spec.bin} not found on PATH` }
    if (/\.(cmd|bat)$/i.test(bin)) return { state: 'failed', reason: `${path.basename(bin)} is a .cmd shim; install its native binary` }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-check-'))
    const env = { ...this.env, ...this.registry.launchFor(cli)?.env }
    try {
      let acpError = ''
      if (acpBin !== undefined) {
        const probe = await probeAcp(acpBin, spec.acp ?? [], dir, env)
        if (probe.ok) {
          if (probe.commands.length > 0) this.commandStore.set(cli, probe.commands)
          if (probe.options.length > 0) this.cliOptions.set(cli, probe.options)
          return { state: 'ready' }
        }
        acpError = probe.error
        if (oneShotBin === undefined) return { state: 'failed', reason: this.withAuthHint(cli, acpError) }
      }
      const res = await runProcess(oneShotBin ?? bin, ['--version'], { cwd: dir, env, timeoutMs: VERSION_TIMEOUT_MS })
      if (res.code === 0) return { state: 'ready' }
      return { state: 'failed', reason: this.withAuthHint(cli, res.stderr.trim().slice(-160) || acpError || `exit ${res.code}`) }
    } catch (err) {
      return { state: 'failed', reason: errMsg(err) }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  }

  private withAuthHint(cli: string, reason: string): string {
    const hint = Object.hasOwn(PRESETS, cli) ? PRESETS[cli]?.auth : undefined
    return hint !== undefined && hint !== '' && AUTH_HINT.test(reason) ? `${reason} (${hint})` : reason
  }

  /** `/agent check`: re-checks every agent and posts what it found, including a real prompt round trip for one-shot capable agents. */
  async check(names?: string[]): Promise<void> {
    const clis = names === undefined ? [...new Set([...SEED_CLIS, ...this.registry.instances().map((i) => i.cli)])] : names.map((n) => this.registry.instances().find((i) => i.name === n)?.cli ?? n)
    await this.refresh(clis)
    await Promise.all(
      clis.map(async (cli) => {
        const state = this.registry.readiness(cli)
        if (state.state !== 'ready') return this.post(`${cli}: ${state.state === 'missing' || state.state === 'failed' ? state.reason : state.state}`)
        const spec = this.specFor(cli)
        const found = spec?.args === undefined ? undefined : await this.resolveBin(cli, false)
        if (spec?.args === undefined || found === undefined || 'error' in found) return this.post(`${cli}: ok`)
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-check-'))
        const started = Date.now()
        try {
          const res = await runProcess(found.bin, spec.args('Reply with exactly: PAGER_OK', dir), { cwd: dir, env: this.env, timeoutMs: CHECK_TIMEOUT_MS })
          const secs = ((Date.now() - started) / 1000).toFixed(1)
          if ((spec.extract ?? ((s: string) => s.trim()))(res.stdout).includes('PAGER_OK')) {
            this.post(`${cli}: ok (${secs}s)${this.acpPossible(spec) ? ' · acp' : ''}`)
          } else {
            const tail = (res.stderr.trim() || res.stdout.trim()).slice(-200)
            this.post(`${cli}: failed (exit ${res.code}) ${tail}`)
          }
        } catch (err) {
          this.post(`${cli}: failed ${errMsg(err)}`)
        } finally {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      }),
    )
  }

  /** Adds a named teammate, checking its CLI first when needed. */
  async addAgent(cli: string, name?: string): Promise<AgentConfig | string> {
    if (!this.registry.isKnownCli(cli)) return `Unknown agent "${cli}". See /agent setup`
    if (this.registry.readiness(cli).state !== 'ready') await this.refresh([cli])
    const state = this.registry.readiness(cli)
    if (state.state !== 'ready') return `${cli} is not ready: ${state.state === 'missing' || state.state === 'failed' ? state.reason : state.state}`
    const added = this.registry.addInstance(cli, name)
    if (typeof added === 'string') return added
    this.emit('change')
    this.toast('success', `${added.name} joined (${cli}). Open its tab or @${added.name} it`)
    return added
  }

  async addCustom(id: string, command: string[]): Promise<string | undefined> {
    const error = this.registry.addCustom(id, command)
    if (error !== null) return error
    await this.refresh([id])
    const state = this.registry.readiness(id)
    return state.state === 'ready' ? undefined : `${id} was saved but is not ready: ${state.state === 'missing' || state.state === 'failed' ? state.reason : state.state}`
  }

  removeAgent(name: string): boolean {
    const ok = this.registry.removeInstance(name)
    if (!ok) return false
    const w = this.workers.get(name)
    if (w !== undefined && w.draining) this.cancel(new Set([w]))
    this.emit('change')
    return true
  }

  setModel(name: string, model: string | undefined): void {
    this.registry.setModel(name, model)
    this.emit('change')
  }

  setColor(name: string, color: string | undefined): void {
    this.registry.setColor(name, color)
    this.emit('change')
  }

  setEffort(name: string, effort: string | undefined): void {
    this.registry.setEffort(name, effort)
    this.emit('change')
  }

  setReview(on: boolean): void {
    this.registry.setReview(on)
    this.emit('change')
  }

  // ---- notes, commands, usage ----

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
      this.memoryStore.clear(root)
      return this.post('memory cleared')
    }
    const notes = this.memoryStore.read(root).trim()
    this.post(notes === '' ? 'memory is empty' : `memory (${notes.split('\n').length} notes):\n${notes}`)
  }

  /** Posts the slash commands an agent advertises over ACP (run them with `/agent <name> /<command>`). */
  async commands(name: string): Promise<void> {
    const cfg = this.registry.instances().find((c) => c.name === name)
    const spec = cfg === undefined ? undefined : this.specFor(cfg.cli)
    if (cfg === undefined || spec === undefined || !this.acpPossible(spec)) {
      return this.toast('error', `${name} has no ACP mode here; try /agent cli ${name} --help`)
    }
    let list = this.commandStore.get(cfg.cli)
    if (list.length === 0) {
      const found = await this.resolveBin(cfg.cli, true)
      if ('error' in found) return this.toast('error', found.error)
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-acp-'))
      try {
        const probe = await probeAcp(found.bin, spec.acp ?? [], dir, { ...this.env, ...this.registry.launchFor(cfg.cli)?.env }, 5000)
        if (!probe.ok) return this.post(`${name}: could not list commands (${probe.error})`, [name])
        list = probe.commands
        this.commandStore.set(cfg.cli, list)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
      }
    }
    this.post(
      list.length === 0
        ? `${name} advertises no slash commands`
        : `${name} slash commands:\n${list.map((c) => `  /${c.name}${c.hint === undefined ? '' : ` <${c.hint}>`}  ${c.description}`.trimEnd()).join('\n')}`,
      [name],
    )
  }

  /** Runs the agent's own `/usage` and keeps the text for Home. Agents without the command report context only. */
  async usage(names?: string[]): Promise<void> {
    const targets = (names ?? this.names()).filter((n) => this.registry.ready().some((c) => c.name === n))
    await Promise.all(
      targets.map(async (name) => {
        const cfg = this.registry.instances().find((c) => c.name === name)
        const w = this.workers.get(name)
        if (cfg === undefined || !this.commandStore.has(cfg.cli, 'usage')) {
          return this.post(w?.context === undefined ? `${name}: no usage data (the agent has no /usage command)` : `${name}: context ${Math.round((w.contextPct() ?? 0) * 100)}% of ${w.context.size} tokens`, [name])
        }
        const out = await this.send(name, { from: 'pager', kind: 'user', text: '/usage', chain: [] })
        const worker = this.workers.get(name)
        if (worker !== undefined && out.ok) worker.usage = { text: out.text, at: Date.now() }
        this.emit('change')
      }),
    )
  }

  /** `/compact`, `/handoff` or `/shake` passed to the agent's own command of that name. */
  compact(name: string, mode: 'compact' | 'handoff' | 'shake' = 'compact'): void {
    const cfg = this.registry.ready().find((c) => c.name === name)
    if (cfg === undefined) return this.toast('error', `No ready agent "${name}"`)
    if (!this.commandStore.has(cfg.cli, mode)) return this.toast('error', `${name} has no /${mode} command`)
    void this.send(name, { from: 'pager', kind: 'user', text: `/${mode}`, chain: [] })
  }

  /** Runs one of the agent's own slash commands verbatim. */
  command(name: string, text: string): Promise<Outcome> {
    return this.send(name, { from: 'you', kind: 'user', text, chain: [] })
  }

  async close(): Promise<void> {
    this.closing = true
    this.cancel(new Set(this.workers.values()))
    await Promise.allSettled([...this.inflight])
    await this.tools.close()
    this.removeAllListeners()
  }

  // ---- internals ----

  /** A popup in pager plus a desktop alert (the engine turns `notify` into a notification with a chime). */
  private announce(kind: ToastKind, text: string, title: string): void {
    this.toast(kind, text)
    this.emit('notify', title, text)
  }

  private toast(kind: ToastKind, text: string): void {
    const t: Toast = { kind, text }
    this.emit('toast', t)
  }

  private append(author: string, kind: 'text' | 'system', text: string, to?: string[]): RoomEntry {
    const entry = this.log.add(author, kind, text, to, true)
    this.emit('change')
    return entry
  }

  /** A pager line in the hub, and in the tabs of the agents it is about. */
  private post(text: string, to?: string[]): void {
    this.append('pager', 'system', text, to)
  }

  private addMemory(root: string, who: string, note: string): void {
    const error = this.memoryStore.add(root, who, note)
    if (error !== undefined) this.toast('warn', `Could not save agent memory: ${error}`)
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

  private specFor(cli: string): AdapterSpec | undefined {
    if (Object.hasOwn(this.adapters, cli)) return this.adapters[cli]
    const launch = this.registry.launchFor(cli)
    if (launch !== undefined) return { bin: launch.bin, acp: launch.args }
    return Object.hasOwn(PRESETS, cli) ? { bin: PRESETS[cli]?.bin ?? cli } : undefined
  }

  private acpPossible(spec: AdapterSpec): boolean {
    return spec.acp !== undefined && process.env.PAGER_NO_ACP !== '1'
  }

  private async resolveBin(cli: string, acp: boolean): Promise<{ bin: string } | { error: string }> {
    const spec = this.specFor(cli)
    if (spec === undefined) return { error: `${cli} is not a known agent` }
    const name = acp ? (spec.acpBin ?? spec.bin) : spec.bin
    const bin = await findBinary(name)
    if (bin === undefined) return { error: `${name} was not found on PATH` }
    if (/\.(cmd|bat)$/i.test(bin)) return { error: `${name} resolves to a .cmd shim; install its native binary` }
    return { bin }
  }

  private async acquire(w: Worker): Promise<boolean> {
    if (this.active < this.limits.maxConcurrent) {
      this.active++
      w.holdsSlot = true
      return true
    }
    const { promise, resolve } = Promise.withResolvers<boolean>()
    this.waiters.push({
      worker: w,
      wake: (granted) => {
        w.holdsSlot = granted
        resolve(granted)
      },
    })
    return promise
  }

  private release(w: Worker): void {
    if (!w.holdsSlot) return
    w.holdsSlot = false
    const next = this.waiters.shift()
    if (next === undefined) this.active--
    else next.wake(true) // the slot is handed over, `active` stays
  }

  // ---- the turn loop ----

  /** Runs the worker's queued messages, all at once as one turn, until its inbox stays empty. */
  private async drain(w: Worker): Promise<void> {
    if (w.draining) return
    w.draining = true
    this.refreshState(w, 'working')
    try {
      while (w.inbox.length > 0 && !this.closing) {
        w.stopped = false
        const batch = w.inbox.splice(0)
        let outcome: Outcome = NO_OUTCOME
        try {
          outcome = await this.runBatch(w, batch)
        } catch (err) {
          if (err instanceof CancelledError) this.post('stopped', [w.name])
          else {
            this.post(`failed: ${errMsg(err)}`, [w.name])
            this.toast('error', errMsg(err))
          }
        }
        for (const m of batch) m.done?.(outcome)
        this.afterTurn(w, batch, outcome)
      }
    } finally {
      w.draining = false
      w.turn = undefined
      this.refreshState(w, 'idle')
      this.trimRuns()
    }
  }

  private refreshState(w: Worker, state: Worker['state']): void {
    w.state = state
    this.emit('change')
  }

  private trimRuns(): void {
    while (this.runs.size > MAX_RUNS_KEPT) {
      const oldest = [...this.runs.values()].find((r) => r.state !== 'queued' && r.state !== 'running')
      if (oldest === undefined) return
      this.runs.delete(oldest.id)
    }
  }

  private async runBatch(w: Worker, batch: Inbox[]): Promise<Outcome> {
    const run: Run = { id: `${w.name}-${randomBytes(3).toString('hex')}`, agent: w.name, worker: w, state: 'queued', files: [], merged: false }
    this.runs.set(run.id, run)
    this.emit('change')
    const granted = await this.acquire(w)
    try {
      if (!granted || w.stopped) {
        run.state = 'cancelled'
        this.emit('change')
        throw new CancelledError()
      }
      run.state = 'running'
      this.emit('change')
      return await this.runTurn(w, run, batch).catch((err: unknown) => {
        if (err instanceof CancelledError) run.state = 'cancelled'
        throw err
      })
    } finally {
      this.release(w)
    }
  }

  /** The post-turn follow ups: automatic peer review and automatic compaction. */
  private afterTurn(w: Worker, batch: Inbox[], outcome: Outcome): void {
    const verbatim = batch.length === 1 && batch[0]?.text.startsWith('/') === true
    if (outcome.ok && verbatim && batch[0]?.text.startsWith('/compact') === true) w.context = undefined
    else if (outcome.ok && !verbatim && w.turnKind === 'normal') void this.maybeReview(w, outcome)
    const pct = w.contextPct()
    const cfg = this.registry.instances().find((c) => c.name === w.name)
    if (this.registry.autoCompact && pct !== undefined && pct >= COMPACT_AT && cfg !== undefined && this.commandStore.has(cfg.cli, 'compact') && !this.closing && !w.stopped) {
      this.post(`${w.name} context ${Math.round(pct * 100)}% — compacting`, [w.name])
      w.context = undefined
      w.inbox.unshift({ from: 'pager', kind: 'user', text: '/compact', chain: [] })
    }
  }

  private promptMessages(batch: Inbox[], conflict: boolean): PromptMessage[] {
    const out: PromptMessage[] = batch.map((m) => ({ from: m.from, kind: m.kind, text: m.text, ...(m.also === undefined || m.also.length === 0 ? {} : { also: m.also }) }))
    if (conflict) out.unshift({ from: 'pager', kind: 'user', text: 'SYNC CONFLICT: your branch could not merge the main branch; resolve it first.' })
    return out
  }

  private boardFor(w: Worker, root: string): string {
    const entries = this.registry.ready().map((c) => {
      const x = this.workers.get(c.name)
      const notes = this.boardState.notes(root, c.name)
      return { name: c.name, state: x?.state ?? ('idle' as const), task: x?.task ?? notes?.task ?? '', purpose: x?.purpose ?? notes?.purpose ?? '', files: x?.files ?? [], branch: `pager/${c.name}` }
    })
    return renderBoard(entries, this.boardState.goal(root), w.name)
  }

  private timeoutReason(): string {
    const s = this.limits.runTimeoutMs / 1000
    return `timed out after ${s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`}`
  }

  private async runTurn(w: Worker, run: Run, batch: Inbox[]): Promise<Outcome> {
    const started = Date.now()
    const root = await this.rootDir()
    if (root === undefined) throw new Error('Agents need a git repository. Start pager inside one.')
    const cfg = this.registry.instances().find((c) => c.name === w.name)
    const spec = this.specFor(w.cli)
    if (cfg === undefined || spec === undefined) throw new Error(`${w.name} is no longer configured`)
    const scope = [w.name]
    let liveEntry: RoomEntry | undefined
    const live = new LiveMessage((body) => {
      if (liveEntry === undefined) liveEntry = this.log.add(w.name, 'text', body, scope, false)
      else liveEntry.text = body
      this.emit('change')
    })
    // Posts the turn's final text: into the streamed entry when there is one, else as a new message.
    const settle = (text: string): void => {
      live.stop()
      if (liveEntry === undefined) this.append(w.name, 'text', text, scope)
      else {
        liveEntry.text = text
        this.log.persist(liveEntry)
        this.emit('change')
      }
    }
    const failed = (reason: string): Outcome => {
      run.state = 'failed'
      const text = `(failed: ${reason})`
      const partial = live.message()
      settle(partial === '' ? text : `${partial}\n${text}`)
      this.announce('error', `${w.name}: ${reason}`, w.name)
      return { runId: run.id, text, ok: false, files: [] }
    }
    const found = await this.resolveBin(w.cli, false).then(async (r) => ('error' in r && this.acpPossible(spec) ? this.resolveBin(w.cli, true) : r))
    if ('error' in found) return failed(found.error)
    let head: string
    try {
      head = await headSha(root)
    } catch (err) {
      return failed(errMsg(err))
    }
    let conflict = false
    try {
      await ensureWorktree(root, w.dir, w.branch, head)
      conflict = (await syncWorktree(w.dir, head)) === 'conflict'
      for (const m of batch) if (m.mergeBranch !== undefined && (await syncWorktree(w.dir, m.mergeBranch)) === 'conflict') conflict = true
    } catch (err) {
      return failed(errMsg(err))
    }
    if (w.stopped) throw new CancelledError()
    const startSha = await currentSha(w.dir)
    const kind = batch.some((m) => m.kind === 'review') ? 'review' : 'normal'
    const verbatim = batch.length === 1 && batch[0]?.text.startsWith('/') === true && batch[0]?.kind === 'user'
    const userText = batch.filter((m) => m.kind === 'user').map((m) => m.text).join('\n')
    const ctx: TurnCtx = { runId: run.id, kind, shownDocs: verbatim ? [] : (this.opts.docs?.list(userText) ?? []), docEdits: 0, notes: 0, touched: [], refused: [] }
    w.turn = ctx
    w.turnKind = kind
    this.refreshState(w, kind === 'review' ? 'reviewing' : 'working')
    const chainIds = [...new Set(batch.flatMap((m) => m.chain))]
    const port = await this.tools.start()
    const token = this.tools.issue({ agent: w.name, kind, chain: chainIds })
    const launchEnv = this.registry.launchFor(w.cli)?.env
    const env: NodeJS.ProcessEnv = { ...this.env, ...launchEnv, PAGER_TOOL_PORT: String(port), PAGER_TOOL_TOKEN: token }
    const shim = shimSpec(port, token)
    const mcpServers = [{ name: 'pager', ...shim }]
    const want = { model: cfg.model, effort: cfg.effort }
    const buildPromptFor = (tools: boolean): string =>
      verbatim
        ? (batch[0]?.text ?? '')
        : buildPrompt({
            agent: w.name,
            branch: w.branch,
            board: this.boardFor(w, root),
            memory: this.memoryStore.read(root),
            docs: ctx.shownDocs,
            room: this.log
              .all()
              .filter((e) => e.kind === 'text' || / changed \d+ file/.test(e.text))
              .map((e) => ({ author: e.author, text: e.text })),
            messages: formatMessages(this.promptMessages(batch, conflict)),
            tools,
          })
    const common = { cwd: w.dir, env, timeoutMs: this.limits.runTimeoutMs, isCancelled: () => w.stopped, onChild: (c: Worker['child']) => (w.child = c), timeoutReason: () => this.timeoutReason() }
    try {
      let reply: Reply | undefined
      let text = ''
      let sessionId: string | undefined
      if (this.acpPossible(spec)) {
        const acp = await runViaAcp({
          ...common,
          bin: found.bin,
          args: spec.acp ?? [],
          prompt: buildPromptFor(true),
          resumeId: spec.resume === false ? undefined : this.sessions.get(root, w.name),
          mcpServers,
          want,
          handlers: {
            onText: (chunk) => live.text(chunk),
            onTool: (call) => live.tool(call),
            onCommands: (commands) => this.commandStore.set(w.cli, commands),
            onUsage: (usage) => {
              w.context = usage
              this.emit('change')
            },
            onConfig: (options) => {
              w.options = options
              this.cliOptions.set(w.cli, options)
              this.emit('change')
            },
            onElicit: (params) => this.elicit(w, params),
          },
        })
        for (const note of acp.notes) this.post(`${w.name}: ${note}`, scope)
        if (acp.options.length > 0) w.options = acp.options
        if (acp.reply.kind === 'fallback') {
          if (spec.args === undefined) return failed(acp.reply.reason)
          this.post(`${w.name}: ACP unavailable (${acp.reply.reason}); using one-shot mode`, scope)
        } else {
          reply = acp.reply
          sessionId = acp.sessionId
          text = live.message()
        }
      }
      if (reply === undefined) {
        const oneShot = await this.resolveBin(w.cli, false)
        if ('error' in oneShot) return failed(oneShot.error)
        const withTools = w.cli === 'claude'
        const mcpConfig = withTools ? JSON.stringify({ mcpServers: { pager: { command: shim.command, args: shim.args, env: Object.fromEntries(shim.env.map((e) => [e.name, e.value])) } } }) : undefined
        reply = await runOneShot({ ...common, bin: oneShot.bin, spec, prompt: buildPromptFor(withTools), want: { ...want, ...(mcpConfig === undefined ? {} : { mcpConfig }) } })
        if (reply.kind === 'text') text = reply.text
      }
      if (reply.kind === 'cancelled') {
        if (live.started) settle(`${live.message()}\n(stopped)`.trim())
        run.state = 'cancelled'
        this.emit('change')
        throw new CancelledError()
      }
      if (reply.kind === 'failed') return failed(reply.reason)
      if (reply.stopReason === 'refusal') return failed('agent refused')
      if (reply.stopReason === 'cancelled') return failed('agent cancelled the turn')
      if (sessionId !== undefined && spec.resume !== false) this.sessions.set(root, w.name, sessionId)
      return await this.finishTurn(w, run, { root, head, startSha, started, text, stopReason: reply.stopReason, batch, ctx, live, settle, failed })
    } finally {
      this.tools.revoke(token)
      this.questions.cancelAgent(w.name)
      w.turn = undefined
    }
  }

  private async finishTurn(
    w: Worker,
    run: Run,
    t: {
      root: string
      head: string
      startSha: string
      started: number
      text: string
      stopReason: string
      batch: Inbox[]
      ctx: TurnCtx
      live: LiveMessage
      settle: (text: string) => void
      failed: (reason: string) => Outcome
    },
  ): Promise<Outcome> {
    const scope = [w.name]
    const first = (t.batch.at(-1)?.text.split('\n', 1)[0] ?? '').slice(0, 72)
    let turnFiles: string[]
    try {
      await commitAll(w.dir, `agent(${w.name}): ${first}\n\nPager-Run: ${run.id}`)
      turnFiles = await changedFiles(w.dir, t.startSha)
      run.files = await changedFiles(w.dir, t.head)
      w.files = run.files
    } catch (err) {
      return t.failed(errMsg(err))
    }
    run.state = 'done'
    const text = t.text === '' ? '(no output)' : t.text
    t.settle(text)
    const used = t.live.summary()
    if (used !== '') this.post(`${run.id} ${used}`, scope)
    if (t.ctx.touched.length > 0) this.post(`${run.id} edited ${[...new Set(t.ctx.touched)].join(', ')}`, scope)
    if (t.ctx.refused.length > 0) this.post(`${run.id} could not edit ${t.ctx.refused.join('; ')}`, scope)
    if (t.stopReason === 'max_tokens' || t.stopReason === 'max_turn_requests') this.post(`${run.id} stopped early: ${t.stopReason}`, scope)
    if (turnFiles.length > 0) {
      const shown = turnFiles.slice(0, 5).join(', ')
      this.post(`${run.id} changed ${turnFiles.length} file(s): ${shown}${turnFiles.length > 5 ? ', ...' : ''}`, scope)
    }
    this.announce('info', `${w.name}: ${(text.split('\n', 1)[0] ?? '').slice(0, 80)}`, w.name)
    this.warnOverlap(w, turnFiles)
    this.statsLog.append({ ts: Date.now(), agent: w.name, cli: w.cli, ms: Date.now() - t.started, files: turnFiles.length, stop: t.stopReason })
    if (w.turnKind === 'review' && this.reviewing.has(w.name)) this.reviewEnded(w, text)
    this.boardState.setNotes(t.root, w.name, { task: w.task, purpose: w.purpose })
    return { runId: run.id, text, ok: true, files: turnFiles }
  }

  private warnOverlap(w: Worker, turnFiles: string[]): void {
    for (const other of this.workers.values()) {
      if (other === w) continue
      const shared = turnFiles.filter((f) => other.files.includes(f))
      if (shared.length === 0) continue
      const text = `${w.name} and ${other.name} both change ${shared.slice(0, 3).join(', ')}`
      this.toast('warn', text)
      this.post(text, [w.name, other.name])
    }
  }

  private async doMerge(target: string): Promise<void> {
    const w = this.workers.get(target) ?? this.find(target)?.worker
    if (w === undefined) return
    if (w.draining) return this.toast('error', 'The agent is still working')
    const root = await this.rootDir()
    if (root === undefined) return this.toast('error', 'Agents need a git repository. Start pager inside one.')
    if (await isDirty(root)) return this.toast('error', 'Commit or stash your changes first, then merge again.')
    if ((await aheadCount(root, w.branch)) === 0) return this.toast('info', 'Nothing to merge')
    const res = await mergeBranch(root, w.branch)
    if (!res.ok) {
      const shown = res.conflicts.slice(0, 3).join(', ')
      this.toast('error', res.conflicts.length > 0 ? `Merge conflict in ${shown}${res.conflicts.length > 3 ? ', ...' : ''}. Nothing was changed.` : `Merge failed: ${res.error}. Nothing was changed.`)
      this.post(`merge of ${w.name} failed; conflicts: ${res.conflicts.join(', ') || res.error}`, [w.name])
      return
    }
    for (const other of this.workers.values()) {
      if (!other.draining && (await isAncestor(root, other.branch).catch(() => false))) {
        other.files = []
        for (const r of this.runs.values()) if (r.worker === other) r.merged = true
      }
    }
    this.emit('change')
    this.post(`merged ${w.name}`, [w.name])
    this.toast('success', `Merged ${w.name}`)
  }

  // ---- peer review ----

  private async maybeReview(w: Worker, outcome: Outcome): Promise<void> {
    if (!this.registry.review || outcome.files.length === 0 || this.closing) return
    if (w.reviewRound >= REVIEW_MAX_ROUNDS) {
      this.post(`review stopped after ${REVIEW_MAX_ROUNDS} rounds: changes still requested`, [w.name])
      return
    }
    const ready = this.registry.ready()
    const candidates = ready.map((c) => ({ name: c.name, cli: c.cli, state: this.workers.get(c.name)?.state ?? ('idle' as const) }))
    const author = ready.findIndex((c) => c.name === w.name)
    const reviewer = pickReviewer(w.name, candidates, this.reviewCursor < 0 ? author : this.reviewCursor)
    if (reviewer === undefined) return this.post('no reviewer available', [w.name])
    this.reviewCursor = ready.findIndex((c) => c.name === reviewer)
    const root = await this.rootDir()
    if (root === undefined) return
    let request: string
    try {
      const before = outcome.files.length === 0 ? '' : await this.baseOf(w, root)
      const { stat, diff } = await diffSince(w.dir, before)
      request = reviewRequest({ author: w.name, branch: w.branch, dir: w.dir, stat, diff, finalText: outcome.text })
    } catch (err) {
      return this.post(`review of ${w.name} skipped: ${errMsg(err)}`, [w.name])
    }
    this.reviewing.set(reviewer, { author: w.name })
    this.post(`${reviewer} is reviewing ${w.name}'s changes`, [w.name, reviewer])
    void this.send(reviewer, { from: w.name, kind: 'review', text: request, chain: [] })
  }

  /** The commit a review diff starts from: where the author's latest turn began (its parent chain's merge-base with main). */
  private async baseOf(w: Worker, root: string): Promise<string> {
    return headSha(root)
  }

  /** A reviewer that never called submit_review: its closing text becomes the comments, verdict unknown, no loop. */
  private reviewEnded(reviewer: Worker, text: string): void {
    const entry = this.reviewing.get(reviewer.name)
    if (entry === undefined) return
    this.reviewing.delete(reviewer.name)
    this.concludeReview(reviewer.name, entry.author, 'unknown', text)
  }

  private concludeReview(reviewer: string, authorName: string, verdict: Verdict, comments: string): void {
    this.post(`${reviewer} reviewed ${authorName}: ${verdict}\n${comments}`.trim(), [reviewer, authorName])
    this.announce(verdict === 'changes' ? 'warn' : 'info', `${reviewer} reviewed ${authorName}: ${verdict}`, reviewer)
    const author = this.workers.get(authorName)
    const cfg = this.registry.instances().find((c) => c.name === authorName)
    this.statsLog.append({ ts: Date.now(), agent: authorName, cli: cfg?.cli ?? '', ms: 0, files: 0, stop: 'review', verdict })
    if (author === undefined) return
    author.reviewRound++
    if (verdict === 'approve') author.reviewRound = 0
    if (verdict !== 'changes') return
    if (author.reviewRound >= REVIEW_MAX_ROUNDS) return this.post(`review stopped after ${REVIEW_MAX_ROUNDS} rounds: changes still requested`, [authorName])
    void this.send(authorName, { from: reviewer, kind: 'feedback', text: feedbackText(reviewer, verdict, comments), chain: [] })
  }

  // ---- questions ----

  private async elicit(w: Worker, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const form = fieldsFromElicitation(params)
    if (form === undefined) return undefined
    const answers = await this.questions.ask(w.name, form.message, form.fields)
    return answers === null ? undefined : contentFromAnswers(form.fields, answers)
  }

  // ---- the tool set agents call ----

  private turnOf(from: TurnToken): { w: Worker; ctx: TurnCtx } {
    const w = this.workers.get(from.agent)
    if (w?.turn === undefined) throw new Error('that turn is over')
    return { w, ctx: w.turn }
  }

  private host(): ToolHost {
    return {
      sendMessage: (from, to, text, wait) => this.toolSend(from, to, text, wait),
      listAgents: (from) => this.toolBoard(from),
      setStatus: (from, task, fits) => this.toolStatus(from, task, fits),
      askUser: (from, questions) => this.toolAsk(from, questions),
      remember: (from, note) => this.toolRemember(from, note),
      docRead: (from, name) => this.toolDocRead(from, name),
      docWrite: (from, name, text, append) => this.toolDocWrite(from, name, text, append),
      submitReview: (from, verdict, comments) => this.toolReview(from, verdict, comments),
    }
  }

  private async toolSend(from: TurnToken, to: string, text: string, wait: boolean): Promise<string> {
    const names = this.names()
    if (to === from.agent) throw new Error('you cannot message yourself')
    if (!names.includes(to)) throw new Error(`no ready agent "${to}"; ready: ${names.filter((n) => n !== from.agent).join(', ') || 'none'}`)
    if (from.chain.includes(to)) throw new Error(`cycle: ${[...from.chain, from.agent, to].join(' > ')}`)
    if (from.chain.length >= PEER_MAX_DEPTH) throw new Error(`too deep: ${PEER_MAX_DEPTH} agents already delegated down to you`)
    this.append(from.agent, 'text', `→ @${to} ${text}`, [from.agent, to])
    const sender = this.workers.get(from.agent)
    const outcome = this.send(to, { from: from.agent, kind: 'peer', text, chain: [...from.chain, from.agent] })
    if (!wait) return `sent to ${to}`
    // A waiting agent gives its slot back, or a chain of waiters could starve the agent it waits on.
    if (sender?.holdsSlot === true) this.release(sender)
    const timeout = Promise.withResolvers<undefined>()
    const timer = setTimeout(() => timeout.resolve(undefined), PEER_WAIT_TIMEOUT_MS)
    try {
      const done = await Promise.race([outcome, timeout.promise])
      return done === undefined ? JSON.stringify({ queued: true }) : done.text
    } finally {
      clearTimeout(timer)
      if (sender !== undefined && !sender.stopped) await this.acquire(sender)
    }
  }

  private toolBoard(from: TurnToken): string {
    const { w } = this.turnOf(from)
    const root = this.root
    return root === undefined ? '' : this.boardFor(w, root)
  }

  private toolStatus(from: TurnToken, task: string, fits: string | undefined): string {
    const { w } = this.turnOf(from)
    w.task = task.slice(0, 300)
    if (fits !== undefined) w.purpose = fits.slice(0, 300)
    if (this.root !== undefined) this.boardState.setNotes(this.root, w.name, { task: w.task, purpose: w.purpose })
    this.emit('change')
    return 'status updated'
  }

  private async toolAsk(from: TurnToken, questions: AskQuestion[]): Promise<string> {
    this.turnOf(from)
    const fields = fieldsFromAskUser(questions)
    const answers = await this.questions.ask(from.agent, questions.length === 1 ? (questions[0]?.question ?? '') : 'a few questions', fields)
    return JSON.stringify(askUserResult(fields, answers))
  }

  private toolRemember(from: TurnToken, note: string): string {
    const { w, ctx } = this.turnOf(from)
    if (ctx.notes >= MAX_NOTES_PER_RUN) throw new Error(`at most ${MAX_NOTES_PER_RUN} notes per turn`)
    if (this.root === undefined) throw new Error('no repository')
    ctx.notes++
    this.addMemory(this.root, w.name, note.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_CHARS))
    return 'remembered'
  }

  private shownDoc(ctx: TurnCtx, name: string): { name: string; text: string } {
    const seen = ctx.shownDocs.find((d) => d.name.toLowerCase() === name.toLowerCase())
    if (seen === undefined) throw new Error(`${name}: it was not shown to the agent`)
    return seen
  }

  private toolDocRead(from: TurnToken, name: string): string {
    const { ctx } = this.turnOf(from)
    const seen = this.shownDoc(ctx, name)
    return this.opts.docs?.list(`#${seen.name}`).find((d) => d.name === seen.name)?.text ?? seen.text
  }

  private toolDocWrite(from: TurnToken, name: string, text: string, append: boolean): string {
    const { ctx } = this.turnOf(from)
    const refuse = (why: string): never => {
      ctx.refused.push(`${name} (${why})`)
      throw new Error(`${name}: ${why}`)
    }
    if (ctx.docEdits >= MAX_DOC_EDITS_PER_RUN) refuse(`at most ${MAX_DOC_EDITS_PER_RUN} document edits per turn`)
    const seen = (() => {
      try {
        return this.shownDoc(ctx, name)
      } catch {
        return refuse('it was not shown to the agent')
      }
    })()
    if (text.length > DOC_EDIT_MAX_CHARS) refuse('the text is too long')
    if (!append && seen.text.length > docCap(ctx.shownDocs.length)) refuse('a replacement needs the whole document, which was cut')
    const why = this.opts.docs === undefined ? 'documents are unavailable' : this.opts.docs.write(seen.name, text, append, seen.text)
    if (why !== null) refuse(why)
    ctx.docEdits++
    ctx.touched.push(seen.name)
    return `${append ? 'appended to' : 'replaced'} ${seen.name}`
  }

  private toolReview(from: TurnToken, verdict: 'approve' | 'changes', comments: string): string {
    this.turnOf(from)
    const entry = this.reviewing.get(from.agent)
    if (entry === undefined) throw new Error('nobody asked you for a review')
    this.reviewing.delete(from.agent)
    this.concludeReview(from.agent, entry.author, verdict, comments)
    return 'review submitted'
  }
}

/** `omp>claude` against the ready names, when it is a chain of at least two. */
function chainSpec(spec: string, names: string[]): string[] | undefined {
  const parts = spec.toLowerCase().split('>')
  return parts.length >= 2 && parts.length <= 4 && parts.every((p) => names.includes(p)) ? parts : undefined
}
