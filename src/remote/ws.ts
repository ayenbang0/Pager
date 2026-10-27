import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type net from 'node:net'

// A small RFC 6455 server: the handshake, masked client frames, fragmentation, ping/pong and close, with a hard cap on one message.
// Node ships no WebSocket server and the repo takes no dependencies for it.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OP_CONT = 0
export const OP_TEXT = 1
export const OP_BINARY = 2
export const OP_CLOSE = 8
export const OP_PING = 9
export const OP_PONG = 10

/** A protocol violation: the connection is closed with `code` (1002 protocol, 1007 bad text, 1009 too big). */
export class WsError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

export interface WsFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/**
 * Incremental frame decoder. `expectMasked` is true on a server (browsers mask every frame, an unmasked one is a violation) and
 * false on a client. A frame declaring more than `maxPayload` bytes is refused before any of it is buffered.
 */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0)

  constructor(
    private readonly maxPayload: number,
    private readonly expectMasked = true,
  ) {}

  push(chunk: Buffer): WsFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: WsFrame[] = []
    for (;;) {
      const f = this.next()
      if (f === undefined) break
      out.push(f)
    }
    return out
  }

  private next(): WsFrame | undefined {
    const b = this.buf
    if (b.length < 2) return undefined
    const b0 = b[0]!
    const b1 = b[1]!
    if ((b0 & 0x70) !== 0) throw new WsError(1002, 'reserved bits set')
    const opcode = b0 & 0x0f
    const fin = (b0 & 0x80) !== 0
    const masked = (b1 & 0x80) !== 0
    if (masked !== this.expectMasked) throw new WsError(1002, this.expectMasked ? 'a client frame must be masked' : 'a server frame must not be masked')
    let len = b1 & 0x7f
    let at = 2
    if (len === 126) {
      if (b.length < 4) return undefined
      len = b.readUInt16BE(2)
      at = 4
    } else if (len === 127) {
      if (b.length < 10) return undefined
      const big = b.readBigUInt64BE(2)
      if (big > BigInt(this.maxPayload)) throw new WsError(1009, 'the message is too large')
      len = Number(big)
      at = 10
    }
    const isControl = opcode >= 8
    if (isControl && (!fin || len > 125)) throw new WsError(1002, 'a control frame is at most 125 bytes and never fragmented')
    if (opcode !== OP_CONT && opcode !== OP_TEXT && opcode !== OP_BINARY && !isControl) throw new WsError(1002, `unknown opcode ${opcode}`)
    if (opcode > OP_PONG) throw new WsError(1002, `unknown opcode ${opcode}`)
    if (len > this.maxPayload) throw new WsError(1009, 'the message is too large')
    const need = at + (masked ? 4 : 0) + len
    if (b.length < need) return undefined
    let payload: Buffer
    if (masked) {
      const key = b.subarray(at, at + 4)
      const src = b.subarray(at + 4, need)
      payload = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i++) payload[i] = src[i]! ^ key[i & 3]!
    } else payload = Buffer.from(b.subarray(at, need))
    this.buf = b.subarray(need)
    return { fin, opcode, payload }
  }
}

/** One frame. A server sends it bare; a client (tests) passes `mask` and the payload is masked with a fresh key. */
export function encodeFrame(opcode: number, payload: Uint8Array, mask = false, fin = true): Buffer {
  const len = payload.length
  const head: number[] = [(fin ? 0x80 : 0) | opcode]
  const m = mask ? 0x80 : 0
  if (len < 126) head.push(m | len)
  else if (len < 65536) head.push(m | 126, len >> 8, len & 0xff)
  else {
    const h = Buffer.alloc(8)
    h.writeBigUInt64BE(BigInt(len))
    head.push(m | 127, ...h)
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload])
  const key = randomBytes(4)
  const body = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) body[i] = payload[i]! ^ key[i & 3]!
  return Buffer.concat([Buffer.from(head), key, body])
}

export const acceptKey = (key: string): string => createHash('sha1').update(key + GUID).digest('base64')

/** Why a handshake is refused, or undefined when it is a proper WebSocket upgrade request. */
export function upgradeProblem(req: http.IncomingMessage): string | undefined {
  if (req.method !== 'GET') return 'an upgrade is a GET'
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return 'not a websocket upgrade'
  const tokens = String(req.headers.connection ?? '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
  if (!tokens.includes('upgrade')) return 'no Connection: Upgrade'
  if (req.headers['sec-websocket-version'] !== '13') return 'only websocket version 13'
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return 'bad Sec-WebSocket-Key'
  return undefined
}

export interface WsLike extends EventEmitter {
  /** Text when a string, binary otherwise. */
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  /** Bytes queued for the peer and not yet written out. */
  readonly bufferedAmount: number
  readonly open: boolean
}

/**
 * Events: `message`(data: string | Buffer), `drain`, `close`(code: number).
 * Pings every `pingMs`; a peer that has not answered the previous one is dropped.
 */
export class WsConnection extends EventEmitter implements WsLike {
  private readonly parser: FrameParser
  private parts: Buffer[] = []
  private partsBytes = 0
  private partsOp = 0
  private closing = false
  private ended = false
  private broken = false
  private waiting = false
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly socket: net.Socket,
    head: Buffer,
    private readonly maxPayload: number,
    pingMs = 25_000,
  ) {
    super()
    this.parser = new FrameParser(maxPayload)
    socket.on('data', (c: Buffer) => this.onData(c))
    socket.on('drain', () => this.emit('drain'))
    socket.on('end', () => this.terminate(1006)) // http sockets are half-open: a peer that just vanished never closes the socket by itself
    socket.on('close', () => this.end(1006))
    socket.on('error', () => this.end(1006))
    this.timer = setInterval(() => {
      if (this.waiting) return this.terminate(1001)
      this.waiting = true
      this.raw(encodeFrame(OP_PING, Buffer.alloc(0)))
    }, pingMs)
    this.timer.unref()
    if (head.length > 0) this.onData(head)
  }

  get bufferedAmount(): number {
    return this.socket.writableLength
  }

  get open(): boolean {
    return !this.closing && !this.ended
  }

  private raw(frame: Buffer): void {
    if (!this.ended && !this.socket.destroyed) this.socket.write(frame)
  }

  send(data: string | Uint8Array): void {
    if (!this.open) return
    this.raw(typeof data === 'string' ? encodeFrame(OP_TEXT, Buffer.from(data, 'utf8')) : encodeFrame(OP_BINARY, data))
  }

  /** Starts the closing handshake; the socket is dropped when the peer answers or after a second. */
  close(code = 1000, reason = ''): void {
    if (this.closing || this.ended) return
    this.closing = true
    const text = Buffer.from(reason, 'utf8').subarray(0, 120)
    const body = Buffer.allocUnsafe(2 + text.length)
    body.writeUInt16BE(code, 0)
    text.copy(body, 2)
    this.raw(encodeFrame(OP_CLOSE, body))
    setTimeout(() => this.terminate(code), 1000).unref()
  }

  terminate(code = 1006): void {
    this.socket.destroy()
    this.end(code)
  }

  private end(code: number): void {
    if (this.ended) return
    this.ended = true
    clearInterval(this.timer)
    this.emit('close', code)
  }

  private onData(chunk: Buffer): void {
    if (this.ended || this.broken) return
    try {
      for (const f of this.parser.push(chunk)) this.onFrame(f)
    } catch (e) {
      if (!(e instanceof WsError)) throw e
      this.broken = true // nothing more is read from a connection that broke the protocol
      this.close(e.code, e.message)
    }
  }

  private onFrame(f: WsFrame): void {
    switch (f.opcode) {
      case OP_PING:
        return this.raw(encodeFrame(OP_PONG, f.payload))
      case OP_PONG:
        this.waiting = false
        return
      case OP_CLOSE: {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005
        if (!this.closing) {
          this.closing = true
          this.raw(encodeFrame(OP_CLOSE, f.payload.subarray(0, 2)))
        }
        this.socket.end()
        return this.end(code)
      }
    }
    if (this.closing) return
    if (f.opcode === OP_CONT) {
      if (this.partsOp === 0) throw new WsError(1002, 'a continuation without a message')
    } else {
      if (this.partsOp !== 0) throw new WsError(1002, 'a new message inside an unfinished one')
      this.partsOp = f.opcode
    }
    this.partsBytes += f.payload.length
    if (this.partsBytes > this.maxPayload) throw new WsError(1009, 'the message is too large')
    this.parts.push(f.payload)
    if (!f.fin) return
    const data = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts)
    const op = this.partsOp
    this.parts = []
    this.partsBytes = 0
    this.partsOp = 0
    if (op === OP_TEXT) {
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data)
      } catch {
        throw new WsError(1007, 'a text message must be UTF-8')
      }
      this.emit('message', text)
    } else this.emit('message', data)
  }
}

/** Completes the handshake on an `upgrade` socket and returns the connection. The caller has already authenticated the request. */
export function acceptUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer, maxPayload: number, pingMs?: number): WsConnection {
  const key = String(req.headers['sec-websocket-key'])
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`)
  socket.setNoDelay(true)
  return new WsConnection(socket, head, maxPayload, pingMs)
}
