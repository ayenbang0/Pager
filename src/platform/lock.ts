import fs from 'node:fs'
import path from 'node:path'

export class AlreadyRunningError extends Error {
  constructor(public pid: number) {
    super(`pager is already running (pid ${pid})`)
  }
}

/** How long a process that asked the session daemon to let go of the lock has to take it before the daemon may take it back. */
export const HANDOFF_SETTLE_MS = 3000

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = exists but not ours; only ESRCH proves it is gone.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Lock younger than this may still be mid-creation by another process. */
const FRESH_LOCK_MS = 2000

type LockState = { kind: 'gone' } | { kind: 'held'; pid: number } | { kind: 'stale' } | { kind: 'fresh-unparsed' }

function inspectLock(file: string): LockState {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    if (Number.isInteger(pid) && pid > 0) return pidAlive(pid) ? { kind: 'held', pid } : { kind: 'stale' }
    // Empty/garbled: the owner may be between openSync('wx') and writeSync.
    return Date.now() - fs.statSync(file).mtimeMs < FRESH_LOCK_MS ? { kind: 'fresh-unparsed' } : { kind: 'stale' }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'gone' }
    throw err
  }
}

/** Creates `<dir>/pager.lock`. Returns an idempotent release function. */
export function acquireLock(dir: string): () => void {
  const file = path.join(dir, 'pager.lock')
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx')
      try {
        fs.writeSync(fd, String(process.pid))
      } finally {
        fs.closeSync(fd)
      }
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const state = inspectLock(file)
      if (attempt < 3 && (state.kind === 'gone' || state.kind === 'stale')) {
        if (state.kind === 'stale') {
          try {
            fs.rmSync(file, { force: true })
          } catch {
            // Held open by something else just now; the next pass finds it stale again, then reports "already running".
          }
        }
        continue
      }
      throw new AlreadyRunningError(state.kind === 'held' ? state.pid : 0)
    }
  }
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    process.removeListener('exit', release)
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // The process is ending; a lock file left behind reads as stale (its pid is gone) at the next start.
    }
  }
  process.on('exit', release)
  return release
}
