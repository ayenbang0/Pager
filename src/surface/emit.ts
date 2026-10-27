// `pager show mermaid|math|diff|image <file|-> [--title T] [--id ID] [--height ROWS]`: print a surface escape sequence
// (src/surface/protocol.ts) that the desktop terminal draws as an inline block, followed by the blank lines it covers.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { encodeSurface, MAX_PAYLOAD_BYTES, MAX_ROWS, MIN_ROWS, rowsOf, type SurfaceMessage } from './protocol.js'

export const SHOW_KINDS = ['mermaid', 'math', 'diff', 'image'] as const
export type ShowKind = (typeof SHOW_KINDS)[number]

export interface ShowArgs {
  kind: ShowKind
  /** A file path, or `-` for standard input. */
  input: string
  title?: string
  id?: string
  height?: number
}

export const SHOW_USAGE = 'usage: pager show mermaid|math|diff|image <file|-> [--title TEXT] [--id ID] [--height ROWS]'

export function parseShowArgs(argv: string[]): ShowArgs | { error: string } {
  const kind = argv[0]
  if (kind === undefined || !(SHOW_KINDS as readonly string[]).includes(kind)) return { error: `pager show needs one of: ${SHOW_KINDS.join(', ')}` }
  const out: ShowArgs = { kind: kind as ShowKind, input: '' }
  const rest: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--title' || a === '--id' || a === '--height') {
      const v = argv[++i]
      if (v === undefined) return { error: `${a} needs a value` }
      if (a === '--title') out.title = v
      else if (a === '--id') out.id = v
      else {
        if (!/^\d{1,3}$/.test(v) || +v < MIN_ROWS || +v > MAX_ROWS) return { error: `--height is a whole number of rows from ${MIN_ROWS} to ${MAX_ROWS}` }
        out.height = +v
      }
    } else if (a === '-') rest.push(a)
    else if (a.startsWith('-')) return { error: `unknown argument: ${a}` }
    else rest.push(a)
  }
  if (rest.length !== 1) return { error: 'pager show needs one file, or - to read standard input' }
  out.input = rest[0]!
  return out
}

/** png / jpeg / gif / webp by magic bytes, else undefined. */
export function imageMime(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | undefined {
  const at = (i: number, s: string): boolean => [...s].every((c, k) => bytes[i + k] === c.charCodeAt(0))
  if (bytes[0] === 0x89 && at(1, 'PNG')) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (at(0, 'GIF8')) return 'gif'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp'
  return undefined
}

/** The message for `kind` made from the input's bytes. Throws an Error whose text is for the user. */
export function buildSurface(kind: ShowKind, bytes: Buffer, extra: { id: string; title?: string; height?: number }): SurfaceMessage {
  let source: string
  if (kind === 'image') {
    const mime = imageMime(bytes)
    if (mime === undefined) throw new Error('not a png, jpeg, gif or webp image')
    source = `data:image/${mime};base64,${bytes.toString('base64')}`
  } else {
    if (bytes.includes(0)) throw new Error(`${kind} input is not text`)
    try {
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^\uFEFF/, '')
    } catch {
      throw new Error(`${kind} input is not UTF-8 text`)
    }
    if (source.trim() === '') throw new Error('input is empty')
  }
  return { kind, id: extra.id, source, ...(extra.title === undefined ? {} : { title: extra.title }), ...(extra.height === undefined ? {} : { height: extra.height }) }
}

/** The bytes to print: the escape sequence, then one CRLF per row the block covers so the scrollback has lines under it. */
export function renderShow(msg: SurfaceMessage): string {
  return encodeSurface(msg) + '\r\n'.repeat(rowsOf(msg))
}

export interface ShowIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  write(text: string): Promise<void>
  error(text: string): void
}

async function readCapped(stream: NodeJS.ReadableStream, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of stream) {
    const b = typeof c === 'string' ? Buffer.from(c) : (c as Buffer)
    n += b.length
    if (n > cap) throw new Error(`input is larger than ${cap} bytes`)
    chunks.push(b)
  }
  return Buffer.concat(chunks)
}

/** Run the command; the return value is the process exit code. */
export async function runShow(args: ShowArgs, io: ShowIo): Promise<number> {
  try {
    let bytes: Buffer
    let title = args.title
    if (args.input === '-') {
      if (io.stdin.isTTY) throw new Error('pager show - reads standard input: pipe something into it')
      bytes = await readCapped(io.stdin, MAX_PAYLOAD_BYTES)
    } else {
      const st = fs.statSync(args.input)
      if (!st.isFile()) throw new Error(`not a file: ${args.input}`)
      if (st.size > MAX_PAYLOAD_BYTES) throw new Error(`${args.input} is ${st.size} bytes; the limit is ${MAX_PAYLOAD_BYTES}`)
      bytes = fs.readFileSync(args.input)
      title ??= path.basename(args.input)
    }
    const msg = buildSurface(args.kind, bytes, { id: args.id ?? `${args.kind}-${randomBytes(4).toString('hex')}`, ...(title === undefined ? {} : { title }), ...(args.height === undefined ? {} : { height: args.height }) })
    await io.write(renderShow(msg))
    return 0
  } catch (e) {
    io.error(`pager show: ${e instanceof Error ? (e as NodeJS.ErrnoException).code === 'ENOENT' ? `no such file: ${args.input}` : e.message : String(e)}\n`)
    return 1
  }
}
