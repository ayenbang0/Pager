import { z } from 'zod'

export const MAX_FRAME_BYTES = 262_144

const noControl = (s: string): boolean => !/\p{Cc}/u.test(s)

const pkHex = z.string().regex(/^[0-9a-f]{64}$/)
const sigHex = z.string().regex(/^[0-9a-f]{128}$/)
const convId = z.string().regex(/^(dm|grp):[0-9a-f]{32}$/)
const name = z.string().min(1).max(64).refine(noControl)
const note = z.string().max(200).refine(noControl)
const title = z.string().min(1).max(64).refine(noControl)
const body = z.string().max(4000).refine(noControl)

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
])

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
    if (!res.success) throw new ProtocolError('invalid frame')
    return res.data
  }
}
