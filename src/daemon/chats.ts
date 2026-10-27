import fs from 'node:fs'
import path from 'node:path'
import type { Engine, EngineOptions, MessageView, Toast } from '../app/engine.js'
import type { Secrets } from '../chat/secrets.js'
import type { LanHandle } from '../net/lan.js'
import { acquireLock, AlreadyRunningError, HANDOFF_SETTLE_MS } from '../platform/lock.js'
import type { DaemonEvent } from './protocol.js'
import { handlers } from './chatsHandlers.js'
import { agentShares } from './chatsShares.js'
import { errText, startFailure } from './chatsFailure.js'
import { SHARE_BLOCKS, type ShareEventKind, type ShareRecord } from '../chat/blockShare.js'

// The chat engine inside the daemon: one Engine per data dir, started lazily, driven by `chats.*` requests and turned into
// `chat_*` events. The wire contract is documented in the task notes (chats-contract) and mirrored by `handlers`.

export type ChatsStatus = 'off' | 'starting' | 'ready' | 'locked' | 'conflict' | 'error'
export type ChatKind = 'dm' | 'group' | 'room' | 'agent' | 'ai' | 'shared'
export type MsgStatus = 'pending' | 'sent' | 'delivered' | 'read' | null
export type ChatToast = { level: Toast['kind']; text: string }

export interface ChatSummary {
  id: string
  kind: ChatKind
  title: string
  peer: string | null
  online: boolean | null
  unread: number
  last?: { ts: number; text: string; mine: boolean; authorName: string; status: MsgStatus }
  call?: number
  thinking?: boolean
  asking?: boolean
  pinned: boolean
  muted: boolean
  archived: boolean
  folder?: string
}

export interface PendingRow {
  n: number
  id: string
  type: 'contact' | 'group' | 'session'
  label: string
  note: string
}

export const CAPS = {
  edit: false,
  delete: false,
  reply: false,
  attachments: false,
  typing: false,
  avatars: false,
  removeMember: false,
  lastSeen: false,
  react: true,
  groups: true,
  calls: true,
  ping: true,
  docs: true,
  search: true,
  pin: true,
  mute: true,
  archive: true,
} as const

export const capsFor = (agentsOn: boolean): Record<string, unknown> => ({
  ...CAPS,
  bots: agentsOn,
  agents: agentsOn,
  ai: agentsOn,
  // What the daemon can carry. How much of a block is live (`live`/`readonly`/`snapshot`) is up to its renderer adapter.
  share: { transport: true, blocks: agentsOn ? [...SHARE_BLOCKS, 'agent'] : [...SHARE_BLOCKS], modes: ['live', 'readonly', 'snapshot'], agent: agentsOn ? 'live' : false },
})

/** An error with a machine-readable code; the reply carries `code: text`. */
export class ChatsError extends Error {
  constructor(
    readonly code: 'not_ready' | 'locked' | 'conflict' | 'unsupported' | 'invalid' | 'rejected' | 'not_found' | 'failed',
    text: string,
  ) {
    super(`${code}: ${text}`)
  }
}

/** The engine pieces a handler uses, plus what the host adds around them. */
export interface Ctx {
  engine: Engine
  dir: string
  agentsOn: boolean
  prefs: ViewPrefs
  /** Runs `fn`, collecting the engine's toasts; an error toast becomes a `rejected` failure. */
  act<T>(fn: () => T | Promise<T>): Promise<{ value: T; toasts: ChatToast[]; messageKey?: string }>
  /** Makes `chatId` the open chat (it marks it read). Unknown ids fail with `not_found`. */
  activate(chatId: string): void
  summaries(): ChatSummary[]
  summary(chatId: string): ChatSummary
  pending(): PendingRow[]
  status(): { status: ChatsStatus; statusText?: string }
  /** `chats.unlock`/`chats.retry` helpers. */
  unlock(passphrase: string): Promise<void>
  retry(): Promise<void>
  /** `chats.yield`: a terminal pager wants the data folder. Resolves true once the engine is closed and the lock released. */
  yield(): Promise<boolean>
  focus(focused: boolean): void
  /** Publishes any pending snapshot before a mutation, so its result is diffed against what clients saw. */
  settle(): void
  /** Something outside the engine changed (a view pref): schedule a `chats_changed`. */
  touch(reason: string): void
}

type Pref = 'pinned' | 'muted' | 'archived'

/** Pin, mute and archive are local view choices of this desktop: kept in `<dir>/chats-view.json`, never sent to peers. */
export class ViewPrefs {
  private readonly sets: Record<Pref, Set<string>> = { pinned: new Set(), muted: new Set(), archived: new Set() }

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const k of Object.keys(this.sets) as Pref[]) {
        const v = raw[k]
        if (Array.isArray(v)) for (const id of v) if (typeof id === 'string' && id.length <= 100) this.sets[k].add(id)
      }
    } catch {
      // none yet, or unreadable: start empty
    }
  }

  has(kind: Pref, id: string): boolean {
    return this.sets[kind].has(id)
  }

  set(kind: Pref, id: string, on: boolean): boolean {
    const s = this.sets[kind]
    if (s.has(id) === on) return false
    if (on) s.add(id)
    else s.delete(id)
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ pinned: [...this.sets.pinned], muted: [...this.sets.muted], archived: [...this.sets.archived] }))
    fs.renameSync(tmp, this.file)
    return true
  }
}

export interface ChatsOptions {
  dir: string
  env: NodeJS.ProcessEnv
  log: (line: string) => void
  /** Sends one event to the clients subscribed to its name. */
  emit: (ev: DaemonEvent) => void
  /** Test seam: replaces `Engine.open`. */
  openEngine?: (opts: EngineOptions) => Promise<Engine>
  /** Extra engine options (a test network's bootstrap nodes, `agents: false`). */
  engineOptions?: Partial<EngineOptions>
  /** Test seam: replaces the lock on `<dir>/pager.lock`. */
  acquire?: (dir: string) => () => void
  /** How often a lock held by another process is looked at again while a window waits for it. Default 1500 ms. */
  retryMs?: number
}

const CHANGE_MS = 50
const AGENT_PREVIEW_MS = 1000
/** How often a lock held by another process is looked at again while a window waits for it. */
const LOCK_RETRY_MS = 1500
/** Requests that must not hold up the others behind them. */
const UNQUEUED = new Set(['chats.caps', 'chats.call.setup'])
const MAX_PREVIEW = 140

const plain = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, MAX_PREVIEW)

export class ChatsHost {
  private status: ChatsStatus = 'off'
  private statusText: string | undefined
  private engine: Engine | undefined
  private release: (() => void) | undefined
  private lan: { stop(): Promise<void> } | undefined
  private starting: Promise<void> | undefined
  private secrets: Secrets | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private captured: ChatToast[] | undefined
  private capturedKey: string | undefined
  private changeTimer: NodeJS.Timeout | undefined
  private prev: { chats: Map<string, string>; pending: string; presence: Map<string, boolean>; rooms: Map<string, string>; call: string; agentShares: Map<string, string> } | undefined
  private agentPreviews = new Map<string, { at: number; last: ChatSummary['last'] | undefined }>()
  /** Pending ids present the moment the engine opened; the first change flush announces only requests that arrived after it. */
  private baseline = new Set<string>()
  /** Agent-session share ids present when the engine opened; the first change flush offers only sessions that arrived after it. */
  private agentBaseline = new Set<string>()
  private closed = false
  readonly prefs: ViewPrefs
  private viewers = 0
  /** After `yield()`: until then the host leaves the lock to the pager that asked, whatever asks it to start (a client disconnecting, a request). */
  private holdOffUntil = 0
  /** Looks at the data folder's lock again while another process holds it. */
  private watcher: NodeJS.Timeout | undefined

  constructor(private readonly o: ChatsOptions) {
    this.prefs = new ViewPrefs(path.join(o.dir, 'chats-view.json'))
  }

  static handles(type: string): boolean {
    return type.startsWith('chats.')
  }

  get ready(): boolean {
    return this.status === 'ready'
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------

  /** Starts the engine unless it runs; never throws: the outcome is `status`. */
  ensure(): Promise<void> {
    if (this.closed || this.status === 'ready' || Date.now() < this.holdOffUntil) return Promise.resolve()
    this.starting ??= this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private setStatus(status: ChatsStatus, text?: string): void {
    const changed = this.status !== status || this.statusText !== text
    this.status = status
    this.statusText = text
    if (status !== 'conflict') this.stopWatching()
    if (changed) this.o.emit({ event: 'chat_status', status, ...(text === undefined ? {} : { statusText: text }) })
  }

  /** Another process holds the data folder's lock. The window shows who, and the host looks again until the lock frees, so quitting that pager is all it takes. */
  private occupied(pid: number): void {
    const who = pid > 0 ? `pid ${pid}` : 'another process'
    const text = `Pager is open in a terminal (${who}) and is using chat on ${this.o.dir}. Chat connects here by itself when you quit it.`
    if (this.statusText !== text) this.o.log(`chats: ${this.o.dir} is in use by ${who}`)
    this.setStatus('conflict', text)
    this.watch()
  }

  private watch(): void {
    if (this.watcher !== undefined || this.closed) return
    this.watcher = setInterval(() => this.recheck(), this.o.retryMs ?? LOCK_RETRY_MS)
    this.watcher.unref()
  }

  private stopWatching(): void {
    clearInterval(this.watcher)
    this.watcher = undefined
  }

  /** Starts again if the lock may be free. Only while a window reads chat: with none, nothing takes the lock back. */
  private recheck(): void {
    if (this.status === 'conflict' && this.viewers > 0) void this.ensure()
  }

  private async start(): Promise<void> {
    const { dir } = this.o
    let release: () => void
    try {
      release = (this.o.acquire ?? acquireLock)(dir)
    } catch (e) {
      if (e instanceof AlreadyRunningError) return this.occupied(e.pid)
      this.o.log(`chats: cannot lock ${dir}: ${errText(e)}`)
      return this.setStatus('error', `Cannot lock the data folder ${dir}: ${errText(e)}`)
    }
    this.setStatus('starting')
    try {
      const secrets = await this.openSecrets()
      if (secrets === 'locked') {
        release()
        return this.setStatus('locked', 'The identity is protected by a passphrase.')
      }
      this.secrets = secrets
      const engine = await this.openEngine(secrets)
      this.release = release
      this.engine = engine
      this.wire(engine)
      this.prev = undefined
      this.setStatus('ready')
      this.o.log(`chats: engine started (${engine.me.name}, ${engine.me.pk.slice(0, 8)})`)
      this.scheduleChange('start')
    } catch (e) {
      release()
      this.o.log(`chats: engine failed to start: ${errText(e)}`)
      this.setStatus('error', startFailure(e))
    }
  }

  /** The keys of a locked identity: from PAGER_PASSPHRASE, or the passphrase `chats.unlock` was given; 'locked' when neither opens it. */
  private async openSecrets(): Promise<Secrets | undefined | 'locked'> {
    // Dynamic: the identity and engine modules load native addons, which the daemon stays free of until chat is used (`pager update` must be able to replace them).
    const { identityLockState, loadOrCreateIdentity, WrongPassphraseError } = await import('../chat/identity.js')
    const state = identityLockState(this.o.dir)
    if (!state.locked) return undefined
    if (this.secrets !== undefined) return this.secrets
    const pass = this.o.env.PAGER_PASSPHRASE
    if (pass === undefined || pass === '') return 'locked'
    const { deriveSecrets } = await import('../chat/secrets.js')
    const secrets = deriveSecrets(pass, state.salt!)
    try {
      loadOrCreateIdentity(this.o.dir, secrets)
      return secrets
    } catch (e) {
      if (e instanceof WrongPassphraseError) return 'locked'
      throw e
    }
  }

  private async openEngine(secrets: Secrets | undefined): Promise<Engine> {
    const { dir, env } = this.o
    const extra = this.o.engineOptions ?? {}
    if (this.o.openEngine !== undefined) return this.o.openEngine({ dir, ...(secrets === undefined ? {} : { secrets }), isMuted: (id) => this.prefs.has('muted', id), ...extra })
    // The same projection the terminal pager makes: the persisted switches become PAGER_* variables before the modules that read them load.
    const { applyEnvFromSettings } = await import('../app/envSettings.js')
    const { loadSettings } = await import('../app/settings.js')
    const envLocks = applyEnvFromSettings(loadSettings(dir), env, { lan: false, noAgents: false })
    const lanOn = env.PAGER_LAN === '1'
    if (lanOn) {
      env.PAGER_NO_WEB = '1'
      env.PAGER_NO_UPDATE_CHECK = '1'
      for (const key of ['web', 'updateCheck'] as const) if (!envLocks.some((l) => l.key === key)) envLocks.push({ key, source: 'PAGER_LAN' })
    }
    const bootstrap = env.PAGER_BOOTSTRAP?.split(',').map((s) => s.trim()).filter(Boolean)
    let lan: LanHandle | undefined
    if (lanOn) {
      const { startLan } = await import('../net/lan.js')
      lan = await startLan({})
    }
    try {
      const { Engine: Eng } = await import('../app/engine.js')
      const agents = env.PAGER_NO_AGENTS !== '1'
      const nodes = lan !== undefined ? lan.bootstrap : bootstrap !== undefined && bootstrap.length > 0 ? bootstrap : undefined
      const engine = await Eng.open({
        dir,
        bootstrap: nodes,
        checkAgents: agents,
        secrets,
        envLocks,
        agents,
        workdir: process.cwd(),
        isMuted: (id) => this.prefs.has('muted', id),
        ...(lan === undefined ? {} : { lan: { hosting: lan.hosting, address: lan.address } }),
        ...extra,
      })
      this.lan = lan
      return engine
    } catch (e) {
      await lan?.stop().catch(() => {})
      throw e
    }
  }

  async unlock(passphrase: string): Promise<void> {
    if (this.status === 'ready') return
    const { identityLockState, loadOrCreateIdentity, WrongPassphraseError } = await import('../chat/identity.js')
    const state = identityLockState(this.o.dir)
    if (!state.locked) return this.retry()
    const { deriveSecrets } = await import('../chat/secrets.js')
    const secrets = deriveSecrets(passphrase, state.salt!)
    try {
      loadOrCreateIdentity(this.o.dir, secrets)
    } catch (e) {
      if (e instanceof WrongPassphraseError) throw new ChatsError('invalid', 'wrong passphrase')
      throw e
    }
    this.secrets = secrets
    await this.retry()
  }

  async retry(): Promise<void> {
    if (this.status === 'ready') return
    await this.starting
    // The in-flight start may have completed while awaited.
    if ((this.status as ChatsStatus) === 'ready') return
    this.status = 'off'
    await this.ensure()
  }

  /** Daemon shutdown: the engine closes (its links, bots, calls) and the data dir lock goes. */
  async close(): Promise<void> {
    this.closed = true
    this.stopWatching()
    clearTimeout(this.changeTimer)
    const engine = this.engine
    this.engine = undefined
    this.status = 'off'
    await this.starting?.catch(() => {})
    const late = this.engine as Engine | undefined
    for (const e of [engine, late]) await e?.close().catch((err: unknown) => this.o.log(`chats: engine close: ${errText(err)}`))
    await this.lan?.stop().catch(() => {})
    this.release?.()
    this.release = undefined
  }

  /**
   * A terminal pager wants the data folder: the engine closes and the lock goes before this resolves, so the caller can take the lock at once.
   * The host then waits like any other conflict and reconnects when the terminal pager quits. False when this host holds no lock.
   */
  async yield(): Promise<boolean> {
    await this.starting
    const engine = this.engine
    if (engine === undefined || this.closed) return false
    this.holdOffUntil = Number.POSITIVE_INFINITY // the lock is still ours while the engine closes; asking for it now would find ourselves
    this.engine = undefined
    this.prev = undefined
    clearTimeout(this.changeTimer)
    this.setStatus('conflict', `A terminal pager took over chat on ${this.o.dir}. Chat connects here by itself when you quit it.`)
    await engine.close().catch((err: unknown) => this.o.log(`chats: engine close: ${errText(err)}`))
    await this.lan?.stop().catch(() => {})
    this.lan = undefined
    this.release?.()
    this.release = undefined
    this.holdOffUntil = Date.now() + HANDOFF_SETTLE_MS
    this.o.log(`chats: ${this.o.dir} handed to a terminal pager`)
    this.watch()
    return true
  }

  // ---- viewers -----------------------------------------------------------------------------------------------------

  /** How many connected clients listen to chat events. Without one nobody reads, so no chat counts as open and read receipts stop. */
  setViewers(n: number): void {
    this.viewers = n
    if (n > 0) this.recheck()
    if (n === 0 && this.engine !== undefined) {
      this.engine.setFocused(false, true)
      this.engine.activate(null)
    }
  }

  // ---- engine events -----------------------------------------------------------------------------------------------

  private wire(engine: Engine): void {
    engine.setFocused(false, true)
    this.baseline = new Set(this.pendingIds(engine))
    this.agentBaseline = new Set(agentShares(engine).map((s) => s.shareId))
    const guard =
      <A extends unknown[]>(fn: (...a: A) => void) =>
      (...a: A): void => {
        try {
          fn(...a)
        } catch (e) {
          this.o.log(`chats: event handler: ${errText(e)}`)
        }
      }
    engine.on('change', guard(() => this.scheduleChange('change')))
    engine.on(
      'toast',
      guard((t: Toast) => {
        this.captured?.push({ level: t.kind, text: t.text })
        this.o.emit({ event: 'chat_toast', level: t.kind, text: t.text })
      }),
    )
    engine.on(
      'message',
      guard((m: { conv: string; key: string; mine: boolean }) => {
        if (this.captured !== undefined && m.mine) {
          this.capturedKey = m.key
        }
        // After the engine finished updating its own state (read marks, status).
        setImmediate(guard(() => this.announceMessage(m)))
      }),
    )
    engine.on(
      'call',
      guard((c: { conv: string; room: string; pk: string; who: string; started: boolean }) => {
        const e = this.engine
        if (e === undefined) return
        this.o.emit({ event: 'chat_call', chatId: c.conv, kind: 'ring', call: e.myCall() ?? null, rooms: e.callRooms(c.conv), from: c.who })
      }),
    )
    const bs = engine.blockShares
    bs.on(
      'event',
      guard((m: { kind: ShareEventKind; record: ShareRecord }) => this.o.emit({ event: 'chat_share', chatId: m.record.conv, kind: m.kind, share: bs.view(m.record) })),
    )
    const relayed =
      (type: 'snapshot' | 'op' | 'presence') =>
      (m: { id: string; from: string; d: string; ver?: number }): void =>
        this.o.emit({ event: 'chat_share_op', shareId: m.id, type, from: m.from, fromName: engine.me.pk === m.from ? engine.me.name : (engine.convs().find((c) => c.peer === m.from)?.title ?? m.from.slice(0, 8)), ...(m.ver === undefined ? {} : { ver: m.ver }), op: m.d })
    bs.on('snapshot', guard(relayed('snapshot')))
    bs.on('op', guard(relayed('op')))
    bs.on('presence', guard(relayed('presence')))
    bs.on(
      'joinRequest',
      guard((m: { id: string; pk: string }) => this.o.emit({ event: 'chat_share_op', shareId: m.id, type: 'join_request', from: m.pk, fromName: engine.convs().find((c) => c.peer === m.pk)?.title ?? m.pk.slice(0, 8), op: '' })),
    )
    engine.on('quit', guard(() => this.o.log('chats: the engine asked to quit (/quit); the daemon keeps running')))
  }

  private announceMessage(m: { conv: string; key: string; mine: boolean }): void {
    const e = this.engine
    if (e === undefined) return
    const found = e.messages(m.conv, 20).find((x) => x.key === m.key)
    if (found === undefined) return
    this.o.emit({ event: 'chat_message', chatId: m.conv, message: found, mine: m.mine })
  }

  private settleChange(): void {
    if (this.changeTimer === undefined || this.closed) return
    clearTimeout(this.changeTimer)
    this.changeTimer = undefined
    try {
      this.flushChange('action')
    } catch (e) {
      this.o.log(`chats: change: ${errText(e)}`)
    }
  }

  scheduleChange(reason: string): void {
    if (this.changeTimer !== undefined || this.closed) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      try {
        this.flushChange(reason)
      } catch (e) {
        this.o.log(`chats: change: ${errText(e)}`)
      }
    }, CHANGE_MS)
    this.changeTimer.unref()
  }

  private flushChange(reason: string): void {
    const e = this.engine
    if (e === undefined) return
    const chats = this.buildSummaries()
    const pending = this.pendingRows()
    const rooms = new Map<string, string>()
    for (const c of e.convs()) if (c.call !== undefined || this.prev?.rooms.has(c.id) === true) rooms.set(c.id, JSON.stringify(e.callRooms(c.id)))
    const call = JSON.stringify(e.myCall() ?? null)
    const presence = new Map(chats.filter((c) => c.kind === 'dm').map((c) => [c.id, c.online === true]))
    const prev = this.prev
    const agentNow = new Map(agentShares(e).map((s) => [s.shareId, JSON.stringify(s)]))
    const now = { chats: new Map(chats.map((c) => [c.id, JSON.stringify(c)])), pending: JSON.stringify(pending), presence, rooms, call, agentShares: agentNow }
    this.prev = now
    if (prev === undefined) {
      this.o.emit({ event: 'chats_changed', ids: null, chats, removed: [], pending, ...this.net(), reason })
      // A request that landed inside the first coalesce window is carried by the summary above, but the window still needs the
      // arrival event: everything not present when the engine opened counts as new.
      const fresh = pending.filter((p) => !this.baseline.has(p.id))
      if (fresh.length > 0) this.o.emit({ event: 'chat_request', pending, ...(fresh[0] === undefined ? {} : { added: fresh[0] }) })
      for (const s of agentShares(e)) {
        if (this.agentBaseline.has(s.shareId)) continue
        this.o.emit({ event: 'chat_share', chatId: s.chatId, kind: 'offered', share: s })
      }
      return
    }
    const ids = [...now.chats].filter(([id, json]) => prev.chats.get(id) !== json).map(([id]) => id)
    const removed = [...prev.chats.keys()].filter((id) => !now.chats.has(id))
    const pendingChanged = prev.pending !== now.pending
    if (ids.length > 0 || removed.length > 0 || pendingChanged) {
      const byId = new Map(chats.map((c) => [c.id, c]))
      this.o.emit({ event: 'chats_changed', ids, chats: ids.flatMap((id) => byId.get(id) ?? []), removed, ...(pendingChanged ? { pending } : {}), ...this.net(), reason })
    }
    for (const [id, on] of presence) {
      if (prev.presence.has(id) && prev.presence.get(id) !== on) this.o.emit({ event: 'chat_presence', pk: chats.find((c) => c.id === id)?.peer ?? null, chatId: id, online: on })
    }
    if (pendingChanged) {
      const known = new Set((JSON.parse(prev.pending) as PendingRow[]).map((p) => p.id))
      const added = pending.find((p) => !known.has(p.id))
      this.o.emit({ event: 'chat_request', pending, ...(added === undefined ? {} : { added }) })
    }
    const touched = new Set<string>()
    for (const id of new Set([...rooms.keys(), ...prev.rooms.keys()])) if (rooms.get(id) !== prev.rooms.get(id)) touched.add(id)
    if (prev.call !== call) {
      for (const j of [prev.call, call]) {
        const conv = (JSON.parse(j) as { conv?: string } | null)?.conv
        if (conv !== undefined) touched.add(conv)
      }
    }
    for (const id of touched) this.o.emit({ event: 'chat_call', chatId: id, kind: 'state', call: e.myCall() ?? null, rooms: e.callRooms(id) })
    for (const [id, json] of agentNow) {
      if (prev.agentShares.get(id) === json) continue
      const share = JSON.parse(json) as { chatId: string }
      this.o.emit({ event: 'chat_share', chatId: share.chatId, kind: prev.agentShares.has(id) ? 'presence' : 'offered', share })
    }
    for (const [id, json] of prev.agentShares) {
      if (agentNow.has(id)) continue
      const share = { ...(JSON.parse(json) as { chatId: string; members: { active: boolean }[] }), state: 'ended' as const }
      this.o.emit({ event: 'chat_share', chatId: share.chatId, kind: 'ended', share: { ...share, joined: false, members: share.members.map((m) => ({ ...m, active: false })) } })
    }
  }

  private net(): { online: boolean; onlineCount: number } {
    const e = this.engine
    return { online: e?.listening() ?? false, onlineCount: e?.onlineCount() ?? 0 }
  }

  // ---- queries -----------------------------------------------------------------------------------------------------

  private lastOf(id: string, e: Engine): ChatSummary['last'] | undefined {
    const recent = e.messages(id, 4)
    const m: MessageView | undefined = [...recent].reverse().find((x) => x.kind === 'text') ?? recent.at(-1)
    return m === undefined ? undefined : { ts: m.ts, text: plain(m.text), mine: m.mine, authorName: m.authorName, status: m.status }
  }

  /** An agent tab's preview is read from files: at most once a second per tab however fast the agents stream. */
  private agentLast(id: string, e: Engine): ChatSummary['last'] | undefined {
    const now = Date.now()
    const hit = this.agentPreviews.get(id)
    if (hit !== undefined && now - hit.at < AGENT_PREVIEW_MS) return hit.last
    let last: ChatSummary['last'] | undefined
    try {
      last = this.lastOf(id, e)
    } catch {
      last = undefined
    }
    this.agentPreviews.set(id, { at: now, last })
    return last
  }

  private decorate(s: Omit<ChatSummary, 'pinned' | 'muted' | 'archived' | 'folder'>, e: Engine): ChatSummary {
    const folder = e.settings().folders.find((f) => f.ids.includes(s.id))?.name
    return { ...s, pinned: this.prefs.has('pinned', s.id), muted: this.prefs.has('muted', s.id), archived: this.prefs.has('archived', s.id), ...(folder === undefined ? {} : { folder }) }
  }

  buildSummaries(): ChatSummary[] {
    const e = this.engine
    if (e === undefined) return []
    const out: ChatSummary[] = []
    for (const c of e.convs()) {
      const last = this.lastOf(c.id, e)
      out.push(
        this.decorate(
          {
            id: c.id,
            kind: c.kind,
            title: c.title,
            peer: c.peer,
            online: c.online,
            unread: c.unread,
            ...(last === undefined ? {} : { last }),
            ...(c.call === undefined ? {} : { call: c.call }),
            ...(c.thinking === true ? { thinking: true } : {}),
          },
          e,
        ),
      )
    }
    if (e.agentsEnabled()) {
      const room = e.agentRoom()
      const pack = (id: string, kind: ChatKind, title: string, extra: Partial<ChatSummary>): void => {
        const last = this.agentLast(id, e)
        out.push(this.decorate({ id, kind, title, peer: null, online: null, unread: 0, ...(last === undefined ? {} : { last }), ...extra }, e))
      }
      pack('agents', 'room', 'Agents', {
        unread: room.unread,
        ...(room.runs.some((r) => r.state === 'running' || r.state === 'queued') || room.agents.some((a) => a.state === 'working') ? { thinking: true } : {}),
        ...(room.agents.some((a) => a.state === 'asking') ? { asking: true } : {}),
      })
      for (const a of room.agents) {
        pack(`agent:${a.name}`, 'agent', a.name, { unread: a.unread, ...(a.state === 'working' || a.state === 'reviewing' ? { thinking: true } : {}), ...(a.state === 'asking' ? { asking: true } : {}) })
      }
      pack('ai', 'ai', 'AI', e.aiBusy() ? { thinking: true } : {})
      for (const s of e.sharedSessions()) pack(`shared:${s.pk}`, 'shared', s.name, { unread: s.unread, online: s.connected, ...(s.asking ? { asking: true } : {}) })
    }
    return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.last?.ts ?? 0) - (a.last?.ts ?? 0) || a.title.localeCompare(b.title))
  }

  /** Pending rows with stable ids, exactly the ids `chats.requests` answers with. */
  pendingRows(): PendingRow[] {
    const e = this.engine
    if (e === undefined) return []
    const ids = this.pendingIds(e)
    return e.pending().map((p, i) => ({ n: p.n, id: ids[i] as string, type: p.type, label: p.label, note: p.note }))
  }

  private pendingIds(e: Engine): string[] {
    const keys = e.pendingKeys()
    return e.pending().map((p, i) => keys[i]?.id ?? `n:${p.n}`)
  }

  // ---- requests ----------------------------------------------------------------------------------------------------

  /** Runs `fn` after every earlier request: engine commands act on the open chat, so two must never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private knownChat(id: string, e: Engine): boolean {
    if (/^(dm|grp):[0-9a-f]{32}$/.test(id)) return e.convs().some((c) => c.id === id)
    if (!e.agentsEnabled()) return false
    if (id === 'agents' || id === 'ai') return true
    if (id.startsWith('agent:')) return e.agentRoom().agents.some((a) => `agent:${a.name}` === id)
    if (id.startsWith('shared:')) return e.sharedSessions().some((s) => `shared:${s.pk}` === id)
    return false
  }

  /** One `chats.*` request. Resolves to the reply's result; rejects with a `ChatsError` message (`code: text`). */
  handle(type: string, args: Record<string, unknown>): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      const h = handlers[type]
      if (h === undefined) throw new ChatsError('invalid', `unknown request: ${type}`)
      if (h.needsEngine === false) return h.run(this.ctx, args)
      await this.ensure()
      if (this.engine === undefined || this.status !== 'ready') {
        if (h.allowNotReady === true) return h.run(this.ctx, args)
        const code = this.status === 'locked' ? 'locked' : this.status === 'conflict' ? 'conflict' : 'not_ready'
        throw new ChatsError(code, this.statusText ?? `chat is ${this.status}`)
      }
      return h.run(this.ctx, args)
    }
    return UNQUEUED.has(type) ? run() : this.exclusive(run)
  }

  private ctxCache: Ctx | undefined

  /** The handlers' view of this host. It reads live, so an engine that starts during a request (`chats.unlock`, `chats.retry`) is seen by the rest of it. */
  private get ctx(): Ctx {
    this.ctxCache ??= this.makeCtx()
    return this.ctxCache
  }

  private makeCtx(): Ctx {
    const host = this
    const need = (): Engine => {
      if (host.engine === undefined) throw new ChatsError('not_ready', host.statusText ?? `chat is ${host.status}`)
      return host.engine
    }
    return {
      get engine(): Engine {
        return need()
      },
      dir: this.o.dir,
      get agentsOn(): boolean {
        return host.engine?.agentsEnabled() ?? host.agentsSetting()
      },
      prefs: this.prefs,
      act: async (fn) => {
        const toasts: ChatToast[] = []
        host.captured = toasts
        host.capturedKey = undefined
        try {
          const value = await fn()
          const bad = toasts.find((t) => t.level === 'error')
          if (bad !== undefined) throw new ChatsError('rejected', bad.text)
          return { value, toasts, ...(host.capturedKey === undefined ? {} : { messageKey: host.capturedKey }) }
        } finally {
          host.captured = undefined
        }
      },
      activate: (chatId) => {
        const e = need()
        if (!host.knownChat(chatId, e)) throw new ChatsError('not_found', `no such chat: ${chatId}`)
        e.activate(chatId)
        if (e.active() !== chatId) throw new ChatsError('not_found', `cannot open ${chatId}`)
      },
      summaries: () => host.buildSummaries(),
      summary: (chatId) => {
        const s = host.buildSummaries().find((c) => c.id === chatId)
        if (s === undefined) throw new ChatsError('not_found', `no such chat: ${chatId}`)
        return s
      },
      pending: () => host.pendingRows(),
      status: () => ({ status: host.status, ...(host.statusText === undefined ? {} : { statusText: host.statusText }) }),
      unlock: (p) => host.unlock(p),
      retry: () => host.retry(),
      yield: () => host.yield(),
      focus: (focused) => host.engine?.setFocused(focused, true),
      settle: () => host.settleChange(),
      touch: (reason) => host.scheduleChange(reason),
    }
  }

  /** Whether agents will be on, before the engine says: the persisted switch and the environment (what the engine reads at start). */
  private agentsSetting(): boolean {
    if (this.o.env.PAGER_NO_AGENTS === '1') return false
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.o.dir, 'settings.json'), 'utf8')) as { agents?: unknown }
      return raw.agents !== false
    } catch {
      return true
    }
  }

  get viewerCount(): number {
    return this.viewers
  }
}
