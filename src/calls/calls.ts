import type { Frame } from '../net/wire.js'
import { peak, type AudioIo, type Mic, type Speaker } from './audio.js'

type CallFrame = Extract<Frame, { t: 'call' | 'call-audio' }>

/** Quieter chunks than this (of 32768) are silence: not sent, so an idle call costs nothing. */
const SILENCE = 600
/** Someone counts as speaking this long after their last loud chunk. */
const SPEAKING_MS = 500
/** How often the speaking marks are re-checked while in a call. */
const TICK_MS = 250

export interface CallDeps {
  me: string
  /** A sender to a peer whose link is open and speaks calls; undefined otherwise. */
  link(pk: string): { send(frame: Frame): boolean } | undefined
  /** The other members of an active conversation, or undefined when it is not one I can call in. */
  members(conv: string): string[] | undefined
  /** The microphone and speakers, or why there are none. */
  audio(): Promise<AudioIo | string>
  /** `pk` joined a room I am not in; `started` when nobody was in it before. */
  ring(conv: string, room: string, pk: string, started: boolean): void
  changed(): void
}

export interface CallRoom {
  room: string
  /** Who is in it (me included when I am), in joining order. */
  people: string[]
  mine: boolean
}

export interface MyCall {
  conv: string
  room: string
  muted: boolean
  /** Everyone in the room (me first) and whether they are talking right now. */
  people: { pk: string; speaking: boolean }[]
}

const keyOf = (conv: string, room: string): string => `${conv}\n${room}`

/**
 * Voice call rooms on top of the peer links: a DM has one room, a group any number. Presence (`call` frames) goes to
 * every online member of the conversation; sound (`call-audio`) only to the people in my room, one stream each way per
 * pair (a mesh). The OS mixes the speakers: each person heard gets a playback process of their own.
 */
export class Calls {
  /** Other people per room (never me). */
  private readonly rooms = new Map<string, string[]>()
  private mine: { conv: string; room: string; mic: Mic; muted: boolean } | undefined
  private readonly speakers = new Map<string, Speaker>()
  private readonly loud = new Map<string, number>()
  private io: AudioIo | undefined
  private tick: NodeJS.Timeout | undefined
  private shown = ''

  constructor(private readonly deps: CallDeps) {}

  current(): MyCall | undefined {
    if (this.mine === undefined) return undefined
    const { conv, room, muted } = this.mine
    const now = Date.now()
    const speaking = (pk: string): boolean => now - (this.loud.get(pk) ?? 0) < SPEAKING_MS
    return { conv, room, muted, people: [this.deps.me, ...(this.rooms.get(keyOf(conv, room)) ?? [])].map((pk) => ({ pk, speaking: speaking(pk) })) }
  }

  /** The rooms of a conversation that someone is in. */
  roomsIn(conv: string): CallRoom[] {
    const out = new Map<string, CallRoom>()
    for (const [key, people] of this.rooms) {
      const [c = '', room = ''] = key.split('\n')
      if (c === conv && people.length > 0) out.set(room, { room, people: [...people], mine: false })
    }
    if (this.mine?.conv === conv) {
      const { room } = this.mine
      out.set(room, { room, people: [this.deps.me, ...(out.get(room)?.people ?? [])], mine: true })
    }
    return [...out.values()]
  }

  /** Joins (or starts) a room, leaving any other call. Returns why it could not, or undefined. */
  async join(conv: string, room: string): Promise<string | undefined> {
    const members = this.deps.members(conv)
    if (members === undefined) return 'This conversation is not active'
    if (this.mine?.conv === conv && this.mine.room === room) return 'You are already in this call'
    const io = this.io ?? (await this.deps.audio())
    if (typeof io === 'string') return io
    this.io = io
    this.leave()
    this.mine = { conv, room, muted: false, mic: io.mic((pcm) => this.send(pcm)) }
    for (const pk of members) this.deps.link(pk)?.send({ t: 'call', conv, room, op: 'join' })
    this.tick = setInterval(() => this.refresh(), TICK_MS)
    this.tick.unref()
    this.deps.changed()
    return undefined
  }

  /** Leaves my call. False when I was in none. */
  leave(): boolean {
    const mine = this.mine
    if (mine === undefined) return false
    this.mine = undefined
    mine.mic.stop()
    for (const s of this.speakers.values()) s.stop()
    this.speakers.clear()
    this.loud.clear()
    clearInterval(this.tick)
    for (const pk of this.deps.members(mine.conv) ?? []) this.deps.link(pk)?.send({ t: 'call', conv: mine.conv, room: mine.room, op: 'leave' })
    this.deps.changed()
    return true
  }

  /** Mutes or unmutes my microphone; undefined when not in a call. */
  toggleMute(): boolean | undefined {
    if (this.mine === undefined) return undefined
    this.mine.muted = !this.mine.muted
    this.deps.changed()
    return this.mine.muted
  }

  onFrame(pk: string, frame: CallFrame): void {
    if (this.deps.members(frame.conv)?.includes(pk) !== true) return
    const key = keyOf(frame.conv, frame.room)
    if (frame.t === 'call-audio') {
      if (this.mine === undefined || keyOf(this.mine.conv, this.mine.room) !== key || this.rooms.get(key)?.includes(pk) !== true) return
      const pcm = Buffer.from(frame.d, 'base64')
      let speaker = this.speakers.get(pk)
      if (speaker === undefined && this.io !== undefined) {
        speaker = this.io.speaker()
        this.speakers.set(pk, speaker)
      }
      speaker?.write(pcm)
      if (peak(pcm) >= SILENCE) this.loud.set(pk, Date.now())
      return
    }
    this.drop(pk)
    if (frame.op === 'join') {
      const people = this.rooms.get(key) ?? []
      const started = people.length === 0
      this.rooms.set(key, [...people, pk])
      if (this.mine === undefined || keyOf(this.mine.conv, this.mine.room) !== key) this.deps.ring(frame.conv, frame.room, pk, started)
    }
    this.deps.changed()
  }

  /** A link opened: tell that member which room of theirs I am in. */
  onOpen(pk: string): void {
    const mine = this.mine
    if (mine !== undefined && this.deps.members(mine.conv)?.includes(pk) === true) this.deps.link(pk)?.send({ t: 'call', conv: mine.conv, room: mine.room, op: 'join' })
  }

  /** A link closed: whoever was on it is out of every room. */
  onClose(pk: string): void {
    if (this.drop(pk)) this.deps.changed()
  }

  /** Leaves a conversation's call (it was left or removed). */
  forget(conv: string): void {
    if (this.mine?.conv === conv) this.leave()
    for (const key of [...this.rooms.keys()]) if (key.startsWith(`${conv}\n`)) this.rooms.delete(key)
  }

  close(): void {
    this.leave()
  }

  /** Takes `pk` out of every room and stops their sound. True when they were in one. */
  private drop(pk: string): boolean {
    let was = false
    for (const [key, people] of this.rooms) {
      if (!people.includes(pk)) continue
      was = true
      const left = people.filter((p) => p !== pk)
      if (left.length === 0) this.rooms.delete(key)
      else this.rooms.set(key, left)
    }
    this.speakers.get(pk)?.stop()
    this.speakers.delete(pk)
    this.loud.delete(pk)
    return was
  }

  private send(pcm: Buffer): void {
    const mine = this.mine
    if (mine === undefined || mine.muted || peak(pcm) < SILENCE) return
    this.loud.set(this.deps.me, Date.now())
    const d = pcm.toString('base64')
    for (const pk of this.rooms.get(keyOf(mine.conv, mine.room)) ?? []) this.deps.link(pk)?.send({ t: 'call-audio', conv: mine.conv, room: mine.room, d })
  }

  /** Redraws only when someone starts or stops talking. */
  private refresh(): void {
    const now = this.current()?.people.filter((p) => p.speaking).map((p) => p.pk).join(',') ?? ''
    if (now === this.shown) return
    this.shown = now
    this.deps.changed()
  }
}
