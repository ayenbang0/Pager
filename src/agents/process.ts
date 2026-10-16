import { spawn, type ChildProcess } from 'node:child_process'

export const STDOUT_CAP = 1_048_576
export const STDERR_CAP = 65_536

export interface ProcResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => child.kill())
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

function collect(stream: NodeJS.ReadableStream, cap: number): () => string {
  const chunks: Buffer[] = []
  let size = 0
  stream.on('data', (c: Buffer) => {
    if (size >= cap) return
    const part = c.length > cap - size ? c.subarray(0, cap - size) : c
    chunks.push(part)
    size += part.length
  })
  return () => Buffer.concat(chunks).toString('utf8')
}

/** Runs `bin` without a shell; the prompt travels as one argv element. */
export function runProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onSpawn?: (child: ChildProcess) => void },
): Promise<ProcResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ProcResult>()
  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  const stdout = collect(child.stdout, STDOUT_CAP)
  const stderr = collect(child.stderr, STDERR_CAP)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, opts.timeoutMs)
  child.on('error', (err) => {
    clearTimeout(timer)
    reject(err)
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    resolve({ code, stdout: stdout(), stderr: stderr(), timedOut })
  })
  opts.onSpawn?.(child)
  return promise
}
