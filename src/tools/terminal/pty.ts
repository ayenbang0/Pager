import { EventEmitter } from 'node:events'
import type { IPty } from '@lydell/node-pty'
import { VERSION } from '../../app/version.js'
import { BlockTracker, type CommandBlock } from './blocks.js'
import type { InputModes } from './keys.js'
import { readScreen, type ScreenView } from './screen.js'
import type { ShellSpec } from './shell.js'
import { newTerm, type XTerm } from './xterm.js'

export interface PtyOptions {
  cwd: string
  cols: number
  rows: number
  shell: ShellSpec
  env: NodeJS.ProcessEnv
}

const SCROLLBACK = 5000
const THROTTLE_MS = 33

/** One shell on a PTY, rendered by a headless xterm. Emits 'change' (throttled) and 'finished' (CommandBlock). */
export class PtySession extends EventEmitter {
  readonly blocks: BlockTracker
  private exitInfo: { code: number } | null = null
  private heading = ''
  private hidden = false
  private timer: NodeJS.Timeout | undefined
  private dead = false

  private constructor(
    private readonly pty: IPty,
    private readonly term: XTerm,
    readonly shell: ShellSpec,
    private readonly dir: string,
  ) {
    super()
    this.blocks = new BlockTracker(term)
    this.blocks.on('finished', (b: CommandBlock) => this.emit('finished', b))
    // The child asks the terminal questions (cursor position, device attributes); ConPTY stalls startup without answers.
    term.onData((d) => this.send(d))
    term.onTitleChange((t) => {
      this.heading = t
      this.touch()
    })
    // Cursor visibility is not exposed by xterm's public API: observe DECTCEM and let default handling run.
    const track = (hide: boolean) => (params: (number | number[])[]): boolean => {
      if (params.includes(25)) this.hidden = hide
      return false
    }
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, track(false))
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, track(true))
    pty.onData((d) => term.write(d, () => this.touch()))
    pty.onExit((e) => {
      this.exitInfo = { code: e.exitCode }
      this.touch()
    })
  }

  static async start(o: PtyOptions): Promise<PtySession> {
    // Native addon: loaded only when a terminal starts so `pager --help`/`update` never touch it (same rule as cli.tsx).
    const { spawn } = await import('@lydell/node-pty')
    const term = newTerm({ cols: o.cols, rows: o.rows, scrollback: SCROLLBACK, allowProposedApi: true })
    try {
      const pty = spawn(o.shell.file, o.shell.args, {
        name: 'xterm-256color',
        cols: o.cols,
        rows: o.rows,
        cwd: o.cwd,
        env: { ...o.env, ...o.shell.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'pager', TERM_PROGRAM_VERSION: VERSION },
      })
      return new PtySession(pty, term, o.shell, o.cwd)
    } catch (e) {
      term.dispose()
      throw e
    }
  }

  get cwd(): string {
    return this.blocks.cwd() ?? this.dir
  }

  get title(): string {
    return this.heading
  }

  get exit(): { code: number } | null {
    return this.exitInfo
  }

  get modes(): InputModes {
    return { appCursor: this.term.modes.applicationCursorKeysMode, focus: this.term.modes.sendFocusMode }
  }

  write(data: string): void {
    this.term.scrollToBottom()
    this.send(data)
  }

  paste(text: string): void {
    this.write(this.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text)
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(2, Math.floor(cols))
    const r = Math.max(1, Math.floor(rows))
    if (c === this.term.cols && r === this.term.rows) return
    if (!this.dead && this.exitInfo === null) this.pty.resize(c, r)
    this.term.resize(c, r)
    this.touch()
  }

  /** Positive scrolls up. */
  scroll(lines: number): void {
    this.term.scrollLines(-lines)
    this.touch()
  }

  scrollTo(line: number): void {
    this.term.scrollToLine(line)
    this.touch()
  }

  scrollToBottom(): void {
    this.term.scrollToBottom()
    this.touch()
  }

  screen(): ScreenView {
    return readScreen(this.term, this.hidden, this.heading)
  }

  kill(): void {
    if (this.dead) return
    this.dead = true
    clearTimeout(this.timer)
    this.timer = undefined
    try {
      this.pty.kill()
    } catch {
      /* already gone */
    }
    this.term.dispose()
    this.removeAllListeners()
  }

  private send(data: string): void {
    if (this.dead || this.exitInfo !== null) return
    this.pty.write(data)
  }

  private touch(): void {
    if (this.dead || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.emit('change')
    }, THROTTLE_MS)
  }
}
