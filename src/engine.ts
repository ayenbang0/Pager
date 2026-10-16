import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { BootstrapNode } from 'hyperdht'
import { isAgentName, type AdapterSpec, type AgentName } from './agents/adapters.js'
import { Orchestrator, ROOM_ID, type RoomView } from './agents/orchestrator.js'
import { COMMANDS, parseCommand } from './commands.js'
import { ContactCodeError, decodeContactCode, encodeContactCode } from './contactCode.js'
import { Store, type Conv } from './db.js'
import { dmConvId, newGroupId, signEvent, type EventKind, type PagerEvent } from './events.js'
import { loadOrCreateIdentity, saveName } from './identity.js'
import { checkEvent, MAX_GROUP_MEMBERS } from './ingest.js'
import { Net, type PeerLink } from './net.js'
import { HISTORY_MAX, loadHistory, saveHistory } from './history.js'
import { loadSettings, saveSettings, type Settings } from './settings.js'
import { findTheme, THEMES } from './themes.js'
import { isNewer, latestVersion } from './update.js'
import { VERSION } from './version.js'
import { parseChain, splitArgs } from './agents/protocol.js'
import type { Frame } from './wire.js'

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
export interface PendingView {
  n: number
  type: 'contact' | 'group'
  label: string
  note: string
}
export interface MessageView {
  key: string
  ts: number
  authorName: string
  authorKey: string
  mine: boolean
  kind: 'text' | 'system'
  text: string
  /** Render Markdown (agent replies only; peer text stays literal). */
  markdown?: boolean
  status: 'pending' | 'delivered' | null
}
export interface EngineOptions {
  dir: string
  bootstrap?: BootstrapNode[]
  dhtOptions?: Record<string, unknown>
  backoff?: { baseMs: number; maxMs: number }
  /** Directory agents work against; must be inside a git repository. Defaults to the current directory. */
  workdir?: string
  /** Test seam: replaces the real agent CLIs. */
  agentAdapters?: Partial<Record<AgentName, AdapterSpec>>
}

interface PendingItem {
  view: PendingView
  pk?: string
  conv?: string
}

type WireEvent = Extract<Frame, { t: 'events' }>['events'][number]

const MAX_TEXT = 4000
const MAX_NAME = 64
const MAX_NOTE = 200
const MAX_INCOMING = 20
const MAX_UNKNOWN_LINKS = 20
const UNKNOWN_LINK_TTL_MS = 30_000
const EVENTS_PER_FRAME = 100
const EVENTS_BYTES_PER_FRAME = 200_000

const hasControl = (s: string): boolean => /\p{Cc}/u.test(s)
const pk8 = (pk: string): string => pk.slice(0, 8)

/** Events: 'change' (), 'toast' (Toast), 'quit' (). */
export class Engine extends EventEmitter {
  readonly me: { pk: string; code: string; name: string }

  private readonly dir: string
  private readonly secretKey: Buffer
  private readonly store: Store
  private readonly net: Net
  private readonly agents: Orchestrator
  private readonly unknownTimers = new Set<NodeJS.Timeout>()
  private activeId: string | null = null
  /** Text set by /help and /code; null shows the welcome banner. */
  private homeLines: string[] | null = null
  private closed = false
  private update: string | null = null
  private prefs: Settings
  private input: string[]

  static async open(opts: EngineOptions): Promise<Engine> {
    const engine = new Engine(opts)
    engine.net.start()
    return engine
  }

  private constructor(opts: EngineOptions) {
    super()
    this.dir = opts.dir
    this.prefs = loadSettings(opts.dir)
    this.input = loadHistory(opts.dir)
    const identity = loadOrCreateIdentity(opts.dir)
    this.secretKey = identity.keyPair.secretKey
    this.store = new Store(path.join(opts.dir, 'pager.db'))
    this.me = { pk: identity.pk, code: encodeContactCode(identity.keyPair.publicKey), name: identity.name }
    this.net = new Net({
      keyPair: identity.keyPair,
      bootstrap: opts.bootstrap,
      dhtOptions: opts.dhtOptions,
      backoff: opts.backoff,
      getName: () => this.me.name,
      isBlocked: (pk) => this.store.getPeer(pk)?.state === 'blocked',
      wanted: () => this.wantedSet(),
    })
    this.net.on('listening', () => this.emit('change'))
    this.net.on('open', (link: PeerLink) => this.onOpen(link))
    this.net.on('hello', (link: PeerLink) => {
      this.learnName(link)
      this.emit('change')
    })
    this.net.on('frame', (link: PeerLink, frame: Frame) => this.onFrame(link, frame))
    this.net.on('close', () => this.emit('change'))
    this.agents = new Orchestrator({ dataDir: opts.dir, workdir: opts.workdir ?? process.cwd(), adapters: opts.agentAdapters })
    this.agents.on('change', () => {
      if (this.activeId === ROOM_ID) this.agents.markRead()
      this.emit('change')
    })
    this.agents.on('toast', (t: Toast) => this.emit('toast', t))
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

  home(): string[] {
    return (
      this.homeLines ?? [
        'pager · peer-to-peer terminal chat',
        '',
        `You            ${this.me.name}`,
        'Contact code',
        `  ${this.me.code}`,
        '',
        'Get started',
        '  1. Send your contact code to a friend',
        '  2. They run /add <your code>; you run /accept 1',
        '  3. Ctrl+P opens the command palette, ? shows shortcuts',
      ]
    )
  }

  messages(convId: string, limit: number): MessageView[] {
    if (convId === ROOM_ID) return this.agents.messages(limit)
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
        const delivered = others.length > 0 && others.every((pk) => this.store.getAck(convId, pk, this.me.pk) >= e.seq)
        status = delivered ? 'delivered' : 'pending'
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

  activate(convId: string | null): void {
    if (convId === ROOM_ID) {
      this.agents.markRead()
      this.activeId = ROOM_ID
      this.emit('change')
      return
    }
    if (convId !== null) {
      const conv = this.store.getConv(convId)
      if (!conv || conv.state !== 'active') return
      this.store.markRead(convId, Date.now())
    }
    this.activeId = convId
    this.emit('change')
  }

  toggleSidebar(): void {
    this.updateSettings({ sidebar: !this.prefs.sidebar })
  }

  /** Submitted lines, oldest first (persisted across restarts). */
  history(): readonly string[] {
    return this.input
  }

  async submit(input: string): Promise<void> {
    const text = input.trim()
    if (text === '') return
    this.input = [...this.input.filter((h) => h !== text), text].slice(-HISTORY_MAX)
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
    await this.agents.close()
    await this.net.stop()
    this.store.close()
  }

  // ---------------------------------------------------------------- commands

  private async runCommand(line: string): Promise<void> {
    const { name, args, rest } = parseCommand(line)
    switch (name) {
      case 'help':
        return this.setHome(['Commands:', ...COMMANDS.map((c) => `  ${c.usage.padEnd(34)} ${c.summary}`), '', 'Press ? for keyboard shortcuts.'])
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
      case 'update':
        return this.cmdUpdate()
      case 'agent':
        return this.cmdAgent(rest, args)
      case 'quit':
        this.emit('quit')
        return
      default:
        this.toast('error', `Unknown command /${name}. Try /help`)
    }
  }

  private async cmdAgent(rest: string, args: string[]): Promise<void> {
    const usage =
      '/agent <omp|claude|opencode|hermes> <task> | chain a>b <task> | cli <name> <args> | memory [add <text>|clear] | commands <name> | runs | stop [id] | merge <id> | drop <id|all> | check'
    const sub = (args[0] ?? '').toLowerCase()
    if (sub === '') return this.toast('info', usage)
    if (isAgentName(sub)) {
      const task = rest.slice(sub.length).trim()
      if (task === '') return this.toast('error', `Usage: /agent ${sub} <task>`)
      this.activate(ROOM_ID)
      void this.agents.ask(sub, task)
      return
    }
    const target = args[1]
    switch (sub) {
      case 'cli': {
        const [name = '', ...argv] = splitArgs(rest.slice(sub.length))
        const agent = name.toLowerCase()
        if (!isAgentName(agent) || argv.length === 0) {
          return this.toast('error', 'Usage: /agent cli <omp|claude|opencode|hermes> <cli arguments>')
        }
        this.activate(ROOM_ID)
        void this.agents.cli(agent, argv)
        return
      }
      case 'chain': {
        const body = rest.slice(sub.length).trim()
        const spec = body.split(/\s/, 1)[0] ?? ''
        const task = body.slice(spec.length).trim()
        const steps = parseChain(spec)
        if (steps === undefined || task === '') {
          return this.toast('error', 'Usage: /agent chain <a>><b>[><c>] <task>  (agents: omp, claude, opencode, hermes)')
        }
        this.activate(ROOM_ID)
        void this.agents.chain(steps, task)
        return
      }
      case 'commands': {
        const name = (args[1] ?? '').toLowerCase()
        if (!isAgentName(name)) return this.toast('error', 'Usage: /agent commands <omp|claude|opencode|hermes>')
        this.activate(ROOM_ID)
        void this.agents.commands(name)
        return
      }
      case 'memory': {
        const action = (args[1] ?? 'show').toLowerCase()
        if (action !== 'show' && action !== 'add' && action !== 'clear') {
          return this.toast('error', 'Usage: /agent memory [add <text>|clear]')
        }
        this.activate(ROOM_ID)
        void this.agents.memory(action, rest.slice(sub.length).trim().slice((args[1] ?? '').length).trim())
        return
      }
      case 'runs':
        this.activate(ROOM_ID)
        return this.agents.list()
      case 'stop':
        return this.agents.stop(target ?? 'all')
      case 'merge':
        return target === undefined ? this.toast('error', 'Usage: /agent merge <run>') : this.agents.merge(target)
      case 'drop':
        return target === undefined ? this.toast('error', 'Usage: /agent drop <run|all>') : this.agents.drop(target)
      case 'check':
        this.activate(ROOM_ID)
        void this.agents.check()
        return
      default:
        return this.toast('error', `Usage: ${usage}`)
    }
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

  private cmdName(next: string): void {
    if (next === '' || next.length > MAX_NAME || hasControl(next)) {
      this.toast('error', `Name must be 1-${MAX_NAME} characters`)
      return
    }
    saveName(this.dir, next)
    this.me.name = next
    for (const link of this.net.links()) link.send({ t: 'hello', v: 1, name: next })
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
    }
  }

  private cmdOpen(query: string): void {
    if (query.trim().toLowerCase() === 'agents') return this.activate(ROOM_ID)
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

  private acceptContact(pk: string): void {
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
    this.toast('success', `${this.nameOf(pk)} is now a contact`)
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
        this.acceptContact(pk)
        return
      case 'incoming':
      case 'blocked':
        return
      default: {
        if (this.store.listPeers().filter((p) => p.state === 'incoming').length >= MAX_INCOMING) return
        this.store.upsertPeer(pk, { state: 'incoming', name: link.hello.name, note }, Date.now())
        const n = this.pendingItems().find((i) => i.pk === pk)?.view.n ?? 1
        this.toast('info', `${link.hello.name} wants to connect. /accept ${n}`)
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
    this.toast('info', `${this.nameOf(link.pk)} invited you to ${frame.title}. /accept ${n}`)
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
        if (this.store.getPeer(link.pk)?.state === 'outgoing') this.acceptContact(link.pk)
        return
      case 'group-invite':
        return this.onGroupInvite(link, frame)
      case 'sync-state':
        return this.onSyncState(link, frame.have)
      case 'events':
        return this.onEvents(link, frame.conv, frame.events)
      case 'ack':
        return this.onAck(link, frame)
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
    const flush = (): void => {
      if (batch.length > 0) link.send({ t: 'events', conv: convId, events: batch })
      batch = []
      bytes = 0
    }
    for (const { conv: _conv, ...wire } of events) {
      const size = Buffer.byteLength(JSON.stringify(wire))
      if (batch.length >= EVENTS_PER_FRAME || bytes + size > EVENTS_BYTES_PER_FRAME) flush()
      batch.push(wire)
      bytes += size
    }
    flush()
  }

  private onSyncState(link: PeerLink, have: Extract<Frame, { t: 'sync-state' }>['have']): void {
    for (const [convId, entry] of Object.entries(have)) {
      const conv = this.store.getConv(convId)
      if (!conv || conv.state === 'invited' || entry.left || !this.entitled(link.pk, conv)) continue
      if (conv.state === 'active') {
        if (conv.kind === 'group' && conv.creator === this.me.pk) this.store.markJoined(convId, link.pk)
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
      if (ev.kind === 'text') this.onIncomingText(ev)
      else membership = true
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
    if (this.activeId === conv.id) {
      this.store.markRead(conv.id, Date.now())
      return
    }
    const snippet = ev.body.slice(0, 60)
    const who = this.nameOf(ev.author)
    this.toast('info', conv.kind === 'group' ? `#${conv.title} ${who}: ${snippet}` : `${who}: ${snippet}`)
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

  private sendText(text: string): void {
    if (text.length > MAX_TEXT) {
      this.toast('error', `Message too long (max ${MAX_TEXT} characters)`)
      return
    }
    if (this.activeId === ROOM_ID) return this.agents.say(text)
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
