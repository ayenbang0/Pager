import { z } from 'zod'
import { isRecord } from '../util/guards.js'

export const MAX_FRAME_BYTES = 262_144

const noControl = (s: string): boolean => !/\p{Cc}/u.test(s)

const pkHex = z.string().regex(/^[0-9a-f]{64}$/)
const sigHex = z.string().regex(/^[0-9a-f]{128}$/)
const convId = z.string().regex(/^(dm|grp):[0-9a-f]{32}$/)
const name = z.string().min(1).max(64).refine(noControl)

/** True when `s` is acceptable as a display name in a hello frame. */
export const validName = (s: string): boolean => name.safeParse(s).success
const note = z.string().max(200).refine(noControl)
const title = z.string().min(1).max(64).refine(noControl)
const body = z.string().max(4000).refine(noControl)

/** Text of a shared agent session: agents write markdown, so newlines and tabs are allowed; the receiver strips the rest with cleanText. */
const rich = (max: number) => z.string().max(max)
const short = z.string().min(1).max(64)
const access = z.enum(['view', 'control'])

/** Drops terminal control characters from text a peer sent, keeping newlines and tabs. */
export const cleanText = (s: string): string => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')

const collabEntry = z.object({
  n: z.number().int().min(1),
  ts: z.number().int().min(0),
  author: short,
  role: z.enum(['host', 'guest', 'agent', 'pager']),
  pk: pkHex.optional(),
  kind: z.enum(['text', 'system']),
  text: rich(12_000),
  to: z.array(short).max(16).optional(),
})
const collabAgent = z.object({
  name: short,
  cli: z.string().max(32),
  state: z.enum(['idle', 'working', 'asking', 'reviewing']),
  task: z.string().max(200),
  color: z.string().max(32).optional(),
})
const collabField = z.object({
  key: short,
  label: z.string().max(500),
  options: z.array(z.object({ value: z.string().max(500), label: z.string().max(500), description: z.string().max(1000).optional() })).max(32),
  multi: z.boolean(),
  recommended: z.string().max(500).optional(),
  allowOther: z.boolean(),
  kind: z.enum(['choice', 'text', 'confirm']),
})
const collabQuestion = z.object({ id: short, agent: short, message: rich(4000), fields: z.array(collabField).max(8) })
const collabGuest = z.object({ pk: pkHex, name, access, online: z.boolean() })
const answerMap = z.record(z.string().max(100), z.union([z.string().max(2000), z.array(z.string().max(2000)).max(32)]))

const wireEvent = z.object({
  author: pkHex,
  seq: z.number().int().min(1),
  ts: z.number().int().min(0),
  kind: z.enum(['text', 'member-add', 'member-leave']),
  body,
  sig: sigHex,
})

const frameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), v: z.literal(1), name, caps: z.array(z.string().max(16)).max(8).optional() }),
  z.object({ t: z.literal('contact-request'), note: note.default('') }),
  z.object({ t: z.literal('contact-accept') }),
  z.object({ t: z.literal('group-invite'), conv: convId, title, creator: pkHex }),
  z.object({
    t: z.literal('sync-state'),
    have: z
      .record(
        convId,
        z.object({ left: z.boolean(), seqs: z.record(pkHex, z.number().int().min(0)).refine((r) => Object.keys(r).length <= 64) }),
      )
      .refine((r) => Object.keys(r).length <= 500),
  }),
  z.object({ t: z.literal('events'), conv: convId, events: z.array(wireEvent).max(100) }),
  z.object({ t: z.literal('ack'), conv: convId, author: pkHex, seq: z.number().int().min(0) }),
  // The reader has seen `author`'s messages up to `seq` in `conv`. Only sent to peers whose hello lists the 'read' capability.
  z.object({ t: z.literal('read'), conv: convId, author: pkHex, seq: z.number().int().min(0) }),
  // Shared agent sessions. All of these are only sent to peers whose hello lists the 'collab' capability.
  z.object({ t: z.literal('collab-invite'), access, title }),
  z.object({ t: z.literal('collab-join') }),
  z.object({ t: z.literal('collab-leave') }),
  z.object({ t: z.literal('collab-end'), reason: note }),
  z.object({ t: z.literal('collab-say'), text: rich(4000), tab: short.optional() }),
  z.object({ t: z.literal('collab-answer'), id: short, answers: answerMap.nullable() }),
  z.object({
    t: z.literal('collab-sync'),
    reset: z.boolean(),
    host: name,
    entries: z.array(collabEntry).max(40),
    agents: z.array(collabAgent).max(16).optional(),
    questions: z.array(collabQuestion).max(16).optional(),
    guests: z.array(collabGuest).max(16).optional(),
  }),
])

export type CollabEntry = z.infer<typeof collabEntry>
export type CollabAgent = z.infer<typeof collabAgent>
export type CollabGuest = z.infer<typeof collabGuest>
export type CollabAccess = z.infer<typeof access>

export type Frame = z.infer<typeof frameSchema>

export class ProtocolError extends Error {}

export function encodeFrame(f: Frame): Buffer {
  return Buffer.from(JSON.stringify(f) + '\n', 'utf8')
}

export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0)

  /** Returns every complete validated frame; throws ProtocolError on any violation. */
  push(chunk: Buffer): Frame[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const out: Frame[] = []
    let start = 0
    for (;;) {
      const nl = this.pending.indexOf(0x0a, start)
      if (nl === -1) break
      out.push(this.parse(this.pending.subarray(start, nl)))
      start = nl + 1
    }
    this.pending = this.pending.subarray(start)
    if (this.pending.length > MAX_FRAME_BYTES) throw new ProtocolError('frame too large')
    return out
  }

  private parse(line: Buffer): Frame {
    if (line.length > MAX_FRAME_BYTES) throw new ProtocolError('frame too large')
    let json: unknown
    try {
      json = JSON.parse(line.toString('utf8'))
    } catch {
      throw new ProtocolError('invalid JSON')
    }
    const res = frameSchema.safeParse(json)
    if (!res.success) {
      const t = isRecord(json) && typeof json.t === 'string' ? json.t.slice(0, 24) : '?'
      const at = res.error.issues[0]?.path.join('.').slice(0, 40) ?? ''
      throw new ProtocolError(`invalid frame ${t} ${at}`.trimEnd())
    }
    return res.data
  }
}
