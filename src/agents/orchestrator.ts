import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { MessageView, Toast, ToastKind } from '../engine.js'
import { ADAPTERS, AGENT_NAMES, findBinary, isAgentName, type AdapterSpec, type AgentName } from './adapters.js'
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
import { killTree, runProcess } from './process.js'
import { buildPrompt, parseAsks, withReplies, type Ask } from './protocol.js'

export const ROOM_ID = 'agents'
export const MAX_CONCURRENT = 3
export const MAX_RUNS_PER_THREAD = 10
export const MAX_ASK_DEPTH = 3
export const RUN_TIMEOUT_MS = 900_000
export const CHECK_TIMEOUT_MS = 120_000
export const ROOM_MAX_MESSAGES = 500

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
}

class CancelledError extends Error {}

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

  constructor(private readonly opts: OrchestratorOptions) {
    super()
    this.adapters = { ...ADAPTERS, ...opts.adapters }
    this.limits = {
      maxConcurrent: opts.limits?.maxConcurrent ?? MAX_CONCURRENT,
      maxRunsPerThread: opts.limits?.maxRunsPerThread ?? MAX_RUNS_PER_THREAD,
      runTimeoutMs: opts.limits?.runTimeoutMs ?? RUN_TIMEOUT_MS,
    }
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
    }))
  }

  markRead(): void {
    this.readN = this.counter
  }

  say(text: string): void {
    this.append('you', 'text', text)
    const m = /^@(\w+)\s+([\s\S]+)$/.exec(text.trim())
    const name = m?.[1]?.toLowerCase()
    if (m?.[2] !== undefined && name !== undefined && isAgentName(name)) void this.ask(name, m[2].trim(), false)
    else this.toast('warn', 'Start with @omp, @claude, @opencode or @hermes')
  }

  ask(agent: AgentName, task: string, log = true): Promise<void> {
    const p = this.startThread(agent, task, log)
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
          if (adapter.extract(res.stdout).includes('PAGER_OK')) {
            this.append('pager', 'system', `${name}: ok (${((Date.now() - started) / 1000).toFixed(1)}s)`)
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
    this.log.push({
      n: ++this.counter,
      ts: Date.now(),
      author,
      authorKey: author === 'you' || author === 'pager' ? ZERO_KEY : Buffer.from(author.split('-', 1)[0] ?? author).toString('hex').padEnd(64, '0').slice(0, 64),
      kind,
      text,
    })
    if (this.log.length > ROOM_MAX_MESSAGES) this.log.shift()
    this.emit('change')
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

  private async startThread(agent: AgentName, task: string, log: boolean): Promise<void> {
    const found = await this.resolveBin(agent)
    if ('error' in found) return this.toast('error', found.error)
    const root = this.root ?? (await repoRoot(this.opts.workdir))
    if (root === undefined) return this.toast('error', 'Agents need a git repository. Start pager inside one.')
    let head: string
    try {
      head = await headSha(root)
    } catch (err) {
      return this.toast('error', errMsg(err))
    }
    this.root = root
    if (await isDirty(root)) {
      this.append('pager', 'system', 'Uncommitted changes in the working tree are not visible to agents (they start from HEAD).')
    }
    if (log) this.append('you', 'text', `@${agent} ${task}`)
    const thread: Thread = { root, tip: head, start: head, runs: 0, cancelled: this.closing }
    this.live.add(thread)
    try {
      await this.runTask(thread, agent, task, 0)
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
      current = withReplies(current, replies)
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
      dir: path.join(
        this.opts.dataDir,
        'worktrees',
        `${path.basename(thread.root)}-${createHash('sha1').update(thread.root).digest('hex').slice(0, 8)}`,
        id,
      ),
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
    const failed = (reason: string): Outcome => {
      run.state = 'failed'
      const text = `(failed: ${reason})`
      this.append(run.id, 'text', text)
      this.toast('error', `${run.id}: ${reason}`)
      return { runId: run.id, text, asks: [] }
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
    const prompt = buildPrompt({
      agent: run.agent,
      branch: run.branch,
      peers,
      room: this.log.filter((e) => e.kind === 'text').map((e) => ({ author: e.author, text: e.text })),
      task,
    })
    const adapter = this.adapters[run.agent]
    let res
    try {
      res = await runProcess(found.bin, adapter.args(prompt, run.dir), {
        cwd: run.dir,
        env: this.env,
        timeoutMs: this.limits.runTimeoutMs,
        onSpawn: (c) => {
          run.child = c
          if (thread.cancelled) killTree(c)
        },
      })
    } catch (err) {
      if (thread.cancelled) return this.cancelled(run)
      return failed(errMsg(err))
    }
    run.child = undefined
    if (thread.cancelled) return this.cancelled(run)
    if (res.timedOut) {
      const s = this.limits.runTimeoutMs / 1000
      return failed(`timed out after ${s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`}`)
    }
    if (res.code !== 0) return failed(`exit ${res.code}: ${res.stderr.trim().slice(-300)}`)

    const { clean, asks } = parseAsks(adapter.extract(res.stdout))
    try {
      await commitAll(run.dir, `agent(${run.agent}): ${(task.split('\n', 1)[0] ?? '').slice(0, 72)}\n\nPager-Run: ${run.id}`)
      run.files = await changedFiles(run.dir, thread.start)
    } catch (err) {
      return failed(errMsg(err))
    }
    thread.tip = run.branch
    run.state = 'done'
    const text = clean === '' ? '(no output)' : clean
    this.append(run.id, 'text', text)
    if (run.files.length > 0) {
      const shown = run.files.slice(0, 5).join(', ')
      this.append('pager', 'system', `${run.id} changed ${run.files.length} file(s): ${shown}${run.files.length > 5 ? ', ...' : ''}`)
    }
    this.toast('info', `${run.id}: ${(text.split('\n', 1)[0] ?? '').slice(0, 80)}`)
    this.warnOverlap(run)
    return { runId: run.id, text, asks }
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
