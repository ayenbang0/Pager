import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AcpCommand } from '../run/acp.js'
import { isRecord } from '../../util/guards.js'
import { MEMORY_FILE_MAX_CHARS } from '../run/protocol.js'

export const ROOM_ID = 'agents'
export const ROOM_MAX_MESSAGES = 500
const ZERO_KEY = '0'.repeat(64)

export interface RoomEntry {
  n: number
  ts: number
  author: string
  authorKey: string
  kind: 'text' | 'system'
  text: string
  /** Agents this entry is addressed to or about; it shows in their tabs. Absent on entries written by older versions (hub only). */
  to?: string[]
  /** Who wrote it when it is a guest of a shared session (their public key); absent for the host, pager and agents. */
  pk?: string
}

function isRoomEntry(x: unknown): x is RoomEntry {
  return (
    isRecord(x) &&
    typeof x.n === 'number' &&
    typeof x.ts === 'number' &&
    typeof x.author === 'string' &&
    typeof x.authorKey === 'string' &&
    (x.kind === 'text' || x.kind === 'system') &&
    typeof x.text === 'string' &&
    (x.to === undefined || (Array.isArray(x.to) && x.to.every((t) => typeof t === 'string'))) &&
    (x.pk === undefined || typeof x.pk === 'string')
  )
}

/** Directory-safe id for a repository: readable name plus a hash of its absolute path. */
export function repoKey(root: string): string {
  return `${path.basename(root)}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Key that gives each agent its own author color; the user and pager are neutral. */
export function authorKeyOf(author: string): string {
  if (author === 'you' || author === 'pager') return ZERO_KEY
  return Buffer.from(author).toString('hex').padEnd(64, '0').slice(0, 64)
}

/** The shared room transcript (`agents-room.jsonl`): the hub shows everything, an agent's tab only what concerns it. */
export class RoomLog {
  private readonly entries: RoomEntry[] = []
  private counter = 0
  /** Entries up to here were restored from disk and never count as unread. */
  private baseline = 0
  private readonly readAt = new Map<string, number>()

  constructor(private readonly file: string) {
    this.restore()
  }

  /** Adds an entry and returns it. `persist: false` is for a streaming entry, written once when it settles. */
  add(author: string, kind: 'text' | 'system', text: string, to: string[] | undefined, persist: boolean, pk?: string): RoomEntry {
    const entry: RoomEntry = {
      n: ++this.counter,
      ts: Date.now(),
      author,
      authorKey: pk ?? authorKeyOf(author),
      kind,
      text,
      ...(to === undefined ? {} : { to }),
      ...(pk === undefined ? {} : { pk }),
    }
    this.entries.push(entry)
    if (this.entries.length > ROOM_MAX_MESSAGES) this.entries.shift()
    if (persist) this.persist(entry)
    return entry
  }

  persist(entry: RoomEntry): void {
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`)
    } catch {
      // A read-only data dir must not break the room; the history just won't survive a restart.
    }
  }

  /** Entries the given tab shows: everything in the hub; in an agent tab what that agent said, was told, or what pager reported about it. */
  visible(scope: string): RoomEntry[] {
    if (scope === ROOM_ID) return this.entries
    return this.entries.filter((e) => e.author === scope || e.to?.includes(scope) === true)
  }

  all(): readonly RoomEntry[] {
    return this.entries
  }

  unread(scope: string): number {
    const since = this.readAt.get(scope) ?? this.baseline
    return this.visible(scope).filter((e) => e.n > since && e.author !== 'you').length
  }

  markRead(scope: string): void {
    this.readAt.set(scope, this.counter)
  }

  /** Loads the persisted room: tolerant of corrupt lines, bounded to ROOM_MAX_MESSAGES. */
  private restore(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
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
    this.entries.push(...kept.sort((a, b) => a.n - b.n).slice(-ROOM_MAX_MESSAGES))
    this.counter = this.entries.reduce((max, e) => Math.max(max, e.n), 0)
    this.baseline = this.counter
    if (lines.length > 2 * ROOM_MAX_MESSAGES) {
      const tmp = `${this.file}.tmp`
      try {
        fs.writeFileSync(tmp, this.entries.map((e) => `${JSON.stringify(e)}\n`).join(''))
        fs.renameSync(tmp, this.file)
      } catch {
        // compaction is best effort
      }
    }
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, file)
  } catch {
    // best effort: the data is rebuilt or the agent starts fresh next time
  }
}

function readRecord(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Each agent's own ACP session id per repository (`agent-sessions.json`), so its memory continues between turns. */
export class SessionStore {
  private readonly sessions = new Map<string, Record<string, string>>()

  constructor(private readonly file: string) {
    for (const [key, value] of Object.entries(readRecord(file) ?? {})) {
      if (!isRecord(value)) continue
      const ids: Record<string, string> = {}
      for (const [name, id] of Object.entries(value)) if (typeof id === 'string') ids[name] = id
      this.sessions.set(key, ids)
    }
  }

  get(root: string, agent: string): string | undefined {
    return this.sessions.get(repoKey(root))?.[agent]
  }

  set(root: string, agent: string, sessionId: string): void {
    const key = repoKey(root)
    this.sessions.set(key, { ...this.sessions.get(key), [agent]: sessionId })
    writeJson(this.file, Object.fromEntries(this.sessions))
  }

  clear(root: string, agent: string): void {
    const key = repoKey(root)
    const { [agent]: _gone, ...rest } = this.sessions.get(key) ?? {}
    this.sessions.set(key, rest)
    writeJson(this.file, Object.fromEntries(this.sessions))
  }
}

/** Shared notes for a repository (`memory/<repoKey>.md`), fed into every agent prompt. */
export class Memory {
  constructor(private readonly dataDir: string) {}

  private file(root: string): string {
    return path.join(this.dataDir, 'memory', `${repoKey(root)}.md`)
  }

  read(root: string): string {
    try {
      return fs.readFileSync(this.file(root), 'utf8')
    } catch {
      return ''
    }
  }

  /** Appends one dated note, dropping the oldest lines when the file would exceed MEMORY_FILE_MAX_CHARS. Returns an error text on failure. */
  add(root: string, who: string, note: string): string | undefined {
    const lines = this.read(root).split('\n').filter((l) => l !== '')
    lines.push(`- ${new Date().toISOString().slice(0, 10)} (${who}) ${note}`)
    while (lines.length > 1 && lines.join('\n').length > MEMORY_FILE_MAX_CHARS) lines.shift()
    try {
      fs.mkdirSync(path.dirname(this.file(root)), { recursive: true })
      fs.writeFileSync(this.file(root), `${lines.join('\n')}\n`)
      return undefined
    } catch (err) {
      return errMsg(err)
    }
  }

  clear(root: string): void {
    fs.rmSync(this.file(root), { force: true })
  }
}

export interface WorkerNotes {
  task: string
  purpose: string
}

/** What survives a restart of the team board: the goal and each agent's last stated task (`agents-state.json`). */
export class BoardState {
  private data: Record<string, { goal: string; workers: Record<string, WorkerNotes> }> = {}

  constructor(private readonly file: string) {
    for (const [key, value] of Object.entries(readRecord(file) ?? {})) {
      if (!isRecord(value) || typeof value.goal !== 'string' || !isRecord(value.workers)) continue
      const workers: Record<string, WorkerNotes> = {}
      for (const [name, w] of Object.entries(value.workers)) {
        if (isRecord(w) && typeof w.task === 'string' && typeof w.purpose === 'string') workers[name] = { task: w.task, purpose: w.purpose }
      }
      this.data[key] = { goal: value.goal, workers }
    }
  }

  goal(root: string): string {
    return this.data[repoKey(root)]?.goal ?? ''
  }

  notes(root: string, agent: string): WorkerNotes | undefined {
    return this.data[repoKey(root)]?.workers[agent]
  }

  setGoal(root: string, goal: string): void {
    const key = repoKey(root)
    this.data[key] = { goal, workers: this.data[key]?.workers ?? {} }
    writeJson(this.file, this.data)
  }

  setNotes(root: string, agent: string, notes: WorkerNotes): void {
    const key = repoKey(root)
    const entry = this.data[key] ?? { goal: '', workers: {} }
    entry.workers[agent] = notes
    this.data[key] = entry
    writeJson(this.file, this.data)
  }
}

/** The slash commands each agent CLI advertised over ACP, remembered across restarts (`agents-commands.json`). */
export class CommandStore {
  private readonly byCli = new Map<string, AcpCommand[]>()

  constructor(private readonly file: string) {
    for (const [cli, list] of Object.entries(readRecord(file) ?? {})) {
      if (!Array.isArray(list)) continue
      const commands: AcpCommand[] = []
      for (const c of list) {
        if (!isRecord(c) || typeof c.name !== 'string') continue
        commands.push({ name: c.name, description: typeof c.description === 'string' ? c.description : '', ...(typeof c.hint === 'string' ? { hint: c.hint } : {}) })
      }
      this.byCli.set(cli, commands)
    }
  }

  get(cli: string): AcpCommand[] {
    return this.byCli.get(cli) ?? []
  }

  has(cli: string, name: string): boolean {
    return this.get(cli).some((c) => c.name === name)
  }

  set(cli: string, commands: AcpCommand[]): void {
    this.byCli.set(cli, commands)
    writeJson(this.file, Object.fromEntries(this.byCli))
  }
}
