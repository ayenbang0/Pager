import fs from 'node:fs'
import path from 'node:path'

export class AlreadyRunningError extends Error {
  constructor(public pid: number) {
    super(`pager is already running (pid ${pid})`)
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = exists but not ours; only ESRCH proves it is gone.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Pid recorded in the lock; undefined when the file vanished or is unparseable (stale). */
function readLockPid(file: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
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
      const pid = readLockPid(file)
      if (attempt < 3 && (pid === undefined || !pidAlive(pid))) {
        fs.rmSync(file, { force: true })
        continue
      }
      throw new AlreadyRunningError(pid ?? 0)
    }
  }
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    process.removeListener('exit', release)
    fs.rmSync(file, { force: true })
  }
  process.on('exit', release)
  return release
}
