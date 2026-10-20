import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { CommandBlock } from './blocks.js'
import { writeShellFiles } from './integration.js'
import { PtySession, type PtyOptions } from './pty.js'
import { resolveShell } from './shell.js'

/** The first terminal tab; further tabs are `terminal:2` … `terminal:6`. */
export const TERM_ID = 'terminal'
export const MAX_TERMS = 6

export const termTabId = (n: number): string => (n === 1 ? TERM_ID : `terminal:${n}`)
export const isTermTab = (id: string | null): id is string => id === TERM_ID || (id !== null && /^terminal:[2-6]$/.test(id))

export interface TermInfo {
  shell: string
  cwd: string
  title: string
  exited: number | null
  running: { command: string; since: number } | null
  last: { command: string; exit: number; ms: number } | null
  unavailable: string | null
}

export interface TerminalsOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Pager's data dir; shell integration scripts live in `<dir>/shell`. */
  dir: string
  platform?: NodeJS.Platform
  /** Test seam: replaces the real PTY start. */
  start?: (o: PtyOptions) => Promise<PtySession>
}

/** The terminal tabs: lazily started PTY sessions keyed by tab id. Emits 'change' and 'finished' (id, CommandBlock). */
export class Terminals extends EventEmitter {
  private readonly sessions = new Map<string, PtySession>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, string>()
  private readonly cwds = new Map<string, string>()
  private readonly listed: string[] = [TERM_ID]
  private shutDown = false
  private cols = 80
  private rows = 24

  constructor(private readonly o: TerminalsOptions) {
    super()
  }

  ids(): string[] {
    return [...this.listed]
  }

  has(id: string): boolean {
    return this.listed.includes(id)
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id)
  }

  info(id: string): TermInfo | undefined {
    if (!this.has(id)) return undefined
    const s = this.sessions.get(id)
    const unavailable = this.failures.get(id) ?? null
    if (s === undefined) return { shell: '', cwd: this.cwds.get(id) ?? this.o.cwd, title: '', exited: null, running: null, last: null, unavailable }
    const run = s.blocks.running()
    const done = s.blocks.list().findLast((b) => b.exit !== null)
    return {
      shell: s.shell.label,
      cwd: s.cwd,
      title: s.title,
      exited: s.exit?.code ?? null,
      running: run === undefined ? null : { command: run.command, since: run.startedAt },
      last: done?.exit == null || done.endedAt === null ? null : { command: done.command, exit: done.exit, ms: done.endedAt - done.startedAt },
      unavailable,
    }
  }

  /** Any session has a command running. */
  running(): boolean {
    for (const s of this.sessions.values()) if (s.blocks.running() !== undefined) return true
    return false
  }

  /** Remembers the pane size (new sessions start at it) and applies it to every session. */
  setSize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    for (const s of this.sessions.values()) s.resize(cols, rows)
  }

  /** Starts the session for a tab if it is not running; concurrent calls share one start. A failure is shown by info().unavailable. */
  ensure(id: string): Promise<void> {
    if (this.shutDown || !this.has(id) || this.sessions.has(id)) return Promise.resolve()
    const pending = this.starting.get(id)
    if (pending !== undefined) return pending
    const p = this.spawn(id).finally(() => this.starting.delete(id))
    this.starting.set(id, p)
    return p
  }

  /** Adds the next free tab (cwd: `cwd`, else that of the tab `from`, else the start dir); undefined at MAX_TERMS. */
  open(o: { cwd?: string; from?: string } = {}): string | undefined {
    for (let n = 2; n <= MAX_TERMS; n++) {
      const id = termTabId(n)
      if (this.listed.includes(id)) continue
      this.listed.push(id)
      this.cwds.set(id, o.cwd ?? (o.from === undefined ? undefined : this.sessions.get(o.from)?.cwd) ?? this.o.cwd)
      return id
    }
    return undefined
  }

  /**
   * Types a command into a tab's shell once it is ready: after the first prompt mark for integrated shells (so the
   * command becomes a block), else after a short fixed delay. Waits are overridable for tests.
   */
  async run(id: string, command: string, wait: { integrated?: number; plain?: number } = {}): Promise<void> {
    await this.ensure(id)
    const s = this.sessions.get(id)
    if (s === undefined) return
    if (s.shell.integrated) {
      if (!s.blocks.seen()) {
        const { promise, resolve } = Promise.withResolvers<void>()
        const done = (): void => {
          clearTimeout(timer)
          s.off('change', check)
          resolve()
        }
        const check = (): void => {
          if (s.blocks.seen()) done()
        }
        const timer = setTimeout(done, wait.integrated ?? 8000)
        s.on('change', check)
        await promise
      }
    } else {
      await new Promise<void>((r) => setTimeout(r, wait.plain ?? 900))
    }
    s.write(`${command}\r`)
  }

  async restart(id: string): Promise<void> {
    this.drop(id)
    this.emit('change')
    await this.ensure(id)
  }

  /** Kills a tab's shell. The first tab stays listed (it respawns on next use); others are removed. */
  close(id: string): void {
    this.drop(id)
    if (id !== TERM_ID) {
      const i = this.listed.indexOf(id)
      if (i >= 0) this.listed.splice(i, 1)
      this.cwds.delete(id)
    }
    this.emit('change')
  }

  /** Kills every shell and refuses to start more: a start still in flight kills its shell when it lands. */
  closeAll(): void {
    this.shutDown = true
    for (const id of [...this.sessions.keys()]) this.drop(id)
  }

  private drop(id: string): void {
    this.sessions.get(id)?.kill()
    this.sessions.delete(id)
    this.failures.delete(id)
  }

  private async spawn(id: string): Promise<void> {
    this.failures.delete(id)
    try {
      const dir = path.join(this.o.dir, 'shell')
      writeShellFiles(dir)
      const shell = await resolveShell(this.o.env, this.o.platform ?? process.platform, dir)
      const opts: PtyOptions = { cwd: this.cwds.get(id) ?? this.o.cwd, cols: this.cols, rows: this.rows, shell, env: this.o.env }
      const s = await (this.o.start ?? PtySession.start)(opts)
      if (this.shutDown || !this.has(id)) {
        s.kill()
        return
      }
      this.sessions.set(id, s)
      s.on('change', () => this.emit('change'))
      s.on('finished', (b: CommandBlock) => this.emit('finished', id, b))
    } catch (e) {
      this.failures.set(id, e instanceof Error ? e.message : String(e))
    }
    this.emit('change')
  }
}
