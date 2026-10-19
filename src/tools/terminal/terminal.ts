import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ChildProcess } from 'node:child_process'
import { killTree, startProcess } from '../../agents/run/process.js'

export const TERM_ID = 'terminal'

const MAX_ENTRIES = 100
const MAX_LINES = 2000
const MAX_LINE_CHARS = 2000
const CHANGE_THROTTLE_MS = 80

// CSI and OSC escape sequences: colour, cursor movement, window titles.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const CD = /^cd(?:\s+\/d)?(?:\s+(.*))?$/i

export type TermState = 'running' | 'done' | 'failed' | 'stopped'

export interface TermEntry {
  n: number
  ts: number
  cwd: string
  command: string
  state: TermState
  code: number | null
  lines: string[]
  /** The unfinished last line of output. */
  partial: string
  /** Lines dropped from the top once MAX_LINES was exceeded. */
  dropped: number
}

/**
 * A command runner behind the Terminal tab. Each line runs in the platform shell in a persistent working
 * directory (`cd` is handled here); output streams in without a pseudo-terminal, so full-screen programs
 * (vim, htop) are not supported. Lines typed while a command runs go to its stdin.
 */
export class Terminal extends EventEmitter {
  private entries: TermEntry[] = []
  private child: ChildProcess | null = null
  private current: TermEntry | null = null
  private timer: NodeJS.Timeout | undefined
  private counter = 0
  cwd: string

  constructor(cwd: string) {
    super()
    this.cwd = cwd
  }

  get running(): boolean {
    return this.child !== null
  }

  list(): readonly TermEntry[] {
    return this.entries
  }

  /** Run one line, or feed it to the running command's stdin. */
  run(line: string): void {
    const command = line.trim()
    if (command === '' && this.child === null) return
    if (this.current && this.child) {
      this.child.stdin?.write(`${line}\n`)
      this.feed(this.current, `${line}\n`)
      return
    }
    const entry = this.begin(command)
    if (/^(clear|cls)$/i.test(command)) {
      this.entries = []
      this.current = null
      this.change()
      return
    }
    const cd = CD.exec(command)
    if (cd) return this.changeDir(entry, (cd[1] ?? '').trim())
    this.spawn(entry)
  }

  /** Stop the running command. Returns whether there was one. */
  stop(): boolean {
    if (!this.child || !this.current) return false
    this.current.state = 'stopped'
    killTree(this.child)
    return true
  }

  close(): void {
    this.stop()
    clearTimeout(this.timer)
  }

  private begin(command: string): TermEntry {
    const entry: TermEntry = { n: ++this.counter, ts: Date.now(), cwd: this.cwd, command, state: 'running', code: null, lines: [], partial: '', dropped: 0 }
    this.entries = [...this.entries, entry].slice(-MAX_ENTRIES)
    this.current = entry
    this.change()
    return entry
  }

  private finish(entry: TermEntry, state: TermState, code: number | null): void {
    if (entry.partial !== '') entry.lines.push(entry.partial)
    entry.partial = ''
    entry.code = code
    if (entry.state !== 'stopped') entry.state = state
    this.child = null
    this.current = null
    clearTimeout(this.timer)
    this.timer = undefined
    this.emit('change')
    this.emit('finished', entry)
  }

  private changeDir(entry: TermEntry, raw: string): void {
    const unquoted = raw.replace(/^["']|["']$/g, '')
    const target = unquoted === '' || unquoted === '~' ? os.homedir() : unquoted.startsWith('~') ? path.join(os.homedir(), unquoted.slice(1)) : unquoted
    const dir = path.resolve(this.cwd, target)
    let ok = false
    try {
      ok = fs.statSync(dir).isDirectory()
    } catch {
      // reported below
    }
    if (ok) this.cwd = dir
    entry.lines.push(ok ? dir : `cd: no such directory: ${target}`)
    this.finish(entry, ok ? 'done' : 'failed', ok ? 0 : 1)
  }

  private spawn(entry: TermEntry): void {
    const win = process.platform === 'win32'
    const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }
    let child: ChildProcess
    try {
      child = win
        ? startProcess(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"chcp 65001>nul & ${entry.command}"`], { cwd: this.cwd, env, stdin: 'pipe', verbatim: true })
        : startProcess(process.env.SHELL ?? '/bin/sh', ['-c', entry.command], { cwd: this.cwd, env, stdin: 'pipe' })
    } catch (e) {
      entry.lines.push(`could not start: ${e instanceof Error ? e.message : String(e)}`)
      this.finish(entry, 'failed', null)
      return
    }
    this.child = child
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8')
      stream?.on('data', (c: Buffer) => this.feed(entry, decoder.write(c)))
    }
    child.stdin?.on('error', () => undefined)
    child.on('error', (e) => {
      entry.lines.push(`could not start: ${e.message}`)
      this.finish(entry, 'failed', null)
    })
    child.on('close', (code) => this.finish(entry, code === 0 ? 'done' : 'failed', code))
  }

  /** Append output: escape sequences dropped, `\r` rewrites the line (progress bars), long output trimmed from the top. */
  private feed(entry: TermEntry, chunk: string): void {
    const parts = (entry.partial + chunk.replace(ANSI, '')).split('\n')
    entry.partial = parts.pop() ?? ''
    for (const part of parts) entry.lines.push(settle(part))
    entry.partial = entry.partial.length > MAX_LINE_CHARS ? entry.partial.slice(0, MAX_LINE_CHARS) : entry.partial
    const over = entry.lines.length - MAX_LINES
    if (over > 0) {
      entry.lines.splice(0, over)
      entry.dropped += over
    }
    this.change()
  }

  private change(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.emit('change')
    }, CHANGE_THROTTLE_MS)
  }
}

/** Keep what a carriage return would leave visible, and bound the line length. */
function settle(raw: string): string {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  const shown = line.slice(line.lastIndexOf('\r') + 1)
  return shown.length > MAX_LINE_CHARS ? `${shown.slice(0, MAX_LINE_CHARS)}…` : shown
}
