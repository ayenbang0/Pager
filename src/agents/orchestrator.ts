import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import type { MessageView, Toast, ToastKind } from '../app/engine.js'
import { removeTree } from '../platform/removeTree.js'
import { isRecord } from '../util/guards.js'
import { ADAPTERS, findBinary, type AdapterSpec } from './run/adapters.js'
import type { AcpCommand, AcpConfigOption } from './run/acp.js'
import { renderBoard } from './state/board.js'
import { PRESETS } from './run/catalog.js'
import { CheckpointLog, checkpointLines, type Checkpoint, type RestoreResult } from './git/checkpoints.js'
import { CHECKOUT, ConflictBook, conflictsOf, describeConflict, predictConflicts } from './git/conflicts.js'
import { formatStat, type DiffStat } from './git/diffstat.js'
import { changedFiles, commitAll, currentSha, diffNumstat, diffSince, ensureWorktree, headSha, isAncestor, isDirty, aheadCount, mergeBranch, removeWorktree, repoRoot, syncWorktree } from './git/git.js'
import { LiveMessage } from './run/live.js'
import { killTree, runProcess } from './run/process.js'
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
} from './run/protocol.js'
import { Registry, RESERVED_NAMES, type AgentConfig, type Readiness } from './run/registry.js'
import { askUserResult, contentFromAnswers, fieldsFromAskUser, fieldsFromElicitation, Questions, type QuestionView } from './run/questions.js'
import { feedbackText, pickReviewer, reviewRequest, REVIEW_MAX_ROUNDS, type Verdict } from './git/review.js'
import { classifyRisk, describeCall, riskDecision, riskQuestion } from './state/risk.js'
import { FORWARD_THRESHOLD, parseMentions, relevance } from './run/router.js'
import { BudgetStore, BUDGET_USAGE, ALL_KEY, check, DailyOnce, describeCap, describeUse, parseBudget, refusal, usedToday, warning } from './state/budget.js'
import { StatsLog, summarize, type AgentTotals } from './state/stats.js'
import { BoardState, CommandStore, errMsg, Memory, repoKey, ROOM_ID, RoomLog, SessionStore, type RoomEntry } from './state/store.js'
import { shimSpec, ToolServer, type AskQuestion, type ToolHost, type TurnToken } from './tools/toolserver.js'
import { probeAcp, runOneShot, runViaAcp, type Reply } from './run/turn.js'
import type { AgentView } from './types.js'
import { mergeGate, runVerify, VerifyStore, verifyHeadline, verifyReport, verifyWord, type VerifyResult } from './git/verify.js'
import { Worker, type Inbox, type Outcome, type TurnCtx } from './run/worker.js'

/** A guest of a shared session speaking through the host's room. `label` is unique among the room's names; `pk` is their public key. */
export interface Actor {
  label: string
  pk: string
}

export { repoKey, ROOM_ID }
export const MAX_CONCURRENT = 3
export const CLI_OUTPUT_MAX = 100_000
/** Per-turn wall-clock limit for an agent run; 0 means none. A stuck run is ended with `/agent stop`. */
export const RUN_TIMEOUT_MS = 0
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
  /** Web search and page reading for the web_search and web_read tools; absent or throwing means the web is off. */
  web?: { search(query: string): Promise<string>; read(url: string): Promise<string> }
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
  /** Added and deleted lines of the branch against the base, as of this run's end. */
  stat?: DiffStat
  /** Its turn was undone with `/agent undo`: the work is gone from the branch. */
  undone?: true
  /** The agent's board notes before its turn, restored if the turn is undone. */
  notesBefore?: { task: string; purpose: string }
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
  private readonly budgets: BudgetStore
  private readonly budgetNotices = new DailyOnce()
  private readonly commandStore: CommandStore
  private readonly cliOptions = new Map<string, AcpConfigOption[]>()
  private readonly tools: ToolServer
  private readonly inflight = new Set<Promise<unknown>>()
  private readonly waiters: { worker: Worker; wake: (granted: boolean) => void }[] = []
  private readonly checkpoints = new Map<string, CheckpointLog>()
  private readonly reviewing = new Map<string, { author: string }>()
  private readonly verifyStore: VerifyStore
  /** The last verify run per agent: what the merge gate, the board and `/agent log` read. */
  private readonly verifyResults = new Map<string, VerifyResult>()
  /** Lines added and deleted by each agent's unmerged work. */
  private readonly lineStats = new Map<string, DiffStat>()
  private readonly conflicts = new ConflictBook()
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
    this.budgets = new BudgetStore(path.join(dir, 'agent-budgets.json'))
    this.commandStore = new CommandStore(path.join(dir, 'agents-commands.json'))
    this.verifyStore = new VerifyStore(path.join(dir, 'agents-verify.json'))
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
    for (const r of this.runs.values()) if (r.undone !== true) latest.set(r.agent, r)
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
        agent: e.pk === undefined && e.author !== 'you' && e.author !== 'pager',
        text: e.text,
        status: null,
        markdown: e.kind === 'text' && e.pk === undefined && e.author !== 'you',
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

  /** The room's entries, oldest first (read-only; for sharing the room with guests). */
  entries(): readonly RoomEntry[] {
    return this.log.all()
  }

  /** The label a guest speaks under: their name, tidied, and never one that an agent or pager itself uses. */
  guestLabel(name: string, pk: string): string {
    const tidy = name.replace(/[[\]\p{Cc}]/gu, '').trim().slice(0, 24) || pk.slice(0, 8)
    const taken = [...this.names(), ...RESERVED_NAMES].some((n) => n.toLowerCase() === tidy.toLowerCase())
    return taken ? `${tidy}~${pk.slice(0, 4)}` : tidy
  }

  /** A guest's message. Returns why it was refused, or undefined when it reached the room. Commands stay with the host. */
  sayAsGuest(text: string, tab: string | undefined, actor: Actor): string | undefined {
    const body = text.trim()
    const refuse = (why: string): string => {
      this.post(`${actor.label}: ${why}`)
      return why
    }
    if (body === '') return 'empty message'
    if (body.startsWith('/')) return refuse('commands are host-only')
    if (/^@[a-z][a-z0-9_-]+\s+!/i.test(body)) return refuse('! passthrough is host-only')
    this.say(text, tab, actor)
    return undefined
  }

  /** The user typed `text` in the hub or in an agent's tab (`tab`). Mentions pick who hears it. `actor` is a shared-session guest. */
  say(text: string, tab?: string, actor?: Actor): void {
    if (this.checkingNow) void this.checking.then(() => this.sayNow(text, tab, actor))
    else this.sayNow(text, tab, actor)
  }

  private sayNow(text: string, tab: string | undefined, actor: Actor | undefined): void {
    const who = actor?.label ?? 'you'
    const guest = actor === undefined ? {} : ({ guest: true } as const)
    const names = this.names()
    const own = tab !== undefined && tab !== ROOM_ID && names.includes(tab) ? tab : undefined
    const body = text.trim()
    const chainMatch = /^@(\w[\w-]*(?:>\w[\w-]*)+)\s+([\s\S]+)$/.exec(body)
    const chain = chainMatch?.[1] === undefined ? undefined : chainSpec(chainMatch[1], names)
    if (chain !== undefined && chainMatch?.[2] !== undefined) {
      void this.chain(chain, chainMatch[2].trim(), true, actor)
      return
    }
    const passthrough = /^@([a-z][a-z0-9_-]+)\s+!([\s\S]*)$/i.exec(body)
    const target = passthrough?.[1]?.toLowerCase()
    if (target !== undefined && names.includes(target)) {
      this.append(who, 'text', text, [target], actor?.pk)
      const argv = splitArgs(passthrough?.[2] ?? '')
      if (argv.length === 0) this.toast('error', `Usage: @${target} !<cli arguments>`)
      else void this.cli(target, argv)
      return
    }
    const { targets } = parseMentions(body, names)
    const to = targets.length > 0 ? targets : own === undefined ? [] : [own]
    this.append(who, 'text', text, to.length > 0 ? to : undefined, actor?.pk)
    if (to.length === 0) {
      const hint = names.length === 0 ? 'No agents are ready: Settings > Agents' : `Name an agent: ${names.map((n) => `@${n}`).join(', ')} or @all`
      if (actor === undefined) this.toast('warn', hint)
      else this.post(hint)
      return
    }
    for (const name of to) {
      void this.send(name, { from: who, kind: 'user', text: body, also: to.filter((t) => t !== name), chain: [], ...guest })
    }
    this.forward(body, to, who)
  }

  /** Hands a message to every other agent that has a live task it touches. */
  private forward(text: string, already: string[], from = 'you'): void {
    for (const w of this.workers.values()) {
      if (already.includes(w.name) || (w.state === 'idle' && w.task === '') || !this.names().includes(w.name)) continue
      const { score, reason } = relevance(text, { task: w.task, files: w.files })
      if (score < FORWARD_THRESHOLD) continue
      void this.send(w.name, { from, kind: 'forward', text: `pager forwarded this because it touches your task (${reason}):\n${text}`, chain: [] })
    }
  }

  /** Runs `task` as a message to one agent and resolves when its turn is over. `/agent <name> <task>` and tests use this. */
  ask(agent: string, task: string, log = true): Promise<void> {
    if (log) this.append('you', 'text', `@${agent} ${task}`, [agent])
    return this.track(this.send(agent, { from: 'you', kind: 'user', text: task, chain: [] }).then(() => undefined))
  }

  /** Runs the agents in turn; each continues from the previous one's branch and reviews its work. */
  chain(agents: string[], task: string, log = true, actor?: Actor): Promise<void> {
    if (log) this.append(actor?.label ?? 'you', 'text', `@${agents.join('>')} ${task}`, agents, actor?.pk)
    return this.track(this.runChain(agents, task, actor?.label ?? 'you', actor !== undefined))
  }

  private async runChain(agents: string[], task: string, from: string, guest: boolean): Promise<void> {
    let prev: Outcome | undefined
    let prevBranch: string | undefined
    for (const name of agents) {
      if (prev !== undefined && !prev.ok) return this.post('chain stopped: the previous step failed', agents)
      const text = prev === undefined ? task : chainTask(task, { run: prev.runId, text: prev.text })
      prev = await this.send(name, { from, kind: 'user', text, chain: [], ...(guest ? { guest: true as const } : {}), ...(prevBranch === undefined ? {} : { mergeBranch: prevBranch }) })
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
    const fail = (why: string, say = true): void => {
      if (say && msg.guest === true) this.post(why)
      msg.done?.({ ...NO_OUTCOME, text: `(${why})` })
    }
    const cfg = this.registry.ready().find((c) => c.name === name)
    if (cfg === undefined) return fail(`${name} is not available`)
    const w = await this.workerFor(cfg, msg.guest === true)
    if (w === undefined || this.closing) return fail('agent unavailable', false)
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

  private async workerFor(cfg: AgentConfig, guest = false): Promise<Worker | undefined> {
    const root = await this.rootDir()
    if (root === undefined) {
      this.toast('error', 'Agents need a git repository. Start pager inside one.')
      if (guest) this.post('The host started pager outside a git repository, so agents cannot run. Ask them to start it inside one.')
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

  /** Merges an agent's branch; `force` skips the verify gate. */
  merge(target: string, force = false): Promise<void> {
    const job = this.mergeQueue.then(() => this.doMerge(target, force)).catch((err: unknown) => this.toast('error', errMsg(err)))
    this.mergeQueue = job
    return job
  }

  /** `drop all|<run>` forgets finished run records; `drop <agent>` also removes that agent's worktree, branch and saved session. */
  async drop(target: string): Promise<void> {
    const w = this.workers.get(target)
    if (w !== undefined) {
      if (w.draining) return this.toast('error', 'Stop it first')
      await this.discardWorkspace(w)
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

  /** Removes a worker's worktree, branch, saved session and run records. */
  private async discardWorkspace(w: Worker): Promise<void> {
    const root = await this.rootDir()
    if (root !== undefined) {
      await removeWorktree(root, w.dir, w.branch)
      this.sessions.clear(root, w.name)
    }
    for (const [id, r] of this.runs) if (r.worker === w) this.runs.delete(id)
    this.workers.delete(w.name)
    this.checkpoints.delete(w.name)
    this.verifyResults.delete(w.name)
    this.lineStats.delete(w.name)
    this.conflicts.forget(w.name)
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
      w.undoNote = undefined
    }
    this.sessions.clear(root, name)
    this.toast('success', `${name} will start a fresh session`)
  }

  /** `/agent undo <name> [n]`: puts the agent's worktree back to where it was before its last n turns. */
  async undo(target: string, count = 1): Promise<void> {
    try {
      await this.doUndo(target, count)
    } catch (err) {
      this.toast('error', `Undo failed: ${errMsg(err)}`)
    }
  }

  /** `Agent <name>: checkpoints`: lists the turns that `undo` can take back, newest first (1 = the last turn). */
  async listCheckpoints(target: string): Promise<void> {
    const root = await this.rootDir()
    if (root === undefined) return this.toast('error', 'Agents need a git repository. Start pager inside one.')
    const w = await this.checkpointWorker(target)
    if (w === undefined) return this.toast('error', `No agent "${target}"`)
    const items = await this.checkpointsFor(w, root).list()
    if (items.length === 0) return this.post(`${w.name} has no turns to undo`, [w.name])
    this.post([`${w.name} can undo ${items.length} turn(s) (/agent undo ${w.name} <n>):`, ...checkpointLines(items)].join('\n'), [w.name])
  }

  private checkpointsFor(w: Worker, root: string): CheckpointLog {
    let log = this.checkpoints.get(w.name)
    if (log === undefined) {
      log = new CheckpointLog(root, w.branch)
      this.checkpoints.set(w.name, log)
    }
    return log
  }

  /** The worker named `target` (or owning run `target`); a configured agent that has not run yet in this session gets its worker created, so checkpoints from an earlier session are reachable. */
  private async checkpointWorker(target: string): Promise<Worker | undefined> {
    const known = this.workers.get(target) ?? this.find(target)?.worker
    if (known !== undefined) return known
    const cfg = this.registry.ready().find((c) => c.name === target)
    return cfg === undefined ? undefined : this.workerFor(cfg)
  }

  private async doUndo(target: string, count: number): Promise<void> {
    const root = await this.rootDir()
    if (root === undefined) return this.toast('error', 'Agents need a git repository. Start pager inside one.')
    const w = await this.checkpointWorker(target)
    if (w === undefined) return this.toast('error', `No agent "${target}"`)
    if (w.draining || w.inbox.length > 0) return this.toast('error', `${w.name} is working or has messages queued. Stop it first.`)
    const log = this.checkpointsFor(w, root)
    const available = (await log.list()).length
    if (available === 0) return this.toast('error', `${w.name} has no turns to undo`)
    if (!Number.isInteger(count) || count < 1 || count > available) return this.toast('error', `${w.name} has ${available} turn(s) to undo: /agent undo ${w.name} [1-${available}]`)
    w.draining = true // messages sent meanwhile wait in the inbox until the reset is done
    let res: RestoreResult
    try {
      res = await log.restore(w.dir, count)
    } finally {
      w.draining = false
      if (w.inbox.length > 0) this.track(this.drain(w))
    }
    const undone = new Set(res.removed.map((c) => c.run))
    for (const r of this.runs.values()) {
      if (r.worker === w && undone.has(r.id)) {
        r.undone = true
        r.files = []
      }
    }
    const head = await headSha(root)
    w.files = await changedFiles(w.dir, head)
    const stat = await diffNumstat(w.dir, head).catch(() => undefined)
    for (const r of this.runs.values()) if (r.worker === w && r.undone === true) delete r.stat
    const latest = [...this.runs.values()].filter((r) => r.worker === w && r.undone !== true).at(-1)
    if (latest !== undefined) {
      latest.files = w.files
      if (stat === undefined) delete latest.stat
      else latest.stat = stat
    }
    if (stat === undefined) this.lineStats.delete(w.name)
    else this.lineStats.set(w.name, stat)
    this.verifyResults.delete(w.name)
    await this.scanConflicts(root, true)
    const oldest = res.removed[0] as Checkpoint
    w.task = oldest.task
    w.purpose = oldest.purpose
    this.boardState.setNotes(root, w.name, { task: w.task, purpose: w.purpose })
    w.undoNote = `Your last ${count === 1 ? 'turn was' : `${count} turns were`} undone by the user; the files are back as they were before ${count === 1 ? 'it' : 'them'}. Do not assume that work still exists.`
    this.emit('change')
    this.post(`undid last ${count} turn(s) of ${w.name} (back to ${oldest.sha.slice(0, 7)})`, [w.name])
    if (res.snapshot) this.post(`${w.name} had uncommitted changes; they were committed first and stay in git reflog of ${w.dir}`, [w.name])
    this.toast('success', `Undid ${count} turn(s) of ${w.name}`)
  }

  list(): void {
    if (this.runs.size === 0) return this.post('No agent runs yet.')
    const latest = new Map<string, Run>()
    for (const r of this.runs.values()) if (r.undone !== true) latest.set(r.agent, r)
    const found = this.conflicts.all()
    for (const r of this.runs.values()) {
      const open = latest.get(r.agent) === r && !r.merged
      const counts = r.stat === undefined ? '' : ` ${formatStat(r.stat)}`
      const verify = open ? this.verifyResults.get(r.agent) : undefined
      const clash = open ? conflictsOf(found, r.agent) : ''
      this.post(
        `${r.id}  ${r.undone === true ? 'undone' : r.state}  ${r.files.length} file(s)${counts}${r.merged ? '  merged' : ''}${verify === undefined ? '' : `  verify: ${verifyWord(verify)}`}${clash === '' ? '' : `  conflicts: ${clash}`}`,
      )
    }
  }

  /** Settings > Agents verify: shows, sets (a command line) or clears (`off`) the check run in each worktree after a turn and before a merge. */
  async setVerify(text: string): Promise<void> {
    const root = await this.rootDir()
    if (root === undefined) return this.toast('error', 'Agents need a git repository. Start pager inside one.')
    const command = text.trim()
    if (command === '') {
      const current = this.verifyStore.get(root)
      return this.post(current === undefined ? 'verify is off: set a command in Settings > Agents to run it in each worktree after a turn and before a merge' : `verify: ${current}`)
    }
    const why = this.verifyStore.set(root, command.toLowerCase() === 'off' ? undefined : command)
    if (why !== undefined) return this.toast('error', `Could not save the verify command: ${why}`)
    this.post(command.toLowerCase() === 'off' ? 'verify is off' : `verify: ${command}`)
    this.emit('change')
  }

  /** `/agent log <run|agent>`: posts the output the last verify run of that agent's branch left, so nobody has to rerun it. */
  showLog(target: string): void {
    const w = this.workers.get(target) ?? this.find(target)?.worker
    if (w === undefined) return this.toast('error', `No agent or run "${target}"`)
    const last = this.verifyResults.get(w.name)
    if (last === undefined) return this.toast('info', `No verify output for ${w.name} yet (set one in Settings > Agents)`)
    const age = Math.max(0, Math.round((Date.now() - last.at) / 1000))
    this.post(`${w.name} ${verifyHeadline(last)} on ${last.sha.slice(0, 7)}, ${age}s ago: ${last.command}${last.truncated ? '\n(earlier output dropped)' : ''}\n${last.output.trimEnd() || '(no output)'}`, [w.name])
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
      removeTree(dir)
    }
  }

  private withAuthHint(cli: string, reason: string): string {
    const hint = Object.hasOwn(PRESETS, cli) ? PRESETS[cli]?.auth : undefined
    return hint !== undefined && hint !== '' && AUTH_HINT.test(reason) ? `${reason} (${hint})` : reason
  }

  /** `Agents: check installs`: re-checks every agent and posts what it found, including a real prompt round trip for one-shot capable agents. */
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
          removeTree(dir)
        }
      }),
    )
  }

  /** Adds a named teammate, checking its CLI first when needed. */
  async addAgent(cli: string, name?: string): Promise<AgentConfig | string> {
    if (!this.registry.isKnownCli(cli)) return `Unknown agent "${cli}". See Settings > Agents`
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

  /**
   * Deletes a teammate: stops its work, removes it from the team and discards its workspace, branch, saved session and run records.
   * A workspace holding changes that were never merged is kept (merge or drop it later), and so is one whose turn would not stop within 5 s.
   * Resolves 'deleted', 'kept', or undefined when there is no such teammate.
   */
  async deleteAgent(name: string): Promise<'deleted' | 'kept' | undefined> {
    const w = this.workers.get(name)
    if (!this.registry.removeInstance(name)) return undefined
    if (w === undefined) {
      this.emit('change')
      return 'deleted'
    }
    this.cancel(new Set([w]))
    for (let i = 0; i < 100 && w.draining; i++) await sleep(50)
    const unmerged = w.files.length > 0 && [...this.runs.values()].some((r) => r.worker === w && !r.merged)
    if (w.draining || unmerged) {
      this.emit('change')
      return 'kept'
    }
    await this.discardWorkspace(w)
    this.emit('change')
    return 'deleted'
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

  setRiskApproval(on: boolean): void {
    this.registry.setRiskApproval(on)
    this.emit('change')
  }

  /** Every stored daily cap as Settings rows: the default for all agents (key `*`) and one per agent that has its own. */
  budgetList(): { key: string; text: string }[] {
    return this.budgets.entries().map(([key, cap]) => ({ key, text: describeCap(cap) }))
  }

  /** Sets (`turns=20 minutes=60`) or lifts (`off`) one cap through the same parser and toasts as `budget`. */
  setBudget(key: string, text: string): void {
    this.budget([key === ALL_KEY ? 'all' : key, ...text.trim().split(/\s+/).filter(Boolean)])
  }

  /** The command run after each turn and before a merge, if one is set (undefined without a repository). */
  async verifyCommand(): Promise<string | undefined> {
    const root = await this.rootDir()
    return root === undefined ? undefined : this.verifyStore.get(root)
  }

  /** Daily budgets: show the daily caps and today's use, or set or lift a cap. `args` follow the word `budget`. */
  budget(args: string[]): void {
    const cmd = parseBudget(args, this.names())
    if (cmd.kind === 'error') return this.toast('error', cmd.message)
    if (cmd.kind === 'set') {
      this.budgets.set(cmd.key, cmd.cap)
      return this.toast('success', `${cmd.key === ALL_KEY ? 'every agent' : cmd.key}: ${describeCap(cmd.cap)} per day`)
    }
    if (cmd.kind === 'off') {
      const had = this.budgets.clear(cmd.key)
      return this.toast(had ? 'success' : 'info', `${cmd.key === ALL_KEY ? 'The default budget' : `${cmd.key}'s budget`} ${had ? 'is lifted' : 'was not set'}`)
    }
    const now = Date.now()
    const records = this.statsLog.read()
    const lines = this.names().map((name) => {
      const cap = this.budgets.get(name)
      const used = usedToday(records, name, now)
      return cap === undefined ? `${name}: no cap (${used.turns} turns today)` : `${name}: ${describeUse(cap, used)} today`
    })
    this.post(`Daily budgets (local day; ${BUDGET_USAGE}):\n${lines.join('\n') || 'no agents yet'}`)
  }

  // ---- notes, commands, usage ----

  /** Shared notes for this repository, fed into every agent prompt. */
  async memory(action: 'show' | 'add' | 'clear', text = ''): Promise<void> {
    const root = await this.rootDir()
    if (root === undefined) return this.toast('error', 'Agents need a git repository. Start pager inside one.')
    if (action === 'add') {
      if (text.trim() === '') return this.toast('error', 'Write the note in Settings > Agents > Add a note to memory')
      this.addMemory(root, 'you', text.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_CHARS))
      return this.toast('success', 'Remembered')
    }
    if (action === 'clear') {
      const why = this.memoryStore.clear(root)
      return why === undefined ? this.post('memory cleared') : this.toast('error', `Could not clear the memory file: ${why}`)
    }
    const notes = this.memoryStore.read(root).trim()
    this.post(notes === '' ? 'memory is empty' : `memory (${notes.split('\n').length} notes):\n${notes}`)
  }

  /** Posts the slash commands an agent advertises over ACP (run them with `/agent <name> /<command>`). */
  async commands(name: string): Promise<void> {
    const cfg = this.registry.instances().find((c) => c.name === name)
    const spec = cfg === undefined ? undefined : this.specFor(cfg.cli)
    if (cfg === undefined || spec === undefined || !this.acpPossible(spec)) {
      return this.toast('error', `${name} has no ACP mode here; try the palette: Agent ${name}: CLI… (--help)`)
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
        removeTree(dir)
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

  private append(author: string, kind: 'text' | 'system', text: string, to?: string[], pk?: string): RoomEntry {
    const entry = this.log.add(author, kind, text, to, true, pk)
    this.emit('change')
    return entry
  }

  /** A pager line in the hub, and in the tabs of the agents it is about. */
  /** A pager note in the room (shown to the user, never sent to an agent). */
  notice(text: string): void {
    this.post(text)
  }

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

  /** Whether pager runs inside a git repository (agents work in worktrees of it). */
  async hasRepo(): Promise<boolean> {
    return (await this.rootDir()) !== undefined
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
        const blocked = this.budgetBlock(w)
        if (blocked !== undefined) {
          this.refuseBatch(w, batch, blocked)
          continue
        }
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

  /** Why `w` may not start a turn now (its daily budget is spent), or undefined. */
  private budgetBlock(w: Worker): string | undefined {
    const cap = this.budgets.get(w.name)
    if (cap === undefined) return undefined
    const c = check(cap, usedToday(this.statsLog.read(), w.name, Date.now()))
    return c.status === 'over' ? refusal(w.name, cap, c) : undefined
  }

  /** A budget refusal drops the queued messages (the senders are told), rather than holding them for tomorrow. */
  private refuseBatch(w: Worker, batch: Inbox[], reason: string): void {
    this.post(reason, [w.name])
    this.toast('warn', reason)
    for (const m of batch) m.done?.({ ...NO_OUTCOME, text: `(${reason})` })
    if (batch.some((m) => m.kind === 'review')) this.reviewEnded(w, reason)
  }

  /** One note per agent per local day once a turn brings it to 80% of a cap. */
  private warnBudget(w: Worker): void {
    const cap = this.budgets.get(w.name)
    if (cap === undefined) return
    const now = Date.now()
    const used = usedToday(this.statsLog.read(), w.name, now)
    const c = check(cap, used)
    if (c.status === 'ok' || !this.budgetNotices.first(w.name, now)) return
    const text = warning(w.name, cap, used, c)
    this.post(text, [w.name])
    this.toast('warn', text)
  }

  /** The post-turn follow ups: automatic peer review and automatic compaction. */
  private afterTurn(w: Worker, batch: Inbox[], outcome: Outcome): void {
    this.warnBudget(w)
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

  private promptMessages(batch: Inbox[], conflict: boolean, undoNote?: string): PromptMessage[] {
    const out: PromptMessage[] = batch.map((m) => ({ from: m.from, kind: m.kind, text: m.text, ...(m.also === undefined || m.also.length === 0 ? {} : { also: m.also }) }))
    if (conflict) out.unshift({ from: 'pager', kind: 'user', text: 'SYNC CONFLICT: your branch could not merge the main branch; resolve it first.' })
    if (undoNote !== undefined) out.unshift({ from: 'pager', kind: 'user', text: undoNote })
    return out
  }

  private boardFor(w: Worker, root: string): string {
    const entries = this.registry.ready().map((c) => {
      const x = this.workers.get(c.name)
      const notes = this.boardState.notes(root, c.name)
      const lines = this.lineStats.get(c.name)
      const verified = x !== undefined && x.files.length > 0 ? this.verifyResults.get(c.name) : undefined
      return {
        name: c.name,
        state: x?.state ?? ('idle' as const),
        task: x?.task ?? notes?.task ?? '',
        purpose: x?.purpose ?? notes?.purpose ?? '',
        files: x?.files ?? [],
        branch: `pager/${c.name}`,
        ...(lines === undefined || x === undefined || x.files.length === 0 ? {} : { lines }),
        ...(verified === undefined ? {} : { verify: verifyWord(verified) }),
      }
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
    run.notesBefore = { task: w.task, purpose: w.purpose }
    const kind = batch.some((m) => m.kind === 'review') ? 'review' : 'normal'
    const verbatim = batch.length === 1 && batch[0]?.text.startsWith('/') === true && batch[0]?.kind === 'user' && batch[0]?.guest !== true
    // Documents are named only by the host: a guest's #name never pulls one into a prompt.
    const userText = batch.filter((m) => m.kind === 'user' && m.guest !== true).map((m) => m.text).join('\n')
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
              .filter((e) => e.kind === 'text' || / (changed \d+ file|verify (passed|failed|timed out))/.test(e.text))
              .map((e) => ({ author: e.author, text: e.text })),
            messages: formatMessages(this.promptMessages(batch, conflict, w.undoNote)),
            tools,
          })
    const allowedThisRun = new Set<string>()
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
            onPermission: (params) => this.permit(w, params, allowedThisRun),
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
      if (!verbatim) w.undoNote = undefined
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
      run.stat = await diffNumstat(w.dir, t.head).catch(() => undefined)
      if (run.stat === undefined) this.lineStats.delete(w.name)
      else this.lineStats.set(w.name, run.stat)
    } catch (err) {
      return t.failed(errMsg(err))
    }
    await this.recordCheckpoint(w, run, t.root, t.startSha, first)
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
      this.post(`${run.id} changed ${turnFiles.length} file(s)${run.stat === undefined ? '' : ` (${formatStat(run.stat)})`}: ${shown}${turnFiles.length > 5 ? ', ...' : ''}`, scope)
    }
    this.announce('info', `${w.name}: ${(text.split('\n', 1)[0] ?? '').slice(0, 80)}`, w.name)
    this.warnOverlap(w, turnFiles)
    if (turnFiles.length > 0) await this.scanConflicts(t.root, false, w)
    this.statsLog.append({ ts: Date.now(), agent: w.name, cli: w.cli, ms: Date.now() - t.started, files: turnFiles.length, stop: t.stopReason })
    const verifyCommand = this.verifyStore.get(t.root)
    if (verifyCommand !== undefined && turnFiles.length > 0 && !this.closing) await this.verifyWorker(w, verifyCommand, run.id, true)
    if (w.turnKind === 'review' && this.reviewing.has(w.name)) this.reviewEnded(w, text)
    this.boardState.setNotes(t.root, w.name, { task: w.task, purpose: w.purpose })
    return { runId: run.id, text, ok: true, files: turnFiles }
  }

  /** Remembers where the agent's branch stood before a turn that changed it, for `/agent undo`. */
  private async recordCheckpoint(w: Worker, run: Run, root: string, startSha: string, ask: string): Promise<void> {
    try {
      if ((await currentSha(w.dir)) === startSha) return
      await this.checkpointsFor(w, root).record({ sha: startSha, run: run.id, ask, task: run.notesBefore?.task ?? '', purpose: run.notesBefore?.purpose ?? '' })
    } catch (err) {
      this.post(`${w.name}: could not save an undo point (${errMsg(err)})`, [w.name])
    }
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

  /** Dry-run merges of every unmerged agent branch into the checkout and into each other. A conflict that is new since the last scan is posted, and toasted unless `quiet` or it does not involve `about`. */
  private async scanConflicts(root: string, quiet: boolean, about?: Worker): Promise<void> {
    const branches = [...this.workers.values()].filter((x) => x.files.length > 0).map((x) => ({ name: x.name, branch: x.branch }))
    for (const c of this.conflicts.update(await predictConflicts(root, branches))) {
      const text = describeConflict(c)
      if (!quiet && (about === undefined || c.a === about.name || c.b === about.name)) this.toast('warn', text)
      this.post(text, c.b === CHECKOUT ? [c.a] : [c.a, c.b])
    }
  }

  /** Runs the repository's verify command in the agent's worktree, posts the outcome and keeps it for the gate, the board and `/agent log`. `stoppable`: `/agent stop` kills it and drops the result. */
  private async verifyWorker(w: Worker, command: string, label: string, stoppable: boolean): Promise<VerifyResult | undefined> {
    const sha = await currentSha(w.dir)
    const run = await runVerify(command, w.dir, { env: this.env, ...(stoppable ? { onSpawn: (c: NonNullable<Worker['child']>) => (w.child = c) } : {}) })
    if (stoppable) w.child = undefined
    if (stoppable && w.stopped) return undefined
    const result: VerifyResult = { ...run, sha, command, at: Date.now() }
    this.verifyResults.set(w.name, result)
    this.post(`${label} ${verifyReport(run)}`, [w.name])
    if (!run.ok) this.toast('warn', `${w.name}: ${verifyHeadline(run)}`)
    this.emit('change')
    return result
  }

  /** Applies the verify gate before a merge (running the command when it has not run on the branch's current commit). Returns why the merge is refused, or undefined. */
  private async verifyGate(w: Worker, root: string, force: boolean): Promise<string | undefined> {
    const command = this.verifyStore.get(root)
    if (command === undefined || force) return undefined
    const head = await currentSha(w.dir)
    let gate = mergeGate({ command, head, last: this.verifyResults.get(w.name), force })
    if (gate.action === 'run') {
      this.toast('info', `Verifying ${w.name} before merging...`)
      const result = await this.verifyWorker(w, command, w.name, false)
      if (result === undefined) return 'verification did not finish'
      gate = mergeGate({ command, head, last: result, force })
    }
    return gate.action === 'block' ? gate.reason : undefined
  }

  private async doMerge(target: string, force: boolean): Promise<void> {
    const w = this.workers.get(target) ?? this.find(target)?.worker
    if (w === undefined) return
    if (w.draining) return this.toast('error', 'The agent is still working')
    const root = await this.rootDir()
    if (root === undefined) return this.toast('error', 'Agents need a git repository. Start pager inside one.')
    if (await isDirty(root)) return this.toast('error', 'Commit or stash your changes first, then merge again.')
    if ((await aheadCount(root, w.branch)) === 0) return this.toast('info', 'Nothing to merge')
    const blocked = await this.verifyGate(w, root, force)
    if (blocked !== undefined) {
      this.toast('error', `Not merged: ${w.name} ${blocked}. /agent log ${w.name} shows the output; /agent merge ${w.name} --force merges anyway.`)
      this.post(`merge of ${w.name} refused: ${blocked}`, [w.name])
      return
    }
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
        this.lineStats.delete(other.name)
        for (const r of this.runs.values()) if (r.worker === other) r.merged = true
      }
    }
    await this.scanConflicts(root, true)
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

  /** An ACP permission request: risky ones (see risk.ts) are put to the user and block the turn until answered; the rest are approved. */
  private async permit(w: Worker, params: Record<string, unknown>, allowedThisRun: Set<string>): Promise<boolean> {
    if (!this.registry.riskApproval) return true
    const call = isRecord(params.toolCall) ? params.toolCall : {}
    const reason = classifyRisk(call, w.dir)
    if (reason === undefined) return true
    const what = describeCall(call)
    if (allowedThisRun.has(reason)) {
      this.post(`${w.name}: allowed ${what} (${reason}; allowed for this run)`, [w.name])
      return true
    }
    const q = riskQuestion(reason, what)
    const answers = await this.questions.ask(w.name, q.message, q.fields)
    const decision = riskDecision(answers)
    if (decision === 'run') allowedThisRun.add(reason)
    const verdict = decision === 'deny' ? (answers === null ? 'denied (no answer)' : 'denied') : decision === 'run' ? 'allowed for this run' : 'allowed once'
    this.post(`${w.name}: ${verdict}: ${what} (${reason})`, [w.name])
    return decision !== 'deny'
  }

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
      webSearch: async (_from, query) => this.opts.web?.search(query) ?? Promise.reject(new Error('Web search is off')),
      webRead: async (_from, url) => this.opts.web?.read(url) ?? Promise.reject(new Error('Web search is off')),
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
