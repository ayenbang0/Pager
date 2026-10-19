import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { killTree } from '../run/process.js'
import { repoKey } from '../state/store.js'

export const VERIFY_TIMEOUT_MS = 300_000
/** Characters of output kept per run: the tail, where a failure is reported. */
export const VERIFY_OUTPUT_MAX = 20_000
const POST_LINES = 15
const POST_CHARS = 1_500
/** After the kill, how long to wait for the pipes to close before giving up on them. */
const KILL_GRACE_MS = 2_000

/** What one run of the verify command produced. */
export interface VerifyRun {
  ok: boolean
  /** Exit code; null when the command was killed or could not start. */
  code: number | null
  timedOut: boolean
  /** The last VERIFY_OUTPUT_MAX characters of stdout and stderr, without terminal escapes. */
  output: string
  /** True when earlier output was dropped. */
  truncated: boolean
  ms: number
}

/** A VerifyRun tied to the commit and command it ran for. */
export interface VerifyResult extends VerifyRun {
  sha: string
  command: string
  at: number
}

/** Runs a user-supplied command line through the shell in `cwd`; the whole process tree is killed after `timeoutMs`. Never rejects. */
export function runVerify(
  command: string,
  cwd: string,
  opts: { timeoutMs?: number; maxOutput?: number; env?: NodeJS.ProcessEnv; onSpawn?: (child: ChildProcess) => void } = {},
): Promise<VerifyRun> {
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS
  const max = opts.maxOutput ?? VERIFY_OUTPUT_MAX
  const { promise, resolve } = Promise.withResolvers<VerifyRun>()
  const started = Date.now()
  let buffer = ''
  let truncated = false
  let timedOut = false
  let settled = false
  const finish = (code: number | null, extra = ''): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(grace)
    const text = stripVTControlCharacters(buffer + extra)
    resolve({ ok: code === 0 && !timedOut, code, timedOut, output: text.slice(-max), truncated: truncated || text.length > max, ms: Date.now() - started })
  }
  const collect = (stream: NodeJS.ReadableStream | null): void => {
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > max * 2) {
        buffer = buffer.slice(-max)
        truncated = true
      }
    })
  }
  let grace: NodeJS.Timeout | undefined
  const child = spawn(command, {
    shell: true,
    cwd,
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  collect(child.stdout)
  collect(child.stderr)
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
    grace = setTimeout(() => finish(null), KILL_GRACE_MS)
  }, timeoutMs)
  child.on('error', (err) => finish(null, `${buffer === '' ? '' : '\n'}${err.message}`))
  child.on('close', (code) => finish(code))
  opts.onSpawn?.(child)
  return promise
}

/** "verify passed (3.2s)", "verify failed (exit 1, 3.2s)", "verify timed out after 5 min". */
export function verifyHeadline(r: VerifyRun, timeoutMs = VERIFY_TIMEOUT_MS): string {
  const secs = `${(r.ms / 1000).toFixed(1)}s`
  if (r.timedOut) return `verify timed out after ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.round(timeoutMs / 1000)}s`}`
  if (r.ok) return `verify passed (${secs})`
  return `verify failed (${r.code === null ? 'did not run' : `exit ${r.code}`}, ${secs})`
}

/** The last lines of the output, bounded for a chat message. */
export function outputTail(output: string, lines = POST_LINES, chars = POST_CHARS): string {
  const kept = output.trimEnd().split(/\r?\n/).slice(-lines).join('\n')
  return kept.length > chars ? `…${kept.slice(-chars + 1)}` : kept
}

/** Headline plus the output tail for a failure; a pass is just the headline. */
export function verifyReport(r: VerifyRun, timeoutMs = VERIFY_TIMEOUT_MS): string {
  const head = verifyHeadline(r, timeoutMs)
  const tail = r.ok ? '' : outputTail(r.output)
  return tail === '' ? head : `${head}\n${tail}`
}

/** One word for the board line. */
export function verifyWord(r: VerifyRun): string {
  return r.timedOut ? 'timed out' : r.ok ? 'pass' : 'fail'
}

export type MergeGate = { action: 'allow' } | { action: 'run' } | { action: 'block'; reason: string }

/**
 * Whether `/agent merge` may go ahead: no command or `--force` allows it; a result for another commit (or another command) means run it first;
 * a failed result for this commit blocks.
 */
export function mergeGate(input: { command: string | undefined; head: string; last: VerifyResult | undefined; force: boolean }): MergeGate {
  const { command, head, last, force } = input
  if (command === undefined || force) return { action: 'allow' }
  if (last === undefined || last.sha !== head || last.command !== command) return { action: 'run' }
  return last.ok ? { action: 'allow' } : { action: 'block', reason: verifyHeadline(last) }
}

/** The verify command per repository (`agents-verify.json`). */
export class VerifyStore {
  private data: Record<string, string> = {}

  constructor(private readonly file: string) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string' && value !== '') this.data[key] = value
      }
    } catch {
      // no file yet, or unreadable: no command is set
    }
  }

  get(root: string): string | undefined {
    return this.data[repoKey(root)]
  }

  /** Saves the command, or removes it with undefined. Returns an error text when it could not be written. */
  set(root: string, command: string | undefined): string | undefined {
    const key = repoKey(root)
    if (command === undefined) delete this.data[key]
    else this.data[key] = command
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
      return undefined
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
}
