import fs from 'node:fs'
import path from 'node:path'
import type { MessageView, ToastKind } from '../engine.js'
import { isRecord } from '../guards.js'
import type { PeerLink } from '../net.js'
import { cleanText, type CollabAccess, type CollabAgent, type CollabEntry, type CollabGuest, type Frame } from '../wire.js'
import type { Actor, Orchestrator } from './orchestrator.js'
import type { AnswerMap, QuestionView } from './questions.js'
import { authorKeyOf, type RoomEntry } from './store.js'
import type { AgentView } from './types.js'

export type ShareAccess = CollabAccess
type SyncFrame = Extract<Frame, { t: 'collab-sync' }>

const MAX_GUESTS = 8
const MAX_HOSTS = 8
const SYNC_DEBOUNCE_MS = 150
const RESET_ENTRIES = 100
const CHUNK_ENTRIES = 40
const CHUNK_BYTES = 120_000
const ENTRY_CHARS = 12_000
const MIRROR_ENTRIES = 500
const CAP = 'collab'

interface Member {
  name: string
  access: ShareAccess
  state: 'invited' | 'joined'
}

export interface GuestView {
  pk: string
  name: string
  access: ShareAccess
  state: 'invited' | 'joined'
  online: boolean
}

/** A shared session as the guest's sidebar shows it. */
export interface SharedView {
  pk: string
  name: string
  access: ShareAccess
  connected: boolean
  unread: number
  asking: boolean
}

/** What a guest sees of the host's room beside its messages. */
export interface SharedRoom {
  host: string
  access: ShareAccess
  connected: boolean
  agents: AgentView[]
  questions: QuestionView[]
  guests: CollabGuest[]
}

interface Mirror {
  host: string
  entries: CollabEntry[]
  agents: CollabAgent[]
  questions: QuestionView[]
  guests: CollabGuest[]
  unread: number
}

export interface SharePorts {
  me: { pk: string; name: string }
  /** Data dir; the two JSON files live here. */
  dir: string
  link(pk: string): PeerLink | undefined
  /** An accepted contact. */
  isContact(pk: string): boolean
  nameOf(pk: string): string
  orch: Orchestrator
  /** Is the shared-session tab of `hostPk` the one on screen? */
  isActive(hostPk: string): boolean
  /** The number `/accept` takes for this host's invite. */
  acceptNumber(hostPk: string): number
  announce(kind: ToastKind, text: string, title: string): void
  toast(kind: ToastKind, text: string): void
  changed(): void
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

function readMembers(file: string, key: 'guests' | 'hosts'): Map<string, Member> {
  const out = new Map<string, Member>()
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = isRecord(raw) ? raw[key] : undefined
    if (!Array.isArray(list)) return out
    for (const m of list) {
      if (!isRecord(m) || typeof m.pk !== 'string' || typeof m.name !== 'string') continue
      if ((m.access !== 'view' && m.access !== 'control') || (m.state !== 'invited' && m.state !== 'joined')) continue
      out.set(m.pk, { name: m.name, access: m.access, state: m.state })
    }
  } catch {
    // no file yet, or unreadable: start empty
  }
  return out
}

function writeMembers(file: string, key: 'guests' | 'hosts', members: Map<string, Member>): void {
  const tmp = `${file}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ [key]: [...members].map(([pk, m]) => ({ pk, ...m })) }, null, 2))
    fs.renameSync(tmp, file)
  } catch {
    // The session still works; the list just will not survive a restart.
  }
}

/** Questions are agent-written; cut them to what the wire accepts so one odd question cannot make the guest's link fail. */
function clampQuestion(q: QuestionView): QuestionView {
  return {
    id: clip(q.id, 64),
    agent: clip(q.agent, 64),
    message: clip(q.message, 4000),
    fields: q.fields.slice(0, 8).map((f) => ({
      ...f,
      key: clip(f.key, 64) || '_',
      label: clip(f.label, 500),
      options: f.options.slice(0, 32).map((o) => ({
        value: clip(o.value, 500),
        label: clip(o.label, 500),
        ...(o.description === undefined ? {} : { description: clip(o.description, 1000) }),
      })),
      ...(f.recommended === undefined ? {} : { recommended: clip(f.recommended, 500) }),
    })),
  }
}

/**
 * Shared agent sessions. The host's Agents room is the session: invited contacts watch it (`view`) or also
 * message the agents and answer their questions (`control`). Agents only ever run on the host. Guests are
 * identified by the authenticated link (`PeerLink.pk`); every frame is gated on the `collab` capability.
 */
export class AgentShare {
  private readonly guestFile: string
  private readonly hostFile: string
  private readonly guestList: Map<string, Member>
  private readonly hostList: Map<string, Member>
  private readonly mirrors = new Map<string, Mirror>()
  private readonly sent = new Map<string, Map<number, string>>()
  private readonly meta = new Map<string, string>()
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private readonly onChange = (): void => this.schedule()

  constructor(private readonly p: SharePorts) {
    this.guestFile = path.join(p.dir, 'agent-guests.json')
    this.hostFile = path.join(p.dir, 'agent-shared.json')
    this.guestList = readMembers(this.guestFile, 'guests')
    this.hostList = readMembers(this.hostFile, 'hosts')
    p.orch.on('change', this.onChange)
    p.orch.questions.on('change', this.onChange)
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.p.orch.off('change', this.onChange)
    this.p.orch.questions.off('change', this.onChange)
  }

  // ------------------------------------------------------------------ host

  guests(): GuestView[] {
    return [...this.guestList].map(([pk, m]) => ({ pk, name: m.name, access: m.access, state: m.state, online: this.p.link(pk) !== undefined }))
  }

  invite(pk: string, access: ShareAccess): string | undefined {
    const name = this.p.nameOf(pk)
    if (!this.p.isContact(pk)) return `${name} is not a contact`
    const existing = this.guestList.get(pk)
    if (existing?.state === 'joined') return `${name} is already in your agent session`
    if (existing === undefined && this.guestList.size >= MAX_GUESTS) return `Your agent session holds at most ${MAX_GUESTS} guests`
    const link = this.p.link(pk)
    if (link === undefined) return `${name} is offline: invites go out while you are both online`
    if (!link.hello.caps.includes(CAP)) return `${name} runs a pager without shared sessions: ask them to update`
    this.guestList.set(pk, { name, access, state: 'invited' })
    this.saveGuests()
    this.sendInvite(link, access)
    this.p.changed()
    return undefined
  }

  kick(target: string): string | undefined {
    const pks = target === 'all' ? [...this.guestList.keys()] : [target]
    if (pks.length === 0 || (target !== 'all' && !this.guestList.has(target))) return 'nobody to remove'
    for (const pk of pks) {
      this.endFor(pk, 'removed by host')
      this.guestList.delete(pk)
      this.sent.delete(pk)
      this.meta.delete(pk)
    }
    this.saveGuests()
    this.p.changed()
    return undefined
  }

  private sendInvite(link: PeerLink, access: ShareAccess): void {
    link.send({ t: 'collab-invite', access, title: `${clip(this.p.me.name, 50)}'s agents` })
  }

  private saveGuests(): void {
    writeMembers(this.guestFile, 'guests', this.guestList)
  }

  private endFor(pk: string, reason: string): void {
    const link = this.p.link(pk)
    if (link?.hello.caps.includes(CAP) === true) link.send({ t: 'collab-end', reason })
  }

  private hostJoin(link: PeerLink): void {
    const guest = this.guestList.get(link.pk)
    if (guest === undefined) return void link.send({ t: 'collab-end', reason: 'not invited' })
    if (guest.state !== 'joined') {
      guest.state = 'joined'
      this.saveGuests()
      this.p.announce('success', `${guest.name} joined your agent session (${guest.access})`, guest.name)
    }
    this.flush(link.pk, true)
    this.p.changed()
  }

  private hostSay(link: PeerLink, frame: Extract<Frame, { t: 'collab-say' }>): void {
    const guest = this.guestList.get(link.pk)
    if (guest === undefined) return void link.send({ t: 'collab-end', reason: 'not invited' })
    if (guest.state !== 'joined' || guest.access !== 'control') return
    const actor: Actor = { label: this.p.orch.guestLabel(guest.name, link.pk), pk: link.pk }
    const text = cleanText(frame.text)
    const refused = this.p.orch.sayAsGuest(text, frame.tab, actor)
    if (refused === undefined) this.p.announce('info', `${actor.label}: ${clip(text, 80)}`, actor.label)
  }

  private hostAnswer(link: PeerLink, frame: Extract<Frame, { t: 'collab-answer' }>): void {
    const guest = this.guestList.get(link.pk)
    if (guest?.state !== 'joined' || guest.access !== 'control') return
    this.p.orch.questions.answer(frame.id, frame.answers)
  }

  private schedule(): void {
    if (this.closed || this.guestList.size === 0 || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const [pk, m] of this.guestList) if (m.state === 'joined') this.flush(pk, false)
    }, SYNC_DEBOUNCE_MS)
    this.timer.unref()
  }

  private wireEntry(e: RoomEntry): CollabEntry {
    const role = e.author === 'you' ? 'host' : e.pk !== undefined ? 'guest' : e.author === 'pager' ? 'pager' : 'agent'
    return {
      n: e.n,
      ts: e.ts,
      author: role === 'host' ? clip(this.p.me.name, 64) : clip(e.author, 64) || '?',
      role,
      ...(e.pk === undefined ? {} : { pk: e.pk }),
      kind: e.kind,
      text: clip(e.text, ENTRY_CHARS),
      ...(e.to === undefined ? {} : { to: e.to.slice(0, 16).map((t) => clip(t, 64)) }),
    }
  }

  /** Sends one guest whatever changed since the last sync (everything recent when `reset`). */
  private flush(pk: string, reset: boolean): void {
    const link = this.p.link(pk)
    if (this.guestList.get(pk)?.state !== 'joined' || link?.hello.caps.includes(CAP) !== true) return
    if (reset) {
      this.sent.delete(pk)
      this.meta.delete(pk)
    }
    const sent = this.sent.get(pk) ?? new Map<number, string>()
    this.sent.set(pk, sent)
    const all = this.p.orch.entries()
    const cut = reset ? Math.max(0, all.length - RESET_ENTRIES) : 0
    for (const e of all.slice(0, cut)) sent.set(e.n, clip(e.text, ENTRY_CHARS))
    const fresh = all.slice(cut).map((e) => this.wireEntry(e)).filter((e) => sent.get(e.n) !== e.text)
    const room = this.p.orch.room()
    const metaFrame = {
      agents: room.agents.map((a) => ({ name: a.name, cli: clip(a.cli, 32), state: a.state, task: clip(a.task, 200), ...(a.color === undefined ? {} : { color: clip(a.color, 32) }) })),
      questions: this.p.orch.questions.views().map(clampQuestion),
      guests: this.guests().map((g) => ({ pk: g.pk, name: clip(g.name, 64), access: g.access, online: g.online })),
    }
    const metaJson = JSON.stringify(metaFrame)
    const metaChanged = metaJson !== this.meta.get(pk)
    if (fresh.length === 0 && !metaChanged && !reset) return
    const chunks: CollabEntry[][] = []
    let cur: CollabEntry[] = []
    let bytes = 0
    for (const e of fresh) {
      const size = Buffer.byteLength(JSON.stringify(e))
      if (cur.length > 0 && (cur.length >= CHUNK_ENTRIES || bytes + size > CHUNK_BYTES)) {
        chunks.push(cur)
        cur = []
        bytes = 0
      }
      cur.push(e)
      bytes += size
    }
    chunks.push(cur)
    chunks.forEach((entries, i) => {
      const last = i === chunks.length - 1
      const frame: SyncFrame = { t: 'collab-sync', reset: reset && i === 0, host: clip(this.p.me.name, 64), entries, ...(last && (metaChanged || reset) ? metaFrame : {}) }
      if (!link.send(frame)) return
      for (const e of entries) sent.set(e.n, e.text)
      if (last && (metaChanged || reset)) this.meta.set(pk, metaJson)
    })
  }

  // ----------------------------------------------------------------- guest

  sessions(): SharedView[] {
    return [...this.hostList]
      .filter(([, m]) => m.state === 'joined')
      .map(([pk, m]) => {
        const mirror = this.mirrors.get(pk)
        return {
          pk,
          name: mirror?.host ?? m.name,
          access: m.access,
          connected: this.p.link(pk) !== undefined,
          unread: mirror?.unread ?? 0,
          asking: m.access === 'control' && (mirror?.questions.length ?? 0) > 0,
        }
      })
  }

  /** Invites waiting for an answer, oldest first. */
  invites(): { pk: string; name: string; access: ShareAccess }[] {
    return [...this.hostList].filter(([, m]) => m.state === 'invited').map(([pk, m]) => ({ pk, name: m.name, access: m.access }))
  }

  room(hostPk: string): SharedRoom | undefined {
    const m = this.hostList.get(hostPk)
    if (m?.state !== 'joined') return undefined
    const mirror = this.mirrors.get(hostPk)
    const agents: AgentView[] = (mirror?.agents ?? []).map((a) => ({ name: a.name, cli: a.cli, state: a.state, task: a.task, unread: 0, ...(a.color === undefined ? {} : { color: a.color }) }))
    return { host: mirror?.host ?? m.name, access: m.access, connected: this.p.link(hostPk) !== undefined, agents, questions: mirror?.questions ?? [], guests: mirror?.guests ?? [] }
  }

  accept(hostPk: string): string | undefined {
    const m = this.hostList.get(hostPk)
    if (m?.state !== 'invited') return 'no such invite'
    const link = this.p.link(hostPk)
    if (link?.hello.caps.includes(CAP) !== true) return `${m.name} is offline: you can join while you are both online`
    m.state = 'joined'
    this.saveHosts()
    link.send({ t: 'collab-join' })
    this.p.changed()
    return undefined
  }

  /** Declines an invite or leaves a joined session. */
  decline(hostPk: string): void {
    if (!this.hostList.has(hostPk)) return
    const link = this.p.link(hostPk)
    if (link?.hello.caps.includes(CAP) === true) link.send({ t: 'collab-leave' })
    this.hostList.delete(hostPk)
    this.mirrors.delete(hostPk)
    this.saveHosts()
    this.p.changed()
  }

  /** Why a guest cannot act right now, or undefined. */
  private cannotAct(hostPk: string): string | undefined {
    const m = this.hostList.get(hostPk)
    if (m?.state !== 'joined') return 'not in that session'
    if (m.access === 'view') return 'view only: the host invited you to watch'
    if (this.p.link(hostPk)?.hello.caps.includes(CAP) !== true) return `${this.mirrors.get(hostPk)?.host ?? m.name} is offline`
    return undefined
  }

  say(hostPk: string, text: string, tab?: string): string | undefined {
    const why = this.cannotAct(hostPk)
    if (why !== undefined) return why
    if (text.trim() === '') return 'empty message'
    this.p.link(hostPk)?.send({ t: 'collab-say', text: text.slice(0, 4000), ...(tab === undefined ? {} : { tab }) })
    return undefined
  }

  answer(hostPk: string, id: string, answers: AnswerMap | null): string | undefined {
    const why = this.cannotAct(hostPk)
    if (why !== undefined) return why
    this.p.link(hostPk)?.send({ t: 'collab-answer', id, answers })
    return undefined
  }

  markRead(hostPk: string): void {
    const mirror = this.mirrors.get(hostPk)
    if (mirror === undefined || mirror.unread === 0) return
    mirror.unread = 0
    this.p.changed()
  }

  messages(hostPk: string, limit: number): MessageView[] {
    const mirror = this.mirrors.get(hostPk)
    const joined = this.hostList.get(hostPk)
    if (joined?.state === 'joined' && (mirror?.entries.length ?? 0) === 0) {
      const host = mirror?.host ?? joined.name
      const text =
        this.p.link(hostPk) === undefined
          ? `${host} is offline: the session continues when they are back.`
          : joined.access === 'view'
            ? `Joined ${host}'s agent session. You are watching: replies appear here.`
            : `Joined ${host}'s agent session. Ask with @name <task>: the replies appear here.`
      return [{ key: 'shared:welcome', ts: Date.now(), authorName: 'pager', authorKey: hostPk, mine: false, kind: 'system', text, status: null }]
    }
    return (mirror?.entries ?? []).slice(-limit).map((e) => ({
      key: `shared:${e.n}`,
      ts: e.ts,
      authorName: e.author,
      authorKey: e.pk ?? (e.role === 'host' ? hostPk : authorKeyOf(e.author)),
      mine: e.role === 'guest' && e.pk === this.p.me.pk,
      agent: e.role === 'agent',
      kind: e.kind,
      text: e.text,
      status: null,
      markdown: e.role === 'agent' && e.kind === 'text',
    }))
  }

  private saveHosts(): void {
    writeMembers(this.hostFile, 'hosts', this.hostList)
  }

  private guestInvite(link: PeerLink, frame: Extract<Frame, { t: 'collab-invite' }>): void {
    if (!this.p.isContact(link.pk)) return
    const existing = this.hostList.get(link.pk)
    if (existing?.state === 'joined') {
      existing.access = frame.access
      this.saveHosts()
      link.send({ t: 'collab-join' })
      return this.p.changed()
    }
    if (existing === undefined && this.hostList.size >= MAX_HOSTS) return
    const name = this.p.nameOf(link.pk)
    this.hostList.set(link.pk, { name, access: frame.access, state: 'invited' })
    this.saveHosts()
    if (existing === undefined) this.p.announce('info', `${name} invited you to their agent session (${frame.access}). /accept ${this.p.acceptNumber(link.pk)}`, name)
    this.p.changed()
  }

  private guestSync(link: PeerLink, frame: SyncFrame): void {
    if (this.hostList.get(link.pk)?.state !== 'joined') return
    const mirror = this.mirrors.get(link.pk) ?? { host: frame.host, entries: [], agents: [], questions: [], guests: [], unread: 0 }
    this.mirrors.set(link.pk, mirror)
    mirror.host = frame.host
    if (frame.reset) {
      mirror.entries = []
      mirror.unread = 0
    }
    const active = this.p.isActive(link.pk)
    for (const e of frame.entries) {
      const entry = { ...e, author: cleanText(e.author), text: cleanText(e.text) }
      const at = mirror.entries.findIndex((x) => x.n === e.n)
      if (at >= 0) mirror.entries[at] = entry
      else {
        mirror.entries.push(entry)
        if (!active && !frame.reset && e.role !== 'host' && !(e.role === 'guest' && e.pk === this.p.me.pk)) mirror.unread++
      }
    }
    mirror.entries.sort((a, b) => a.n - b.n)
    if (mirror.entries.length > MIRROR_ENTRIES) mirror.entries.splice(0, mirror.entries.length - MIRROR_ENTRIES)
    if (frame.agents !== undefined) mirror.agents = frame.agents.map((a) => ({ ...a, task: cleanText(a.task) }))
    if (frame.questions !== undefined) mirror.questions = frame.questions.map((q) => ({ ...q, message: cleanText(q.message) }))
    if (frame.guests !== undefined) mirror.guests = frame.guests
    this.p.changed()
  }

  private guestEnd(link: PeerLink, reason: string): void {
    const m = this.hostList.get(link.pk)
    if (m === undefined) return
    this.hostList.delete(link.pk)
    this.mirrors.delete(link.pk)
    this.saveHosts()
    this.p.toast('warn', `${m.name} ended the shared agent session: ${reason}`)
    this.p.changed()
  }

  // ------------------------------------------------------------- transport

  onOpen(link: PeerLink): void {
    if (!link.hello.caps.includes(CAP)) return
    const guest = this.guestList.get(link.pk)
    if (guest?.state === 'invited') this.sendInvite(link, guest.access)
    if (this.hostList.get(link.pk)?.state === 'joined') link.send({ t: 'collab-join' })
  }

  onClose(pk: string): void {
    this.sent.delete(pk)
    this.meta.delete(pk)
    if (this.guestList.has(pk) || this.hostList.has(pk)) this.p.changed()
    if (this.guestList.size > 0) this.schedule()
  }

  onFrame(link: PeerLink, frame: Frame): void {
    if (!link.hello.caps.includes(CAP)) return
    switch (frame.t) {
      case 'collab-invite':
        return this.guestInvite(link, frame)
      case 'collab-join':
        return this.hostJoin(link)
      case 'collab-leave':
        if (this.guestList.delete(link.pk)) {
          this.sent.delete(link.pk)
          this.saveGuests()
          this.p.changed()
        }
        return
      case 'collab-end':
        return this.guestEnd(link, frame.reason)
      case 'collab-say':
        return this.hostSay(link, frame)
      case 'collab-answer':
        return this.hostAnswer(link, frame)
      case 'collab-sync':
        return this.guestSync(link, frame)
      default:
    }
  }
}
