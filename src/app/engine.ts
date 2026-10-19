import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { BootstrapNode } from 'hyperdht'
import type { AdapterSpec } from '../agents/run/adapters.js'
import { PRESETS } from '../agents/run/catalog.js'
import { agentTabId, parseAgentTab, parseSharedTab, sharedTabId } from '../agents/ids.js'
import { AgentShare, type GuestView, type SharedRoom, type SharedView } from '../agents/share/share.js'
import { Orchestrator, ROOM_ID, type AgentStats, type RoomView, type SetupRow } from '../agents/orchestrator.js'
import type { AnswerMap, QuestionView } from '../agents/run/questions.js'
import { COMMANDS, parseCommand } from './commands.js'
import { formatChangelog, getChangesSince, isNewer as isNewerChangelog, latestVersion as latestChangelogVersion, loadChangelog } from './changelog.js'
import { Terminal, TERM_ID, type TermEntry, type TermState } from '../tools/terminal/terminal.js'
import { DocStore, DOCS_ID, DOC_PREFIX, type DocInfo } from '../docs/store.js'
import { ContactCodeError, decodeContactCode, encodeContactCode } from '../chat/contactCode.js'
import { Store, type Conv } from '../chat/db.js'
import { COLOR_WORDS, parseColor } from '../ui/theme/colors.js'
import { expandEmoji } from '../chat/emoji.js'
import { dmConvId, newGroupId, signEvent, type EventKind, type PagerEvent } from '../chat/events.js'
import { loadOrCreateIdentity, saveName } from '../chat/identity.js'
import type { Secrets } from '../chat/secrets.js'
import { checkEvent, MAX_GROUP_MEMBERS } from '../chat/ingest.js'
import { LOCAL_CAPS, Net, type PeerLink } from '../net/net.js'
import { NetLog } from '../net/netlog.js'
import { HISTORY_MAX, loadHistory, saveHistory } from './history.js'
import { Suggester } from './suggest.js'
import { buildRecap } from './recap.js'
import { formatSearch, readRoomLines, searchDocs, SEARCH_SCAN_LIMIT, type SearchDoc } from './search.js'
import { DENSITIES, isDensity, loadLastSeen, loadSettings, parseBadge, saveLastSeen, saveSettings, type Settings } from './settings.js'
import { findTheme, THEMES } from '../ui/theme/themes.js'
import { isNewer, latestVersion } from './update.js'
import { VERSION } from './version.js'
import { parseChain, splitArgs } from '../agents/run/protocol.js'
import { closeDesktop, desktopNotify, warmDesktop } from '../platform/desktop.js'
import type { Frame } from '../net/wire.js'

export type ToastKind = 'info' | 'success' | 'warn' | 'error'
export interface Toast {
  kind: ToastKind
  text: string
}
export interface ConvView {
  id: string
  kind: 'dm' | 'group'
  title: string
  /** DM peer public key (hex); null for groups. */
  peer: string | null
  /** DM only. */
  online: boolean | null
  unread: number
}
/** Numbers behind the home screen. `week` holds text messages per day, oldest first, today last. */
export interface HomeStats {
  contacts: number
  online: number
  groups: number
  pending: number
  unread: number
  sent: number
  received: number
  week: number[]
  busiest: { title: string; count: number } | null
  agentRuns: number
  agentsRunning: number
  mergeable: number
}
export interface PendingView {
  n: number
  type: 'contact' | 'group' | 'session'
  label: string
  note: string
}
export interface MessageView {
  key: string
  ts: number
  authorName: string
  authorKey: string
  mine: boolean
  /** An agent teammate wrote it (its color may be personal). */
  agent?: boolean
  kind: 'text' | 'system'
  text: string
  /** Render Markdown (agent replies only; peer text stays literal). */
  markdown?: boolean
  status: 'pending' | 'sent' | 'delivered' | 'read' | null
}
export interface EngineOptions {
  dir: string
  bootstrap?: BootstrapNode[]
  dhtOptions?: Record<string, unknown>
  backoff?: { baseMs: number; maxMs: number }
  /** Directory agents work against; must be inside a git repository. Defaults to the current directory. */
  workdir?: string
  /** Test seam: replaces the real agent CLIs. */
  agentAdapters?: Record<string, AdapterSpec>
  /** Probe the installed agent CLIs in the background at startup (the app turns this on; tests call checkAgents themselves). */
  checkAgents?: boolean
  /** Keys derived from the passphrase when identity.json is locked. */
  secrets?: Secrets
}

interface PendingItem {
  view: PendingView
  pk?: string
  session?: string
  conv?: string
}

type WireEvent = Extract<Frame, { t: 'events' }>['events'][number]

const MAX_TEXT = 4000
const MAX_NAME = 64
const MAX_NOTE = 200
const MAX_INCOMING = 20
const MAX_UNKNOWN_LINKS = 20
const UNKNOWN_LINK_TTL_MS = 30_000
/** How often the last-seen stamp is refreshed while pager is open. */
const LAST_SEEN_MS = 60_000
const EVENTS_PER_FRAME = 100
/** How many of the user's own sent messages seed the autocomplete at startup. */
const SUGGEST_CORPUS = 2000
/** A terminal command that ran this long rings an unfocused terminal when it ends. */
const LONG_COMMAND_MS = 5000
const EVENTS_BYTES_PER_FRAME = 200_000
/** Home asks for the agent stats on every render; the log is only re-read after this long. */
const AGENT_STATS_TTL_MS = 2000

const hasControl = (s: string): boolean => /\p{Cc}/u.test(s)
const pk8 = (pk: string): string => pk.slice(0, 8)

/** Events: 'change' (), 'toast' (Toast), 'quit' (). */
export class Engine extends EventEmitter {
  readonly me: { pk: string; code: string; name: string }

  private readonly dir: string
  /** True when the identity and database are protected by a passphrase. */
  readonly locked: boolean
  private readonly secretKey: Buffer
  private readonly store: Store
  private readonly net: Net
  private readonly netLog: NetLog
  private readonly agents: Orchestrator
  private readonly share: AgentShare
  private readonly term: Terminal
  readonly docs: DocStore
  private openDocId: string | null = null
  private statsCache: { at: number; value: AgentStats } | undefined
  private readonly unknownTimers = new Set<NodeJS.Timeout>()
  /** Stamps `last-seen.json` every LAST_SEEN_MS while open, for the "since you left" recap. */
  private seenTimer: NodeJS.Timeout | undefined
  private activeId: string | null = null
  /** Text set by /help and /code; null shows the welcome banner. */
  private homeLines: string[] | null = null
  private closed = false
  private update: string | null = null
  private prefs: Settings
  /** Whether the terminal window has focus (read receipts wait until you can actually see the chat). */
  private focused = true
  /** Whether focus reports can be believed (a terminal that never reports would otherwise look focused forever and lose every alert). */
  private focusTrusted = false
  /** `conv:pk` to the highest of my message seqs written to that peer's open link (not necessarily acknowledged). */
  private readonly sentTo = new Map<string, number>()
  /** Peers with an open link, to tell the first connection from a reconnect. */
  private readonly online = new Set<string>()
  /** `conv:pk` to the highest of my message seqs that peer has told me they read. */
  private readonly readBy = new Map<string, number>()
  /** `conv:pk` to the highest seq of theirs I have told them I read. */
  private readonly readSent = new Map<string, number>()
  private input: string[]
  private readonly suggester = new Suggester()

  static async open(opts: EngineOptions): Promise<Engine> {
    const engine = new Engine(opts)
    engine.net.start()
    if (opts.checkAgents === true) void engine.checkAgents()
    return engine
  }

  private constructor(opts: EngineOptions) {
    super()
    this.dir = opts.dir
    this.locked = opts.secrets !== undefined
    this.prefs = loadSettings(opts.dir)
    this.input = loadHistory(opts.dir)
    const identity = loadOrCreateIdentity(opts.dir, opts.secrets)
    this.secretKey = identity.keyPair.secretKey
    this.store = new Store(path.join(opts.dir, 'pager.db'), opts.secrets?.dbKey)
    this.me = { pk: identity.pk, code: encodeContactCode(identity.keyPair.publicKey), name: identity.name }
    this.docs = new DocStore(identity.pk, (conv, body) => this.publishDoc(conv, body))
    for (const ev of this.store.docEvents()) this.docs.applyEvent(ev)
    this.docs.on('change', () => this.emit('change'))
    for (const sent of this.store.sentTexts(this.me.pk, SUGGEST_CORPUS)) this.suggester.learn(sent)
    for (const h of this.input) if (h.startsWith('/')) this.suggester.learn(h)
    this.netLog = new NetLog(path.join(opts.dir, 'net.log'))
    this.net = new Net({
      keyPair: identity.keyPair,
      bootstrap: opts.bootstrap,
      dhtOptions: opts.dhtOptions,
      backoff: opts.backoff,
      getName: () => this.me.name,
      isBlocked: (pk) => this.store.getPeer(pk)?.state === 'blocked',
      wanted: () => this.wantedSet(),
      log: this.netLog.line,
    })
    this.net.on('listening', () => this.emit('change'))
    this.net.on('open', (link: PeerLink) => this.onOpen(link))
    this.net.on('hello', (link: PeerLink) => {
      this.learnName(link)
      this.emit('change')
    })
    this.net.on('frame', (link: PeerLink, frame: Frame) => this.onFrame(link, frame))
    this.net.on('close', (pk: string) => {
      this.share.onClose(pk)
      this.online.delete(pk)
      for (const key of this.sentTo.keys()) if (key.endsWith(`:${pk}`)) this.sentTo.delete(key)
      this.emit('change')
    })
    this.agents = new Orchestrator({
      dataDir: opts.dir,
      workdir: opts.workdir ?? process.cwd(),
      adapters: opts.agentAdapters,
      docs: {
        list: (task) => this.docsNamedIn(task),
        write: (name, text, append, base) => this.agentDocWrite(name, text, append, base),
      },
    })
    this.agents.on('change', () => {
      const scope = parseAgentTab(this.activeId) ?? (this.activeId === ROOM_ID ? ROOM_ID : undefined)
      if (scope !== undefined) this.agents.markRead(scope)
      this.emit('change')
    })
    this.share = new AgentShare({
      me: this.me,
      dir: opts.dir,
      link: (pk) => this.net.link(pk),
      isContact: (pk) => this.store.getPeer(pk)?.state === 'accepted',
      nameOf: (pk) => this.nameOf(pk),
      orch: this.agents,
      isActive: (pk) => this.activeId === sharedTabId(pk),
      acceptNumber: (pk) => this.pendingItems().find((i) => i.session === pk)?.view.n ?? 1,
      announce: (kind, text, title) => this.announce(kind, text, title),
      toast: (kind, text) => this.toast(kind, text),
      changed: () => {
        const open = parseSharedTab(this.activeId)
        if (open !== undefined && this.share.room(open) === undefined) this.activeId = ROOM_ID
        this.emit('change')
      },
    })
    this.agents.on('notify', (title: string, body: string) => this.alert(title, body))
    this.agents.on('toast', (t: Toast) => this.emit('toast', t))
    this.term = new Terminal(opts.workdir ?? process.cwd())
    this.term.on('change', () => this.emit('change'))
    this.term.on('finished', (e: TermEntry) => {
      if (Date.now() - e.ts >= LONG_COMMAND_MS) this.alert('terminal', `${e.command.slice(0, 60)} ${e.state === 'done' ? 'finished' : e.state}`)
    })
    if (this.prefs.notify) warmDesktop()
    this.showNewRelease()
    this.startRecap()
  }

  /** Shows what happened since pager was last open (appended to the changelog if that is up), then keeps the last-seen stamp fresh. */
  private startRecap(): void {
    const now = Date.now()
    const lastSeen = loadLastSeen(this.dir)
    if (lastSeen !== undefined) {
      const labels = this.convLabels()
      const chats = [...this.store.textCountsSince(this.me.pk, lastSeen)].flatMap(([id, count]) => {
        const title = labels.get(id)
        return title === undefined ? [] : [{ title, count }]
      })
      const line = buildRecap({ now, lastSeen, chats, room: readRoomLines(this.roomFile()) })
      if (line !== undefined) this.homeLines = this.homeLines === null ? [line] : [...this.homeLines, '', line]
    }
    saveLastSeen(this.dir, now)
    this.seenTimer = setInterval(() => saveLastSeen(this.dir, Date.now()), LAST_SEEN_MS)
    this.seenTimer.unref()
  }

  private roomFile(): string {
    return path.join(this.dir, 'agents-room.jsonl')
  }

  /** Conversation id to the name search and the recap show: `alice` for a contact, `#team` for a group. */
  private convLabels(): Map<string, string> {
    return new Map(this.convs().map((c) => [c.id, c.kind === 'group' ? `#${c.title}` : c.title]))
  }

  /** `/search`: the newest matches in chat history and the agent room, shown as a text block. */
  private cmdSearch(query: string): void {
    const q = query.trim()
    if (q === '') return this.toast('error', 'Usage: /search <text>  (case-insensitive; chat history and the agent room, newest 20 matches)')
    const labels = this.convLabels()
    const docs: SearchDoc[] = []
    for (const e of this.store.recentTexts(SEARCH_SCAN_LIMIT)) {
      const where = labels.get(e.conv)
      if (where !== undefined) docs.push({ where, author: this.nameOf(e.author), ts: e.ts, text: e.body })
    }
    for (const l of readRoomLines(this.roomFile())) docs.push({ where: 'agents', author: l.author, ts: l.ts, text: l.text })
    this.setHome(formatSearch(q, searchDocs(docs, q), Date.now()))
  }

  private showNewRelease(): void {
    if (!isNewerChangelog(VERSION, this.prefs.lastSeenVersion)) return
    const sections = loadChangelog()
    if (sections.length === 0) return
    const recent = getChangesSince(sections, this.prefs.lastSeenVersion)
    const lines = recent.length > 0 ? formatChangelog(recent, 72) : formatChangelog(sections, 72, 1)
    this.homeLines = [`What's new in pager ${VERSION}`, '', ...lines]
    this.markChangelogSeen()
  }

  markChangelogSeen(): void {
    this.updateSettings({ lastSeenVersion: VERSION })
  }

  changelogText(version?: string): string[] {
    const sections = loadChangelog()
    if (sections.length === 0) return ['Changelog not available.']
    const since = version ?? this.prefs.lastSeenVersion
    const recent = getChangesSince(sections, since)
    return recent.length > 0 ? formatChangelog(recent, 72) : formatChangelog(sections, 72, 1)
  }

  latestChangelogVersion(): string | null {
    return latestChangelogVersion(loadChangelog())
  }

  // ---------------------------------------------------------------- queries

  convs(): ConvView[] {
    const byName = (a: ConvView, b: ConvView): number => a.title.toLowerCase().localeCompare(b.title.toLowerCase())
    const dms: ConvView[] = []
    const groups: ConvView[] = []
    for (const conv of this.store.listConvs()) {
      if (conv.kind === 'dm') {
        const peer = conv.peer ? this.store.getPeer(conv.peer) : undefined
        if (!peer || peer.state !== 'accepted') continue
        dms.push({
          id: conv.id,
          kind: 'dm',
          title: peer.name || pk8(peer.pk),
          peer: peer.pk,
          online: this.net.link(peer.pk) !== undefined,
          unread: this.store.unreadCount(conv.id, this.me.pk),
        })
      } else if (conv.state === 'active') {
        groups.push({
          id: conv.id,
          kind: 'group',
          title: conv.title,
          peer: null,
          online: null,
          unread: this.store.unreadCount(conv.id, this.me.pk),
        })
      }
    }
    return [...dms.sort(byName), ...groups.sort(byName)]
  }

  pending(): PendingView[] {
    return this.pendingItems().map((p) => p.view)
  }

  /** True while the home view shows the welcome screen (not /help or /code output). */
  welcome(): boolean {
    return this.homeLines === null
  }

  /** Numbers for the home screen: people, message totals, the last seven days, and agent runs. */
  stats(now = Date.now()): HomeStats {
    const convs = this.convs()
    const dayMs = 86_400_000
    const startOfToday = new Date(now).setHours(0, 0, 0, 0)
    const { sent, received, recent } = this.store.textStats(this.me.pk, startOfToday - 6 * dayMs)
    const week = Array.from({ length: 7 }, () => 0)
    const perConv = new Map<string, number>()
    for (const m of recent) {
      const day = Math.min(6, Math.max(0, 6 - Math.floor((startOfToday + dayMs - 1 - m.ts) / dayMs)))
      week[day] = (week[day] ?? 0) + 1
      perConv.set(m.conv, (perConv.get(m.conv) ?? 0) + 1)
    }
    let busiest: HomeStats['busiest'] = null
    for (const c of convs) {
      const count = perConv.get(c.id) ?? 0
      if (count > (busiest?.count ?? 0)) busiest = { title: c.kind === 'group' ? `#${c.title}` : c.title, count }
    }
    const room = this.agents.room()
    return {
      contacts: convs.filter((c) => c.kind === 'dm').length,
      online: convs.filter((c) => c.online === true).length,
      groups: convs.filter((c) => c.kind === 'group').length,
      pending: this.pendingItems().length,
      unread: convs.reduce((sum, c) => sum + c.unread, 0),
      sent,
      received,
      week,
      busiest,
      agentRuns: room.runs.length,
      agentsRunning: room.runs.filter((r) => r.state === 'running' || r.state === 'queued').length,
      mergeable: room.runs.filter((r) => r.mergeable).length,
    }
  }

  home(): string[] {
    return (
      this.homeLines ?? [
        'pager · a simpler way to chat',
        '',
        `You            ${this.me.name}`,
        'Contact code',
        `  ${this.me.code}`,
        '',
        'Get started',
        '  1. Send your contact code to a friend',
        '  2. They run /add <your code>; you run /accept 1',
        '  3. Ctrl+P opens the command palette, Ctrl+G shows shortcuts',
      ]
    )
  }

  /** The Terminal tab: each command, then its output as a reply. */
  private termMessages(limit: number): MessageView[] {
    const out: MessageView[] = []
    for (const e of this.term.list()) {
      out.push({ key: `t${e.n}`, ts: e.ts, authorName: path.basename(e.cwd) || e.cwd, authorKey: 'term', mine: true, kind: 'text', text: e.command, status: null })
      const lines = [...e.lines, e.partial]
      while (lines.at(-1) === '') lines.pop()
      if (e.dropped > 0) lines.unshift(`… ${e.dropped} earlier lines dropped`)
      if (e.state === 'stopped') lines.push('(stopped)')
      else if (e.state === 'failed' && e.code !== null && lines.length === 0) lines.push(`exit ${e.code}`)
      else if (e.state === 'failed' && e.code !== null) lines.push(`(exit ${e.code})`)
      if (lines.length > 0) out.push({ key: `t${e.n}o`, ts: e.ts, authorName: e.state === 'running' ? 'running…' : 'output', authorKey: 'term-out', mine: false, kind: 'text', text: lines.join('\n'), status: null })
    }
    return out.slice(-limit)
  }

  messages(convId: string, limit: number): MessageView[] {
    if (convId === TERM_ID) return this.termMessages(limit)
    if (convId === DOCS_ID) return []
    if (convId === ROOM_ID) return this.agents.messages(limit)
    const agent = parseAgentTab(convId)
    if (agent !== undefined) return this.agents.messages(limit, agent)
    const shared = parseSharedTab(convId)
    if (shared !== undefined) return this.share.messages(shared, limit)
    const conv = this.store.getConv(convId)
    if (!conv) return []
    const others = this.otherMembers(conv)
    return this.store.listMessages(convId, limit).map((e): MessageView => {
      const mine = e.author === this.me.pk
      const authorName = this.nameOf(e.author)
      const base = { key: `${e.author}:${e.seq}`, ts: e.ts, authorName, authorKey: e.author, mine }
      if (e.kind === 'member-add') {
        return { ...base, kind: 'system', text: `${authorName} added ${this.nameOf(e.body)}`, status: null }
      }
      if (e.kind === 'member-leave') return { ...base, kind: 'system', text: `${authorName} left`, status: null }
      let status: MessageView['status'] = null
      if (mine) {
        const sent = others.length > 0 && others.every((pk) => (this.sentTo.get(`${convId}:${pk}`) ?? 0) >= e.seq)
        const delivered = others.length > 0 && others.every((pk) => this.store.getAck(convId, pk, this.me.pk) >= e.seq)
        const read = delivered && others.every((pk) => (this.readBy.get(`${convId}:${pk}`) ?? 0) >= e.seq)
        status = read ? 'read' : delivered ? 'delivered' : sent ? 'sent' : 'pending'
      }
      return { ...base, kind: 'text', text: e.body, status }
    })
  }

  active(): string | null {
    return this.activeId
  }

  listening(): boolean {
    return this.net.listening
  }

  settings(): Readonly<Settings> {
    return this.prefs
  }

  /** Links whose peer is an accepted contact or a member of an active group. */
  onlineCount(): number {
    const groupMates = new Set<string>()
    for (const c of this.store.listConvs()) {
      if (c.kind === 'group' && c.state === 'active') for (const pk of this.store.members(c.id).current) groupMates.add(pk)
    }
    return this.net.links().filter((l) => this.store.getPeer(l.pk)?.state === 'accepted' || groupMates.has(l.pk)).length
  }

  // ---------------------------------------------------------------- actions

  /** Agents-room view model for the sidebar and status bar. */
  agentRoom(): RoomView {
    return this.agents.room()
  }

  /** Names of the agents that are installed and passed their readiness check, in team order. */
  agentNames(): string[] {
    return this.agents.names()
  }

  /** Probes the installed agent CLIs; resolves when every check is done. */
  checkAgents(): Promise<void> {
    return this.agents.refresh()
  }

  /** Every agent pager knows with its readiness, for the setup screen. */
  agentSetup(): SetupRow[] {
    return this.agents.setup()
  }

  /** Slash commands one ready agent advertises over ACP. */
  agentCommands(name: string): { name: string; description: string; hint?: string }[] {
    return this.agents.names().includes(name) ? this.agents.agentCommands(name) : []
  }

  /** Questions agents are waiting on, oldest first. */
  questions(): QuestionView[] {
    return this.agents.questions.views()
  }

  answerQuestion(id: string, answers: AnswerMap | null): void {
    const shared = parseSharedTab(this.activeId)
    if (shared === undefined) {
      this.agents.questions.answer(id, answers)
      return
    }
    const why = this.share.answer(shared, id, answers)
    if (why !== undefined) this.toast('warn', why)
  }

  /** Agent sessions other people invited me to (joined), for the sidebar. */
  sharedSessions(): SharedView[] {
    return this.share.sessions()
  }

  /** The room behind one shared-session tab: agents, open questions, participants. */
  sharedRoom(hostPk: string): SharedRoom | undefined {
    return this.share.room(hostPk)
  }

  /** Who is in my own shared agent session. */
  sessionGuests(): GuestView[] {
    return this.share.guests()
  }

  /** Adds a teammate from the setup screen; returns the failure reason, if any. */
  async addAgent(cli: string, name?: string): Promise<string | undefined> {
    const added = await this.agents.addAgent(cli, name)
    if (typeof added === 'string') return added
    this.activate(agentTabId(added.name))
    return undefined
  }

  /** Re-checks one agent CLI (setup screen). */
  recheckAgent(cli: string): Promise<void> {
    return this.agents.refresh([cli])
  }

  /** Per-agent totals, the 14-day activity strip and review verdicts. Cached briefly: Home asks on every render and the log is a file. */
  agentStats(now = Date.now()): AgentStats {
    if (this.statsCache === undefined || now - this.statsCache.at > AGENT_STATS_TTL_MS) this.statsCache = { at: now, value: this.agents.stats(now) }
    return this.statsCache.value
  }

  /** The last `/usage` text each agent produced, for Home. */
  agentUsages(): { agent: string; text: string; at: number }[] {
    return this.agents.names().flatMap((agent) => {
      const u = this.agents.usageOf(agent)
      return u === undefined ? [] : [{ agent, text: u.text, at: u.at }]
    })
  }

  /** Peer reviews running right now. */
  agentReviewsPending(): number {
    return this.agents.pendingReviews()
  }

  /** Whether automatic peer review is on. */
  agentReview(): boolean {
    return this.agents.registry.review
  }

  /** The shared goal every agent sees ('' when none). */
  agentGoal(): string {
    return this.agents.goal()
  }

  /** Ctrl+C in the Terminal tab: stop the running command. False when there is nothing to stop. */
  interrupt(): boolean {
    if (this.activeId === TERM_ID) return this.term.stop()
    const agent = parseAgentTab(this.activeId)
    if (agent === undefined || !this.agents.busy(agent)) return false
    this.agents.stop(agent)
    return true
  }

  terminal(): { running: boolean; cwd: string; last: { command: string; state: TermState; code: number | null } | null } {
    const last = this.term.list().at(-1)
    return { running: this.term.running, cwd: this.term.cwd, last: last === undefined ? null : { command: last.command, state: last.state, code: last.code } }
  }

  // ---------------------------------------------------------------- docs

  /** Documents across all conversations, newest edit first, with where each one lives. */
  docList(): (DocInfo & { where: string })[] {
    const titles = new Map(this.convs().map((c) => [c.id, c.kind === 'group' ? `#${c.title}` : c.title]))
    return this.docs.list().map((d) => ({ ...d, where: titles.get(d.conv) ?? 'unknown chat' }))
  }

  /** The document open in the Docs tab, or null for the list. */
  openedDoc(): string | null {
    return this.docs.info(this.openDocId ?? '') ? this.openDocId : null
  }

  /** Show a document in the Docs tab (null = the list). */
  openDoc(id: string | null): void {
    this.openDocId = id
    this.activate(DOCS_ID)
  }

  /** Names of collaborators who edited this document in the last 30 seconds. */
  docEditors(id: string): string[] {
    return this.docs.activeEditors(id).map((pk) => this.nameOf(pk))
  }

  /** Create a document. It is shared with `convId`; without one it goes to the private "notes" group. Returns an error message or the new id. */
  newDoc(name: string, convId?: string): { id: string } | { error: string } {
    const conv = convId ?? this.notesConv()
    const made = this.docs.create(conv, name)
    return typeof made === 'string' ? { error: made } : { id: made.id }
  }

  private notesConv(): string {
    const existing = this.store.listConvs().find((c) => c.kind === 'group' && c.state === 'active' && c.creator === this.me.pk && c.title === 'notes')
    if (existing) return existing.id
    const now = Date.now()
    const id = newGroupId()
    this.store.upsertConv({ id, kind: 'group', title: 'notes', creator: this.me.pk, peer: null, state: 'active', readAt: now, createdAt: now })
    return id
  }

  private publishDoc(convId: string, body: string): void {
    const conv = this.store.getConv(convId)
    if (!conv || conv.state !== 'active') return
    const event = this.appendEvent(convId, 'text', body)
    for (const pk of this.otherMembers(conv)) this.sendEvents(this.net.link(pk), convId, [event])
  }

  /** Documents the user named as #name in an agent task. Shared documents are peer-writable, so nothing is included implicitly. */
  private docsNamedIn(task: string): { name: string; text: string }[] {
    const found = new Map<string, { name: string; text: string }>()
    for (const m of task.matchAll(/(?:^|\s)#([\w.-]+)/g)) {
      const d = this.docs.find(m[1] ?? '')
      if (d) found.set(d.id, { name: d.name, text: this.docs.text(d.id) })
    }
    return [...found.values()]
  }

  /** Agents write as this user: the edit is attributed to the local identity. */
  private agentDocWrite(name: string, text: string, append: boolean, base: string): string | null {
    const doc = this.docs.find(name)
    if (!doc) return 'no single document has that name'
    const current = this.docs.text(doc.id)
    if (!append && current !== base) return 'it changed while the agent worked'
    const next = append ? `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${text}` : text
    this.docs.setText(doc.id, next)
    return null
  }

  private cmdDoc(args: string[]): void {
    const usage = 'Usage: /doc new <name> [in <chat>] | open <name> | rm <name> | rename <name> <new name> | list'
    const sub = (args[0] ?? '').toLowerCase()
    if (sub === '') return this.openDoc(null)
    // "<name> [in <chat>]": names repeat across chats, so an ambiguous one must be narrowed, never guessed.
    const need = (words: string[]): DocInfo | undefined => {
      const at = words.findIndex((a) => a.toLowerCase() === 'in')
      const name = (at < 0 ? words : words.slice(0, at)).join(' ')
      let conv: string | undefined
      if (at >= 0) {
        const res = this.resolve(this.convs(), words.slice(at + 1).join(' '), (c) => c.title, (c) => c.peer)
        if ('error' in res) return void this.toast('error', res.error)
        conv = res.item.id
      }
      const all = this.docs.matches(name, conv)
      if (all.length === 0) return void this.toast('error', `No document named ${name}`)
      if (all.length > 1) return void this.toast('error', `${name} exists in several chats; add "in <chat>"`)
      return all[0]
    }
    if (sub === 'new') {
      const tail = args.slice(1)
      const at = tail.findIndex((a) => a.toLowerCase() === 'in')
      const name = (at < 0 ? tail : tail.slice(0, at)).join(' ')
      let conv: string | undefined
      if (at >= 0) {
        const res = this.resolve(this.convs(), tail.slice(at + 1).join(' '), (c) => c.title, (c) => c.peer)
        if ('error' in res) return this.toast('error', res.error)
        conv = res.item.id
      }
      const made = this.newDoc(name, conv)
      if ('error' in made) return this.toast('error', made.error)
      return this.openDoc(made.id)
    }
    if (sub === 'open') {
      const d = need(args.slice(1))
      if (d) this.openDoc(d.id)
      return
    }
    if (sub === 'rm') {
      const d = need(args.slice(1))
      if (!d) return
      this.docs.remove(d.id)
      this.toast('info', `Removed ${d.name} for everyone in its chat`)
      return
    }
    if (sub === 'rename') {
      const d = need([args[1] ?? ''])
      if (!d) return
      const err = this.docs.rename(d.id, args.slice(2).join(' '))
      if (err) this.toast('error', err)
      return
    }
    if (sub === 'list') {
      const docs = this.docList()
      return this.setHome(docs.length === 0 ? ['No documents yet. /doc new <name> creates one.'] : ['Documents:', ...docs.map((d) => `  ${d.name.padEnd(28)} ${d.where}`)])
    }
    this.toast('error', usage)
  }

  activate(convId: string | null): void {
    const shared = parseSharedTab(convId)
    if (shared !== undefined) {
      if (this.share.room(shared) === undefined) return
      this.share.markRead(shared)
      this.activeId = convId
      this.emit('change')
      return
    }
    const agent = parseAgentTab(convId)
    if (convId === ROOM_ID || convId === TERM_ID || convId === DOCS_ID || agent !== undefined) {
      if (convId === ROOM_ID) this.agents.markRead()
      if (agent !== undefined) this.agents.markRead(agent)
      this.activeId = convId
      this.emit('change')
      return
    }
    if (convId !== null) {
      const conv = this.store.getConv(convId)
      if (!conv || conv.state !== 'active') return
      this.store.markRead(convId, Date.now())
    }
    this.activeId = convId
    if (convId !== null) this.sendRead(convId)
    this.emit('change')
  }

  toggleSidebar(): void {
    this.updateSettings({ sidebar: !this.prefs.sidebar })
  }

  /** Submitted lines, oldest first (persisted across restarts). */
  history(): readonly string[] {
    return this.input
  }

  /** What to append after `text`, learned from the user's own messages and commands. */
  suggest(text: string): string {
    return this.suggester.complete(text)
  }

  async submit(input: string): Promise<void> {
    const text = input.trim()
    if (text === '') return
    this.input = [...this.input.filter((h) => h !== text), text].slice(-HISTORY_MAX)
    this.suggester.learn(text, this.activeId !== TERM_ID)
    try {
      saveHistory(this.dir, this.input)
    } catch {
      // History is a convenience; never block sending.
    }
    if (text.startsWith('//')) return this.sendText(text.slice(1))
    if (text.startsWith('/')) return this.runCommand(text)
    return this.sendText(text)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const t of this.unknownTimers) clearTimeout(t)
    this.unknownTimers.clear()
    if (this.seenTimer !== undefined) clearInterval(this.seenTimer)
    saveLastSeen(this.dir, Date.now())
    this.term.close()
    this.docs.close()
    this.share.close()
    closeDesktop()
    await this.agents.close()
    await this.net.stop()
    this.store.close()
  }

  // ---------------------------------------------------------------- commands

  private async runCommand(line: string): Promise<void> {
    const { name, args, rest } = parseCommand(line)
    switch (name) {
      case 'help':
        return this.setHome(['Commands:', ...COMMANDS.map((c) => `  ${c.usage.padEnd(34)} ${c.summary}`), '', 'Press Ctrl+G for keyboard shortcuts.'])
      case 'terminal':
        return this.activate(TERM_ID)
      case 'doc':
        return this.cmdDoc(args)
      case 'net':
        return this.cmdNet()
      case 'code':
        return this.setHome([`Your name: ${this.me.name}`, `Your contact code: ${this.me.code}`, 'Share it so others can /add you.'])
      case 'name':
        return this.cmdName(rest)
      case 'add':
        return this.cmdAdd(args[0], rest.slice((args[0] ?? '').length))
      case 'accept':
        return this.cmdAcceptDecline(args[0], true)
      case 'decline':
        return this.cmdAcceptDecline(args[0], false)
      case 'open':
        return this.cmdOpen(rest)
      case 'remove':
        return this.cmdRemove(rest)
      case 'group':
        return this.cmdGroup(args[0]?.toLowerCase(), rest.slice((args[0] ?? '').length).trim())
      case 'theme':
        return this.cmdTheme(rest)
      case 'accent':
        return this.cmdAccent(rest)
      case 'badge':
        return this.cmdBadge(rest)
      case 'density':
        return this.cmdDensity(rest)
      case 'notify':
        return this.cmdSwitch('notify', rest, 'Desktop notifications')
      case 'sound':
        return this.cmdSwitch('sound', rest, 'Notification sound')
      case 'update':
        return this.cmdUpdate()
      case 'changelog':
        return this.setHome(this.changelogText(rest.trim() || undefined))
      case 'search':
        return this.cmdSearch(rest)
      case 'agent':
        return this.cmdAgent(rest, args)
      case 'exit':
      case 'quit':
        this.emit('quit')
        return
      default: {
        // Not a pager command: in an agent's tab a command that agent advertises goes to it verbatim.
        const agent = parseAgentTab(this.activeId)
        if (agent !== undefined && this.agentCommands(agent).some((c) => c.name.toLowerCase() === name)) {
          void this.agents.ask(agent, line.trim())
          return
        }
        this.toast('error', `Unknown command /${name}. Try /help`)
      }
    }
  }

  private async cmdAgent(rest: string, args: string[]): Promise<void> {
    const usage =
      '/agent <name> <task> | new <cli> [name] | add <id> <command…> | remove <name> | setup | chain a>b <task> | model|effort <name> [value] | usage [name] | budget [<name|all> turns=<N> minutes=<N>|off] | compact <name> | review on|off | goal <text> | memory [add <text>|clear] | commands <name> | cli <name> <args> | runs | stop [name|run] | merge <name|run> [--force] | verify [<command>|off] | log <run|name> | drop <run|all|name> | reset <name> | undo <name> [n] | checkpoints <name> | check [name] | invite <contact> [--view] | guests | kick <contact|all> | leave [host]'
    const sub = (args[0] ?? '').toLowerCase()
    if (sub === '') return this.toast('info', usage)
    const names = this.agents.names()
    const target = args[1]
    const after = rest.slice(sub.length).trim()
    const nameArg = (target ?? '').toLowerCase()
    const needName = (what: string): boolean => {
      if (names.includes(nameArg)) return true
      this.toast('error', `Usage: /agent ${what} <${names.join('|') || 'name'}>`)
      return false
    }
    switch (sub) {
      case 'new': {
        if (target === undefined) return this.toast('error', 'Usage: /agent new <cli> [name]  (see /agent setup)')
        const added = await this.agents.addAgent(nameArg, args[2]?.toLowerCase())
        if (typeof added === 'string') return this.toast('error', added)
        return this.activate(agentTabId(added.name))
      }
      case 'add': {
        const [id = '', ...command] = splitArgs(after)
        if (id === '' || command.length === 0) return this.toast('error', 'Usage: /agent add <id> <command> [args…]  (a custom agent that speaks ACP over stdio)')
        const problem = await this.agents.addCustom(id.toLowerCase(), command)
        return this.toast(problem === undefined ? 'success' : 'error', problem ?? `${id} is ready: /agent new ${id.toLowerCase()}`)
      }
      case 'remove': {
        const team = this.agentTeam()
        if (team.includes(nameArg)) {
          const kept = (await this.agents.deleteAgent(nameArg)) === 'kept'
          if (parseAgentTab(this.activeId) === nameArg) this.activate(ROOM_ID)
          return this.toast('info', kept ? `${nameArg} left the team. Its workspace has unmerged work and was kept: /agent merge ${nameArg} or /agent drop ${nameArg}` : `${nameArg} was deleted`)
        }
        if (Object.hasOwn(this.agents.registry.custom(), nameArg)) {
          const why = this.agents.registry.removeCustom(nameArg)
          this.agents.emit('change')
          return this.toast(why === null ? 'info' : 'error', why ?? `${nameArg} was removed`)
        }
        return this.toast('error', `Usage: /agent remove <${team.join('|') || 'name'}>`)
      }
      case 'setup':
        this.emit('overlay', 'agents')
        return
      case 'cli': {
        const [name = '', ...argv] = splitArgs(after)
        const agent = name.toLowerCase()
        if (!names.includes(agent) || argv.length === 0) return this.toast('error', `Usage: /agent cli <${names.join('|')}> <cli arguments>`)
        this.activate(agentTabId(agent))
        void this.agents.cli(agent, argv)
        return
      }
      case 'chain': {
        const spec = after.split(/\s/, 1)[0] ?? ''
        const task = after.slice(spec.length).trim()
        const steps = parseChain(spec, names)
        if (steps === undefined || task === '') return this.toast('error', `Usage: /agent chain <a>><b>[><c>] <task>  (agents: ${names.join(', ')})`)
        this.activate(ROOM_ID)
        void this.agents.chain(steps, task)
        return
      }
      case 'commands':
        if (!needName('commands')) return
        this.activate(agentTabId(nameArg))
        void this.agents.commands(nameArg)
        return
      case 'model':
      case 'effort': {
        if (!needName(sub)) return
        const value = after.slice((target ?? '').length).trim()
        this.activate(agentTabId(nameArg))
        if (value === '') return void this.emit('overlay', 'model', nameArg)
        return this.setAgentSetting(nameArg, sub, value)
      }
      case 'color': {
        if (!needName('color')) return
        const wanted = after.slice((target ?? '').length).trim().toLowerCase()
        if (wanted === '') return this.toast('info', `Usage: /agent color ${nameArg} <color|#hex|auto>. Colors: ${COLOR_WORDS.join(', ')}`)
        const color = wanted === 'auto' ? undefined : parseColor(wanted)
        if (wanted !== 'auto' && color === undefined) return this.toast('error', `"${wanted.slice(0, 20)}" is not a color. Use #rrggbb, auto or one of: ${COLOR_WORDS.join(', ')}`)
        this.agents.setColor(nameArg, color)
        return this.toast('success', color === undefined ? `${nameArg} color: auto` : `${nameArg} color: ${color}`)
      }
      case 'usage':
        this.activate(target === undefined ? ROOM_ID : agentTabId(nameArg))
        void this.agents.usage(target === undefined ? undefined : [nameArg])
        return
      case 'budget':
        this.activate(ROOM_ID)
        return this.agents.budget(args.slice(1))
      case 'compact': {
        if (!needName('compact')) return
        const mode = (args[2] ?? 'compact').toLowerCase()
        if (mode !== 'compact' && mode !== 'handoff' && mode !== 'shake') return this.toast('error', 'Usage: /agent compact <name> [handoff|shake]')
        this.activate(agentTabId(nameArg))
        return this.agents.compact(nameArg, mode)
      }
      case 'review': {
        const on = (target ?? '').toLowerCase()
        if (on !== 'on' && on !== 'off') return this.toast('info', `Peer review is ${this.agents.registry.review ? 'on' : 'off'}. /agent review on|off`)
        this.agents.setReview(on === 'on')
        return this.toast('success', `Peer review ${on}`)
      }
      case 'risk': {
        const on = (target ?? '').toLowerCase()
        if (on !== 'on' && on !== 'off') return this.toast('info', `Risky-action approval is ${this.agents.registry.riskApproval ? 'on' : 'off'}. /agent risk on|off`)
        this.agents.setRiskApproval(on === 'on')
        return this.toast('success', `Risky-action approval ${on}`)
      }
      case 'goal':
        this.activate(ROOM_ID)
        return this.agents.setGoal(after)
      case 'memory': {
        const action = (target ?? 'show').toLowerCase()
        if (action !== 'show' && action !== 'add' && action !== 'clear') return this.toast('error', 'Usage: /agent memory [add <text>|clear]')
        this.activate(ROOM_ID)
        void this.agents.memory(action, after.slice((target ?? '').length).trim())
        return
      }
      case 'runs':
        this.activate(ROOM_ID)
        return this.agents.list()
      case 'stop':
        return this.agents.stop(target ?? 'all')
      case 'merge': {
        const force = args.includes('--force')
        const which = args.slice(1).find((a) => a !== '--force')
        return which === undefined ? this.toast('error', 'Usage: /agent merge <name|run> [--force]') : this.agents.merge(which, force)
      }
      case 'verify':
        this.activate(ROOM_ID)
        return void this.agents.setVerify(after)
      case 'log':
        if (target === undefined) return this.toast('error', 'Usage: /agent log <run|name>')
        this.activate(ROOM_ID)
        return this.agents.showLog(nameArg)
      case 'drop':
        return target === undefined ? this.toast('error', 'Usage: /agent drop <run|all|name>') : this.agents.drop(target)
      case 'reset':
        if (!needName('reset')) return
        return void this.agents.reset(nameArg)
      case 'undo': {
        if (!needName('undo')) return
        const turns = args[2] === undefined ? 1 : Number(args[2])
        if (!Number.isInteger(turns) || turns < 1) return this.toast('error', 'Usage: /agent undo <name> [n]')
        this.activate(agentTabId(nameArg))
        return void this.agents.undo(nameArg, turns)
      }
      case 'checkpoints':
        if (!needName('checkpoints')) return
        this.activate(agentTabId(nameArg))
        return void this.agents.listCheckpoints(nameArg)
      case 'check':
        this.activate(ROOM_ID)
        void this.agents.check(target === undefined ? undefined : [nameArg])
        return
      case 'invite':
        return this.agentInvite(args.slice(1))
      case 'guests':
        return this.agentGuests()
      case 'kick':
        return this.agentKick(after)
      case 'leave':
        return this.agentLeave(after)
      default:
        break
    }
    if (names.includes(sub)) {
      if (after === '') return this.toast('error', `Usage: /agent ${sub} <task>`)
      this.activate(agentTabId(sub))
      void this.agents.ask(sub, after)
      return
    }
    this.toast('error', `Usage: ${usage}`)
  }

  private agentInvite(args: string[]): void {
    const access = args.includes('--view') ? 'view' : 'control'
    const query = args.filter((a) => a !== '--view' && a !== '--control').join(' ')
    const peers = this.store.listPeers().filter((p) => p.state === 'accepted')
    const res = this.resolve(peers, query, (p) => p.name || pk8(p.pk), (p) => p.pk)
    if ('error' in res) return this.toast('error', res.error)
    const why = this.share.invite(res.item.pk, access)
    const who = res.item.name || pk8(res.item.pk)
    if (why !== undefined) return this.toast('error', why)
    this.toast('success', `Invited ${who} to your agent session (${access})`)
    if (this.agents.names().length === 0) this.toast('warn', `No agent is ready yet (/agent setup): ${who} will see an empty room until one is`)
    void this.agents.hasRepo().then((ok) => {
      if (!ok) this.toast('warn', `pager is not inside a git repository, so your agents cannot run: ${who}'s requests will fail. Start pager inside one.`)
    })
  }

  /** Names of every accepted contact (the invite completion lists them). */
  contactNames(): string[] {
    return this.store.listPeers().filter((p) => p.state === 'accepted').map((p) => p.name || pk8(p.pk))
  }

  /** Every teammate, ready or not (the palette's delete entries). */
  agentTeam(): string[] {
    return this.agents.registry.instances().map((c) => c.name)
  }

  /** The setup screen's `x`: removes the newest teammate that runs `cli`; with none, forgets the custom agent definition `cli`. */
  async removeAgentOf(cli: string): Promise<void> {
    const last = this.agents.registry.instances().filter((c) => c.cli === cli).at(-1)
    if (last !== undefined) return this.runCommand(`/agent remove ${last.name}`)
    if (Object.hasOwn(this.agents.registry.custom(), cli)) return this.runCommand(`/agent remove ${cli}`)
    this.toast('info', `No ${cli} teammate to remove`)
  }

  private agentGuests(): void {
    const guests = this.share.guests()
    this.setHome(['Your agent session:', ...(guests.length === 0 ? ['  nobody invited: /agent invite <contact> [--view]'] : guests.map((g) => `  ${g.name}  ${g.access}  ${g.state === 'invited' ? 'invited' : g.online ? 'online' : 'offline'}`))])
  }

  private agentKick(query: string): void {
    if (query.trim().toLowerCase() === 'all') return this.reportKick(this.share.kick('all'), 'everyone')
    const res = this.resolve(this.share.guests(), query, (g) => g.name, (g) => g.pk)
    if ('error' in res) return this.toast('error', res.error)
    this.reportKick(this.share.kick(res.item.pk), res.item.name)
  }

  private reportKick(why: string | undefined, who: string): void {
    this.toast(why === undefined ? 'info' : 'error', why ?? `Removed ${who} from your agent session`)
  }

  private agentLeave(query: string): void {
    const sessions = this.share.sessions()
    const open = parseSharedTab(this.activeId)
    const res = query === '' && open !== undefined ? { item: sessions.find((s) => s.pk === open) } : this.resolve(sessions, query, (s) => s.name, (s) => s.pk)
    if ('error' in res) return this.toast('error', res.error)
    if (res.item === undefined) return this.toast('error', 'Usage: /agent leave <host>')
    this.share.decline(res.item.pk)
    this.toast('info', `Left ${res.item.name}'s agent session`)
  }

  /** The agent's model or thinking-level choices: what it advertised over ACP, else the catalog's list. Empty = free text. */
  agentChoices(name: string, kind: 'model' | 'effort'): { value: string; name: string }[] {
    const advertised = this.agents.agentOptions(name).find((o) => o.category === (kind === 'model' ? 'model' : 'thought_level'))
    if (advertised !== undefined && advertised.options.length > 0) return advertised.options
    const cli = this.agents.registry.instances().find((c) => c.name === name)?.cli
    const preset = cli !== undefined && Object.hasOwn(PRESETS, cli) ? PRESETS[cli] : undefined
    return kind === 'effort' ? (preset?.efforts ?? []).map((e) => ({ value: e, name: e })) : []
  }

  /** Whether pager can change this setting for the agent at all (an advertised option, or a CLI flag for one-shot runs). */
  agentSettable(name: string, kind: 'model' | 'effort'): boolean {
    const cli = this.agents.registry.instances().find((c) => c.name === name)?.cli
    const preset = cli !== undefined && Object.hasOwn(PRESETS, cli) ? PRESETS[cli] : undefined
    const flag = kind === 'model' ? preset?.modelFlag : preset?.effortFlag
    return flag !== undefined || this.agents.agentOptions(name).some((o) => o.category === (kind === 'model' ? 'model' : 'thought_level'))
  }

  /** Sets one agent's model or effort (`default` clears it). It applies from the agent's next message. */
  setAgentSetting(name: string, kind: 'model' | 'effort', raw: string): void {
    if (!this.agentSettable(name, kind) && this.agents.agentOptions(name).length > 0) return this.toast('error', `${kind} is not settable for ${name}`)
    const value = raw.trim()
    const clear = value.toLowerCase() === 'default'
    const choices = this.agentChoices(name, kind)
    const hit = choices.find((c) => c.value.toLowerCase() === value.toLowerCase() || c.name.toLowerCase() === value.toLowerCase())
    if (!clear && choices.length > 0 && hit === undefined) {
      const shown = choices.slice(0, 12).map((c) => c.value).join(', ')
      return this.toast('error', `Unknown ${kind} "${value.slice(0, 40)}". Choose: ${shown}${choices.length > 12 ? ', …' : ''}`)
    }
    const next = clear ? undefined : (hit?.value ?? value)
    if (kind === 'model') this.agents.setModel(name, next)
    else this.agents.setEffort(name, next)
    this.toast('success', `${name} ${kind} → ${next ?? 'default'} (applies to its next message)`)
  }

  private setHome(lines: string[]): void {
    this.homeLines = lines
    this.activate(null)
  }

  private updateSettings(patch: Partial<Settings>): void {
    this.prefs = { ...this.prefs, ...patch }
    try {
      saveSettings(this.dir, this.prefs)
    } catch {
      this.toast('warn', 'Could not save settings; the change lasts until you quit')
    }
    this.emit('change')
  }

  /** Records a newer published version: shows the status-bar badge and a toast. */
  setUpdate(version: string): void {
    this.update = version
    this.toast('info', `pager ${version} is available. Quit and run: pager update`)
    this.emit('change')
  }

  updateAvailable(): string | null {
    return this.update
  }

  private async cmdUpdate(): Promise<void> {
    const latest = await latestVersion(this.dir, { force: true })
    if (latest === undefined) return this.toast('error', 'Could not reach the npm registry')
    if (isNewer(latest, VERSION)) return this.setUpdate(latest)
    this.toast('success', `pager ${VERSION} is up to date`)
  }

  private cmdTheme(name: string): void {
    const names = THEMES.map((t) => t.name).join(', ')
    if (name === '') {
      this.emit('overlay', 'theme')
      return
    }
    if (name.toLowerCase() === 'list') {
      this.toast('info', `Theme: ${this.prefs.theme}. Available: ${names}`)
      return
    }
    const theme = findTheme(name)
    if (!theme) {
      this.toast('error', `Unknown theme "${name.slice(0, 20)}". Available: ${names}`)
      return
    }
    this.updateSettings({ theme: theme.name })
    this.toast('success', `Theme: ${theme.name}`)
  }

  private cmdAccent(raw: string): void {
    const wanted = raw.trim().toLowerCase()
    if (wanted === '') return this.toast('info', `Accent: ${this.prefs.accent === '' ? 'auto (the theme accent)' : this.prefs.accent}. /accent <color|#hex|auto>`)
    if (wanted === 'auto') {
      this.updateSettings({ accent: '' })
      return this.toast('success', 'Accent: auto')
    }
    const color = parseColor(wanted)
    if (color === undefined) return this.toast('error', `"${wanted.slice(0, 20)}" is not a color. Use #rrggbb, auto or one of: ${COLOR_WORDS.join(', ')}`)
    this.updateSettings({ accent: color })
    this.toast('success', `Accent: ${color}`)
  }

  private cmdBadge(raw: string): void {
    const wanted = raw.trim()
    if (wanted === '') return this.toast('info', `Badge: ${this.prefs.badge}. /badge <emoji|:shortcode:|none|auto>`)
    const expanded = expandEmoji(wanted)
    const unknownShortcode = /^:[a-z0-9_+-]{2,24}:$/.test(wanted) && expanded === wanted
    const badge = unknownShortcode ? undefined : parseBadge(expanded)
    if (badge === undefined) return this.toast('error', 'A badge is one emoji or symbol, :shortcode:, none or auto')
    this.updateSettings({ badge })
    this.toast('success', `Badge: ${badge}`)
  }

  private cmdSwitch(key: 'notify' | 'sound', raw: string, label: string): void {
    const wanted = raw.trim().toLowerCase()
    if (wanted !== 'on' && wanted !== 'off') return this.toast('info', `${label}: ${this.prefs[key] ? 'on' : 'off'}. /${key} on|off`)
    this.updateSettings({ [key]: wanted === 'on' })
    this.toast('success', `${label}: ${wanted}`)
    if (wanted === 'on' && key === 'notify') {
      warmDesktop()
      this.alert('pager', 'Notifications are on', true)
    }
  }

  private cmdDensity(raw: string): void {
    const wanted = raw.trim().toLowerCase()
    if (!isDensity(wanted)) return this.toast(wanted === '' ? 'info' : 'error', `Density: ${this.prefs.density}. Choose ${DENSITIES.join(', ')}`)
    this.updateSettings({ density: wanted })
    this.toast('success', `Density: ${wanted}`)
  }

  private cmdNet(): void {
    const lines = ['Links:']
    for (const p of this.store.listPeers()) {
      if (p.state !== 'accepted' && p.state !== 'outgoing') continue
      const link = this.net.link(p.pk)
      const state = link ? `online (caps ${link.hello.caps.join(',') || 'none'})` : 'offline'
      lines.push(`  ${p.name || pk8(p.pk)}: ${p.state === 'outgoing' ? 'request pending, ' : ''}${state}`)
    }
    if (lines.length === 1) lines.push('  no contacts yet')
    lines.push(`Network: ${this.net.stats() ?? 'not started'}`, `Listening: ${this.net.listening ? 'yes' : 'no'}`, `Log: ${this.netLog.file}`)
    this.setHome(lines)
  }

  private cmdName(next: string): void {
    if (next === '' || next.length > MAX_NAME || hasControl(next)) {
      this.toast('error', `Name must be 1-${MAX_NAME} characters`)
      return
    }
    saveName(this.dir, next)
    this.me.name = next
    for (const link of this.net.links()) link.send({ t: 'hello', v: 1, name: next, caps: [...LOCAL_CAPS] })
    this.toast('success', `Name set to ${next}`)
    this.emit('change')
  }

  private cmdAdd(code: string | undefined, noteRaw: string): void {
    if (!code) {
      this.toast('error', 'Usage: /add <code> [note]')
      return
    }
    let pk: string
    try {
      pk = decodeContactCode(code).toString('hex')
    } catch (err) {
      if (err instanceof ContactCodeError) this.toast('error', err.message)
      else throw err
      return
    }
    const note = noteRaw.trim().replace(/\p{Cc}/gu, ' ')
    if (note.length > MAX_NOTE) {
      this.toast('error', `Note too long (max ${MAX_NOTE} characters)`)
      return
    }
    if (pk === this.me.pk) {
      this.toast('error', "That's your own code")
      return
    }
    switch (this.store.getPeer(pk)?.state) {
      case 'accepted':
        this.toast('info', 'Already a contact')
        return
      case 'blocked':
        this.toast('error', 'That contact is blocked. /remove them first')
        return
      case 'outgoing':
        this.toast('info', 'Request already sent')
        return
      case 'incoming':
        this.acceptContact(pk)
        return
      default:
        this.store.upsertPeer(pk, { state: 'outgoing', requestSent: false, note }, Date.now())
        this.net.refresh()
        this.toast('success', 'Request queued. It is delivered when they come online')
        this.emit('change')
    }
  }

  private cmdAcceptDecline(arg: string | undefined, accept: boolean): void {
    const items = this.pendingItems()
    const verb = accept ? 'accept' : 'decline'
    if (items.length === 0) {
      this.toast('info', 'Nothing is pending')
      return
    }
    let item: PendingItem | undefined
    if (arg === undefined) {
      if (items.length > 1) {
        this.toast('error', `Several items pending: /${verb} <n>`)
        return
      }
      item = items[0]
    } else {
      item = items.find((i) => String(i.view.n) === arg)
    }
    if (!item) {
      this.toast('error', `No pending item ${arg}`)
      return
    }
    if (item.pk) {
      if (accept) this.acceptContact(item.pk)
      else this.declineContact(item.pk)
    } else if (item.conv) {
      if (accept) this.acceptInvite(item.conv)
      else this.leaveGroup(item.conv)
    } else if (item.session) {
      if (!accept) return this.share.decline(item.session)
      const why = this.share.accept(item.session)
      if (why !== undefined) return this.toast('error', why)
      this.activate(sharedTabId(item.session))
      this.toast('success', `Joined ${this.share.sessions().find((s) => s.pk === item.session)?.name ?? 'the host'}'s agent session: ask with @agent <task>`)
    }
  }

  private cmdOpen(query: string): void {
    const target = query.trim().toLowerCase()
    if (target === 'agents') return this.activate(ROOM_ID)
    if (this.agents.names().includes(target)) return this.activate(agentTabId(target))
    if (target === 'terminal') return this.activate(TERM_ID)
    if (target === 'docs') return this.activate(DOCS_ID)
    const res = this.resolve(this.convs(), query, (c) => c.title, (c) => c.peer)
    if ('error' in res) {
      this.toast('error', res.error)
      return
    }
    this.activate(res.item.id)
  }

  private cmdRemove(query: string): void {
    const peers = this.store.listPeers().filter((p) => p.state !== null)
    const res = this.resolve(peers, query, (p) => p.name || pk8(p.pk), (p) => p.pk)
    if ('error' in res) {
      this.toast('error', res.error)
      return
    }
    const peer = res.item
    const dm = this.store.getConv(dmConvId(this.me.pk, peer.pk))
    if (dm && this.activeId === dm.id) this.activeId = null
    this.store.deletePeer(peer.pk)
    this.net.link(peer.pk)?.close()
    this.net.refresh()
    this.toast('info', `Removed ${peer.name || pk8(peer.pk)}`)
    this.emit('change')
  }

  private cmdGroup(sub: string | undefined, arg: string): void {
    switch (sub) {
      case 'new':
        return this.groupNew(arg)
      case 'invite':
        return this.groupInvite(arg)
      case 'members':
        return this.groupMembers()
      case 'leave': {
        const conv = this.activeGroup()
        if (conv) this.leaveGroup(conv.id)
        return
      }
      default:
        this.toast('error', 'Usage: /group new <name> | invite <name> | members | leave')
    }
  }

  private activeGroup(): Conv | undefined {
    const conv = this.activeId ? this.store.getConv(this.activeId) : undefined
    if (!conv || conv.kind !== 'group') {
      this.toast('error', 'Open a group first')
      return undefined
    }
    return conv
  }

  private groupNew(title: string): void {
    if (title === '' || title.length > MAX_NAME || hasControl(title)) {
      this.toast('error', `Group name must be 1-${MAX_NAME} characters`)
      return
    }
    const now = Date.now()
    const id = newGroupId()
    this.store.upsertConv({ id, kind: 'group', title, creator: this.me.pk, peer: null, state: 'active', readAt: now, createdAt: now })
    this.toast('success', `Created #${title}`)
    this.activate(id)
  }

  private groupInvite(query: string): void {
    const conv = this.activeGroup()
    if (!conv) return
    if (conv.creator !== this.me.pk) {
      this.toast('error', 'Only the group creator can invite')
      return
    }
    const peers = this.store.listPeers().filter((p) => p.state === 'accepted')
    const res = this.resolve(peers, query, (p) => p.name || pk8(p.pk), (p) => p.pk)
    if ('error' in res) {
      this.toast('error', res.error)
      return
    }
    const target = res.item
    const { ever } = this.store.members(conv.id)
    if (ever.has(target.pk)) {
      this.toast('info', 'Already invited to this group')
      return
    }
    if (ever.size >= MAX_GROUP_MEMBERS) {
      this.toast('error', `Group is full (${MAX_GROUP_MEMBERS})`)
      return
    }
    const event = this.appendEvent(conv.id, 'member-add', target.pk)
    this.net.refresh()
    for (const pk of this.otherMembers(conv)) {
      if (pk !== target.pk) this.sendEvents(this.net.link(pk), conv.id, [event])
    }
    this.net.link(target.pk)?.send({ t: 'group-invite', conv: conv.id, title: conv.title, creator: this.me.pk })
    this.toast('success', `Invited ${target.name || pk8(target.pk)}`)
    this.emit('change')
  }

  private groupMembers(): void {
    const conv = this.activeGroup()
    if (!conv) return
    const lines = [`#${conv.title} members:`]
    for (const pk of this.store.members(conv.id).current) {
      const marks = pk === this.me.pk ? ' (you)' : this.net.link(pk) ? ' online' : ''
      lines.push(`  ${this.nameOf(pk)}${marks}`)
    }
    this.setHome(lines)
  }

  // ---------------------------------------------------------------- contacts

  /** `remote`: the other side acted (accepted my request), so say so loudly. */
  private acceptContact(pk: string, remote = false): void {
    const link = this.net.link(pk)
    if (link) this.learnName(link)
    const now = Date.now()
    this.store.upsertPeer(pk, { state: 'accepted' }, now)
    const id = dmConvId(this.me.pk, pk)
    if (!this.store.getConv(id)) {
      this.store.upsertConv({ id, kind: 'dm', title: '', creator: null, peer: pk, state: 'active', readAt: now, createdAt: now })
    }
    if (link?.send({ t: 'contact-accept' })) this.store.upsertPeer(pk, { acceptSent: true }, now)
    this.net.refresh()
    if (link) this.sendSync(link)
    if (remote) this.announce('success', `${this.nameOf(pk)} accepted your contact request`, this.nameOf(pk))
    else this.toast('success', `${this.nameOf(pk)} is now a contact`)
    this.emit('change')
  }

  private declineContact(pk: string): void {
    this.store.upsertPeer(pk, { state: 'blocked' }, Date.now())
    this.net.link(pk)?.close()
    this.toast('info', `Declined ${this.nameOf(pk)}`)
    this.emit('change')
  }

  private pendingItems(): PendingItem[] {
    const contacts = this.store
      .listPeers()
      .filter((p) => p.state === 'incoming')
      .sort((a, b) => a.createdAt - b.createdAt)
    const invites = this.store
      .listConvs()
      .filter((c) => c.kind === 'group' && c.state === 'invited')
      .sort((a, b) => a.createdAt - b.createdAt)
    const items: PendingItem[] = []
    for (const p of contacts) {
      items.push({ pk: p.pk, view: { n: items.length + 1, type: 'contact', label: p.name || pk8(p.pk), note: p.note } })
    }
    for (const c of invites) {
      items.push({ conv: c.id, view: { n: items.length + 1, type: 'group', label: c.title, note: '' } })
    }
    for (const s of this.share.invites()) {
      items.push({ session: s.pk, view: { n: items.length + 1, type: 'session', label: `${s.name}'s agents (${s.access})`, note: '' } })
    }
    return items
  }

  private onContactRequest(link: PeerLink, note: string): void {
    const pk = link.pk
    const peer = this.store.getPeer(pk)
    switch (peer?.state) {
      case 'accepted':
        if (link.send({ t: 'contact-accept' })) this.store.upsertPeer(pk, { acceptSent: true }, Date.now())
        return
      case 'outgoing':
        this.acceptContact(pk, true)
        return
      case 'incoming':
      case 'blocked':
        return
      default: {
        if (this.store.listPeers().filter((p) => p.state === 'incoming').length >= MAX_INCOMING) return
        this.store.upsertPeer(pk, { state: 'incoming', name: link.hello.name, note }, Date.now())
        const n = this.pendingItems().find((i) => i.pk === pk)?.view.n ?? 1
        this.announce('info', `${link.hello.name} wants to connect. /accept ${n}`, link.hello.name)
        this.emit('change')
      }
    }
  }

  // ---------------------------------------------------------------- groups

  private onGroupInvite(link: PeerLink, frame: Extract<Frame, { t: 'group-invite' }>): void {
    if (link.pk !== frame.creator || this.store.getPeer(link.pk)?.state !== 'accepted') return
    if (this.store.getConv(frame.conv)) return
    const now = Date.now()
    this.store.upsertConv({
      id: frame.conv,
      kind: 'group',
      title: frame.title,
      creator: frame.creator,
      peer: null,
      state: 'invited',
      readAt: 0,
      createdAt: now,
    })
    const n = this.pendingItems().find((i) => i.conv === frame.conv)?.view.n ?? 1
    this.announce('info', `${this.nameOf(link.pk)} invited you to ${frame.title}. /accept ${n}`, this.nameOf(link.pk))
    this.emit('change')
  }

  private acceptInvite(convId: string): void {
    const conv = this.store.getConv(convId)
    if (!conv) return
    this.store.upsertConv({ ...conv, state: 'active', readAt: Date.now() })
    this.net.refresh()
    this.sendSyncAll()
    this.toast('success', `Joined ${conv.title}`)
    this.emit('change')
  }

  /** Decline an invite or leave a group: a signed, permanent member-leave. */
  private leaveGroup(convId: string): void {
    const conv = this.store.getConv(convId)
    if (!conv || conv.kind !== 'group' || conv.state === 'left') return
    const event = this.appendEvent(convId, 'member-leave', '')
    this.store.upsertConv({ ...conv, state: 'left' })
    for (const pk of this.store.members(convId).current) {
      if (pk !== this.me.pk) this.sendEvents(this.net.link(pk), convId, [event])
    }
    this.net.refresh()
    if (this.activeId === convId) this.activeId = null
    this.toast('info', `Left ${conv.title}`)
    this.emit('change')
  }

  // ---------------------------------------------------------------- links

  private isKnown(pk: string): boolean {
    if (this.store.getPeer(pk)) return true
    return this.store.listConvs().some((c) => c.kind === 'group' && this.store.members(c.id).ever.has(pk))
  }

  private wantedSet(): Set<string> {
    const out = new Set<string>()
    for (const p of this.store.listPeers()) if (p.state === 'outgoing' || p.state === 'accepted') out.add(p.pk)
    for (const c of this.store.listConvs()) {
      if (c.kind !== 'group' || c.state !== 'active') continue
      for (const pk of this.store.members(c.id).current) out.add(pk)
      if (c.creator) out.add(c.creator)
    }
    out.delete(this.me.pk)
    for (const pk of out) if (this.store.getPeer(pk)?.state === 'blocked') out.delete(pk)
    return out
  }

  private learnName(link: PeerLink): void {
    const existing = this.store.getPeer(link.pk)
    if (existing?.state === 'blocked') return
    if (existing || this.isKnown(link.pk)) this.store.upsertPeer(link.pk, { name: link.hello.name }, Date.now())
  }

  private onOpen(link: PeerLink): void {
    const pk = link.pk
    if (!this.isKnown(pk)) {
      const unknown = this.net.links().filter((l) => !this.isKnown(l.pk)).length
      if (unknown > MAX_UNKNOWN_LINKS) {
        link.close()
        return
      }
      const timer = setTimeout(() => {
        this.unknownTimers.delete(timer)
        if (this.net.link(pk) === link && !this.isKnown(pk)) link.close()
      }, UNKNOWN_LINK_TTL_MS)
      timer.unref()
      this.unknownTimers.add(timer)
      this.emit('change')
      return
    }
    this.learnName(link)
    const peer = this.store.getPeer(pk)
    const now = Date.now()
    if (!this.online.has(pk)) {
      this.online.add(pk)
      const groupmate = this.store.listConvs().some((c) => c.kind === 'group' && c.state === 'active' && this.store.members(c.id).current.has(pk))
      if (peer?.state === 'accepted' || groupmate) this.announce('info', `${this.nameOf(pk)} is online`, this.nameOf(pk))
    }
    if (peer?.state === 'outgoing' && !peer.requestSent) {
      if (link.send({ t: 'contact-request', note: peer.note })) this.store.upsertPeer(pk, { requestSent: true }, now)
    } else if (peer?.state === 'accepted' && !peer.acceptSent) {
      if (link.send({ t: 'contact-accept' })) this.store.upsertPeer(pk, { acceptSent: true }, now)
    }
    for (const conv of this.store.listConvs()) {
      if (conv.kind !== 'group' || conv.state !== 'active' || conv.creator !== this.me.pk) continue
      if (this.store.members(conv.id).current.has(pk) && !this.store.isJoined(conv.id, pk)) {
        link.send({ t: 'group-invite', conv: conv.id, title: conv.title, creator: this.me.pk })
      }
    }
    this.share.onOpen(link)
    this.sendSync(link)
    this.emit('change')
  }

  private onFrame(link: PeerLink, frame: Frame): void {
    if (!this.isKnown(link.pk) && frame.t !== 'contact-request') {
      link.close()
      return
    }
    if (!this.store.getPeer(link.pk)?.name) this.learnName(link)
    switch (frame.t) {
      case 'contact-request':
        return this.onContactRequest(link, frame.note)
      case 'contact-accept':
        if (this.store.getPeer(link.pk)?.state === 'outgoing') this.acceptContact(link.pk, true)
        return
      case 'group-invite':
        return this.onGroupInvite(link, frame)
      case 'sync-state':
        return this.onSyncState(link, frame.have)
      case 'events':
        return this.onEvents(link, frame.conv, frame.events)
      case 'ack':
        return this.onAck(link, frame)
      case 'read':
        return this.onRead(link, frame)
      case 'collab-invite':
      case 'collab-join':
      case 'collab-leave':
      case 'collab-end':
      case 'collab-say':
      case 'collab-answer':
      case 'collab-sync':
        return this.share.onFrame(link, frame)
      default:
    }
  }

  // ---------------------------------------------------------------- sync

  private entitled(pk: string, conv: Conv): boolean {
    if (conv.kind === 'dm') return conv.peer === pk && this.store.getPeer(pk)?.state === 'accepted'
    return this.store.members(conv.id).current.has(pk)
  }

  private otherMembers(conv: Conv): string[] {
    if (conv.kind === 'dm') return conv.peer ? [conv.peer] : []
    return [...this.store.members(conv.id).current].filter((pk) => pk !== this.me.pk)
  }

  private sendSync(link: PeerLink): void {
    const have: Record<string, { left: boolean; seqs: Record<string, number> }> = {}
    for (const conv of this.store.listConvs()) {
      if (conv.state === 'invited' || !this.entitled(link.pk, conv)) continue
      have[conv.id] = { left: conv.state === 'left', seqs: this.store.haveVector(conv.id) }
    }
    link.send({ t: 'sync-state', have })
  }

  private sendSyncAll(): void {
    for (const link of this.net.links()) this.sendSync(link)
  }

  private sendEvents(link: PeerLink | undefined, convId: string, events: PagerEvent[]): void {
    if (!link) return
    let batch: WireEvent[] = []
    let bytes = 0
    let mine = 0
    const flush = (): void => {
      if (batch.length > 0 && link.send({ t: 'events', conv: convId, events: batch }) && mine > 0) {
        const key = `${convId}:${link.pk}`
        this.sentTo.set(key, Math.max(this.sentTo.get(key) ?? 0, mine))
      }
      batch = []
      bytes = 0
      mine = 0
    }
    for (const { conv: _conv, ...wire } of events) {
      const size = Buffer.byteLength(JSON.stringify(wire))
      if (batch.length >= EVENTS_PER_FRAME || bytes + size > EVENTS_BYTES_PER_FRAME) flush()
      batch.push(wire)
      if (wire.author === this.me.pk) mine = Math.max(mine, wire.seq)
      bytes += size
    }
    flush()
  }

  private onSyncState(link: PeerLink, have: Extract<Frame, { t: 'sync-state' }>['have']): void {
    for (const [convId, entry] of Object.entries(have)) {
      const conv = this.store.getConv(convId)
      if (!conv || conv.state === 'invited' || entry.left || !this.entitled(link.pk, conv)) continue
      if (conv.state === 'active') {
        if (conv.kind === 'group' && conv.creator === this.me.pk) {
          const was = this.store.isJoined(convId, link.pk)
          this.store.markJoined(convId, link.pk)
          if (!was) this.announce('success', `${this.nameOf(link.pk)} joined #${conv.title}`, `#${conv.title}`)
        }
        const mine = entry.seqs[this.me.pk]
        if (mine !== undefined) this.store.setAck(convId, link.pk, this.me.pk, Math.min(mine, this.store.lastSeq(convId, this.me.pk)))
      }
      // A leaver only delivers its own events; an active member relays everything the peer lacks.
      const authors = conv.state === 'left' ? [this.me.pk] : this.store.authorsOf(convId)
      authors.sort((a, b) => Number(b === conv.creator) - Number(a === conv.creator))
      for (const author of authors) {
        let cursor = entry.seqs[author] ?? 0
        for (;;) {
          const events = this.store.eventsAfter(convId, author, cursor, EVENTS_PER_FRAME)
          const last = events.at(-1)
          if (!last) break
          this.sendEvents(link, convId, events)
          cursor = last.seq
        }
      }
    }
    this.emit('change')
  }

  private onEvents(link: PeerLink, convId: string, events: WireEvent[]): void {
    const touched = new Set<string>()
    let membership = false
    for (const wire of events) {
      const ev: PagerEvent = { conv: convId, ...wire }
      if (!checkEvent(this.store, this.me.pk, link.pk, ev).ok) continue
      if (!this.store.insertEvent(ev, Date.now())) continue
      touched.add(ev.author)
      if (ev.kind === 'text') {
        // Document operations share the chat log but are never chat messages.
        if (ev.body.startsWith(DOC_PREFIX)) this.docs.applyEvent(ev)
        else this.onIncomingText(ev)
      } else membership = true
    }
    for (const author of touched) link.send({ t: 'ack', conv: convId, author, seq: this.store.lastSeq(convId, author) })
    if (membership) {
      this.net.refresh()
      this.sendSyncAll()
    }
    if (touched.size > 0) this.emit('change')
  }

  private onIncomingText(ev: PagerEvent): void {
    if (ev.author === this.me.pk) return
    const conv = this.store.getConv(ev.conv)
    if (!conv) return
    const who = this.nameOf(ev.author)
    const snippet = ev.body.slice(0, 60)
    // The desktop alert is skipped while pager has focus (see alert()).
    this.alert(conv.kind === 'group' ? `#${conv.title}` : who, conv.kind === 'group' ? `${who}: ${snippet}` : snippet)
    if (this.activeId === conv.id) {
      this.store.markRead(conv.id, Date.now())
      this.sendRead(conv.id)
      // The popup is only redundant when the chat is open in a window you are looking at.
      if (this.focused) return
    }
    this.toast('info', conv.kind === 'group' ? `#${conv.title} ${who}: ${snippet}` : `${who}: ${snippet}`)
  }

  /** Tells each peer (that speaks the 'read' frame) how far I have read their messages in `convId`. Waits until the window has focus. */
  private sendRead(convId: string): void {
    if (!this.focused) return
    const conv = this.store.getConv(convId)
    if (!conv || conv.state !== 'active') return
    for (const pk of this.otherMembers(conv)) {
      const seq = this.store.lastSeq(convId, pk)
      const key = `${convId}:${pk}`
      if (seq === 0 || (this.readSent.get(key) ?? 0) >= seq) continue
      const link = this.net.link(pk)
      if (link?.hello.caps.includes('read') !== true) continue
      if (link.send({ t: 'read', conv: convId, author: pk, seq })) this.readSent.set(key, seq)
    }
  }

  private onRead(link: PeerLink, frame: Extract<Frame, { t: 'read' }>): void {
    if (frame.author !== this.me.pk) return
    const conv = this.store.getConv(frame.conv)
    if (!conv || !this.entitled(link.pk, conv) || frame.seq > this.store.lastSeq(frame.conv, this.me.pk)) return
    const key = `${frame.conv}:${link.pk}`
    if (frame.seq <= (this.readBy.get(key) ?? 0)) return
    this.readBy.set(key, frame.seq)
    this.emit('change')
  }

  /** The window gained or lost focus; regaining it marks the open chat as read for its senders. */
  setFocused(focused: boolean, trusted: boolean): void {
    if (this.focused === focused && this.focusTrusted === trusted) return
    this.focused = focused
    this.focusTrusted = trusted
    if (focused && this.activeId !== null) this.sendRead(this.activeId)
  }

  /** A desktop notification (outside the terminal) with a chime; the settings turn either off, and it is skipped while pager has trusted focus unless forced. */
  private alert(title: string, body: string, force = false): void {
    this.emit('notify', title, body)
    if (!this.prefs.notify || (!force && this.focused && this.focusTrusted)) return
    desktopNotify({ title, body, sound: this.prefs.sound })
  }

  /** A popup in pager and a desktop alert with a chime. */
  private announce(kind: ToastKind, text: string, title: string): void {
    this.toast(kind, text)
    this.alert(title, text)
  }

  private onAck(link: PeerLink, frame: Extract<Frame, { t: 'ack' }>): void {
    if (frame.author !== this.me.pk) return
    const conv = this.store.getConv(frame.conv)
    if (!conv || !this.entitled(link.pk, conv)) return
    if (frame.seq > this.store.lastSeq(frame.conv, this.me.pk)) return
    this.store.setAck(frame.conv, link.pk, this.me.pk, frame.seq)
    this.emit('change')
  }

  // ---------------------------------------------------------------- sending

  private appendEvent(convId: string, kind: EventKind, body: string): PagerEvent {
    const { secretKey } = this
    const seq = this.store.lastSeq(convId, this.me.pk) + 1
    const event = signEvent({ conv: convId, author: this.me.pk, seq, ts: Date.now(), kind, body }, secretKey)
    this.store.insertEvent(event, event.ts)
    return event
  }

  /** Where chat, room and agent-tab text goes out: `:fire:` shortcodes become unicode here, so peers on any version see it. The terminal gets what was typed. */
  private sendText(typed: string): void {
    const text = this.activeId === TERM_ID ? typed : expandEmoji(typed)
    if (text.length > MAX_TEXT) {
      this.toast('error', `Message too long (max ${MAX_TEXT} characters)`)
      return
    }
    const shared = parseSharedTab(this.activeId)
    if (shared !== undefined) {
      const why = this.share.say(shared, text)
      if (why !== undefined) this.toast('warn', why)
      return
    }
    if (this.activeId === ROOM_ID || parseAgentTab(this.activeId) !== undefined) return this.agents.say(text, parseAgentTab(this.activeId))
    if (this.activeId === TERM_ID) return this.term.run(text)
    const conv = this.activeId ? this.store.getConv(this.activeId) : undefined
    if (!conv) {
      this.toast('warn', 'Open a conversation first (Ctrl+P) or /add a contact')
      return
    }
    if (conv.state !== 'active' || (conv.kind === 'dm' && this.store.getPeer(conv.peer ?? '')?.state !== 'accepted')) {
      this.toast('error', 'This conversation is not active')
      return
    }
    const event = this.appendEvent(conv.id, 'text', text)
    this.store.markRead(conv.id, event.ts)
    this.sendRead(conv.id)
    this.emit('change')
    for (const pk of this.otherMembers(conv)) this.sendEvents(this.net.link(pk), conv.id, [event])
  }

  // ---------------------------------------------------------------- helpers

  private toast(kind: ToastKind, text: string): void {
    this.emit('toast', { kind, text } satisfies Toast)
  }

  private nameOf(pk: string): string {
    if (pk === this.me.pk) return this.me.name
    return this.store.getPeer(pk)?.name || pk8(pk)
  }

  /** Exact name (case-insensitive), else unique name prefix, else pk-hex prefix (>= 4 chars). */
  private resolve<T>(
    items: T[],
    query: string,
    label: (t: T) => string,
    pkOf: (t: T) => string | null,
  ): { item: T } | { error: string } {
    const q = query.trim().toLowerCase()
    if (q === '') return { error: 'Name required' }
    let hits = items.filter((i) => label(i).toLowerCase() === q)
    if (hits.length === 0) {
      const hex = q.length >= 4 && /^[0-9a-f]+$/.test(q)
      hits = items.filter((i) => label(i).toLowerCase().startsWith(q) || (hex && pkOf(i)?.startsWith(q)))
    }
    const [first] = hits
    if (hits.length === 1 && first !== undefined) return { item: first }
    if (hits.length === 0) return { error: `No match for "${query}"` }
    return { error: `Ambiguous: ${hits.map((h) => `${label(h)} (${pkOf(h)?.slice(0, 8) ?? 'group'})`).join(', ')}` }
  }
}
