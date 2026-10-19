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

function collect(stream: NodeJS.ReadableStream | null, cap: number): () => string {
  const chunks: Buffer[] = []
  let size = 0
  stream?.on('data', (c: Buffer) => {
    if (size >= cap) return
    const part = c.length > cap - size ? c.subarray(0, cap - size) : c
    chunks.push(part)
    size += part.length
  })
  return () => Buffer.concat(chunks).toString('utf8')
}

/** Spawns `bin` without a shell, in its own process group (POSIX) so killTree can reach the whole tree. `verbatim` passes Windows arguments unquoted (cmd /s /c). */
export function startProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: 'ignore' | 'pipe'; verbatim?: boolean },
): ChildProcess {
  return spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.stdin, 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: opts.verbatim,
    detached: process.platform !== 'win32',
  })
}

/** Runs `bin` without a shell; the prompt travels as one argv element. */
export function runProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onSpawn?: (child: ChildProcess) => void },
): Promise<ProcResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ProcResult>()
  const child = startProcess(bin, args, { cwd: opts.cwd, env: opts.env, stdin: 'ignore' })
  const stdout = collect(child.stdout, STDOUT_CAP)
  const stderr = collect(child.stderr, STDERR_CAP)
  let timedOut = false
  const timer =
    opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          killTree(child)
        }, opts.timeoutMs)
      : undefined
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
