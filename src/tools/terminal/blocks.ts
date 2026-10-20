import { EventEmitter } from 'node:events'
import type { IMarker } from '@xterm/headless'
import type { XTerm } from './xterm.js'

export interface CommandBlock {
  id: number
  command: string
  cwd: string
  startedAt: number
  endedAt: number | null
  /** null while running. */
  exit: number | null
}

interface Entry {
  block: CommandBlock
  prompt: IMarker
  /** First output line, when the output starts on the line after the marker. */
  start: IMarker
  startOffset: number
  end: IMarker | undefined
  endOffset: number
}

const MAX_BLOCKS = 200
const DEFAULT_CAP = 200_000

/** Parses OSC 7 `file://host/path` into a local path (Windows drive paths lose the leading slash). */
export function cwdFromUri(uri: string): string | undefined {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(uri)
  if (m?.[1] === undefined) return undefined
  let p: string
  try {
    p = decodeURIComponent(m[1])
  } catch {
    return undefined
  }
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p
}

/** Turns OSC 133 prompt/command/exit marks (and OSC 7 cwd) into a list of command blocks anchored to buffer lines. */
export class BlockTracker extends EventEmitter {
  private readonly entries: Entry[] = []
  private prompt: IMarker | undefined
  /** Command text reported explicitly by the shell (OSC 633;E), preferred over reading the screen. */
  private typed: string | undefined
  private input: { marker: IMarker; x: number } | undefined
  private current: Entry | undefined
  private marks = false
  private dir: string | undefined
  private nextId = 1

  constructor(
    private readonly term: XTerm,
    private readonly now: () => number = Date.now,
  ) {
    super()
    term.parser.registerOscHandler(133, (data) => {
      this.mark(data)
      return true
    })
    term.parser.registerOscHandler(7, (data) => {
      const p = cwdFromUri(data)
      if (p !== undefined) this.dir = p
      return true
    })
    term.parser.registerOscHandler(633, (data) => {
      if (data.startsWith('E;')) this.typed = Buffer.from(data.slice(2), 'base64').toString('utf8')
      return true
    })
  }

  seen(): boolean {
    return this.marks
  }

  cwd(): string | undefined {
    return this.dir
  }

  list(): readonly CommandBlock[] {
    this.prune()
    return this.entries.map((e) => e.block)
  }

  running(): CommandBlock | undefined {
    return this.current?.block
  }

  rows(id: number): { first: number; last: number } | undefined {
    this.prune()
    const e = this.entries.find((x) => x.block.id === id)
    if (e === undefined) return undefined
    return { first: e.prompt.line, last: Math.max(e.prompt.line, this.endLine(e)) }
  }

  /** Output only (between the command and the next prompt), wrapped rows rejoined; the last `maxChars` are kept. */
  text(id: number, maxChars = DEFAULT_CAP): string {
    this.prune()
    const e = this.entries.find((x) => x.block.id === id)
    if (e === undefined) return ''
    const first = e.start.line + e.startOffset
    const last = this.endLine(e)
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let y = first; y <= last; y++) {
      const line = buf.getLine(y)
      if (line === undefined) continue
      const text = line.translateToString(true)
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
      else lines.push(text)
    }
    const out = lines.join('\n')
    return out.length > maxChars ? out.slice(out.length - maxChars) : out
  }

  private cursorLine(): number {
    const buf = this.term.buffer.active
    return buf.baseY + buf.cursorY
  }

  /** Last output line, inclusive. */
  private endLine(e: Entry): number {
    if (e.end !== undefined && !e.end.isDisposed) return e.end.line + e.endOffset
    const buf = this.term.buffer.active
    return this.cursorLine() - (buf.cursorX === 0 ? 1 : 0)
  }

  private prune(): void {
    while (this.entries.length > 0 && this.entries[0]?.prompt.isDisposed === true) this.drop(0)
    while (this.entries.length > MAX_BLOCKS) this.drop(0)
  }

  private drop(i: number): void {
    const [e] = this.entries.splice(i, 1)
    if (e === undefined) return
    e.prompt.dispose()
    e.start.dispose()
    e.end?.dispose()
    if (this.current === e) this.current = undefined
  }

  private mark(data: string): void {
    if (this.term.buffer.active.type === 'alternate') return
    const [kind, arg] = data.split(';')
    this.marks = true
    if (kind === 'A') {
      this.prompt?.dispose()
      this.prompt = this.term.registerMarker(0)
    } else if (kind === 'B') {
      this.input?.marker.dispose()
      const marker = this.term.registerMarker(0)
      this.input = marker === undefined ? undefined : { marker, x: this.term.buffer.active.cursorX }
    } else if (kind === 'C') this.begin()
    else if (kind === 'D') this.finish(arg)
  }

  private begin(): void {
    if (this.current !== undefined) return
    const buf = this.term.buffer.active
    const command = this.commandText()
    if (command === '') return
    const start = this.term.registerMarker(0)
    if (start === undefined) return
    const prompt = this.prompt ?? this.term.registerMarker(0)
    if (prompt === undefined) return
    const block: CommandBlock = { id: this.nextId++, command, cwd: this.dir ?? '', startedAt: this.now(), endedAt: null, exit: null }
    const entry: Entry = { block, prompt, start, startOffset: buf.cursorX > 0 ? 1 : 0, end: undefined, endOffset: 0 }
    this.prompt = undefined
    this.entries.push(entry)
    this.current = entry
    this.prune()
  }

  private finish(arg: string | undefined): void {
    const e = this.current
    if (e === undefined) return
    const code = Number.parseInt(arg ?? '', 10)
    const buf = this.term.buffer.active
    e.end = this.term.registerMarker(0)
    e.endOffset = buf.cursorX === 0 ? -1 : 0
    e.block.exit = Number.isFinite(code) ? code : 0
    e.block.endedAt = this.now()
    this.current = undefined
    this.emit('finished', e.block)
  }

  /** The text typed between the end-of-prompt mark and the cursor. */
  private commandText(): string {
    if (this.typed !== undefined) {
      const t = this.typed.trim()
      this.typed = undefined
      return t
    }
    const input = this.input
    if (input === undefined || input.marker.isDisposed) return ''
    const buf = this.term.buffer.active
    const cur = this.cursorLine()
    const last = buf.cursorX === 0 && cur > input.marker.line ? cur - 1 : cur
    let out = ''
    for (let y = input.marker.line; y <= last; y++) {
      const line = buf.getLine(y)
      if (line === undefined) continue
      const from = y === input.marker.line ? input.x : 0
      const to = y === cur ? buf.cursorX : undefined
      const text = line.translateToString(true, from, to)
      if (line.isWrapped || out === '') out += text
      else out += `\n${text}`
    }
    return out.trim()
  }
}
