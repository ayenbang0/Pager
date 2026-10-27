import { setTimeout as sleep } from 'node:timers/promises'
import { acquireLock, AlreadyRunningError, HANDOFF_SETTLE_MS } from '../platform/lock.js'
import { resolvePaths, tryConnect } from './client.js'

/** The lock is held by this machine's session daemon (the chat engine of a desktop window) and it would not hand it over. */
export class HeldByDaemonError extends AlreadyRunningError {}

export interface HandoffOptions {
  /** The daemon's pipe or socket; default the one for `dir`. */
  address?: string
  /** How long to keep trying for the lock after the daemon says it let go. Default `HANDOFF_SETTLE_MS`. */
  settleMs?: number
}

/** Asks the daemon at `address` to close its chat engine. True once it has; false when the lock's holder is not that daemon or it cannot. */
async function askDaemon(holder: number, address: string): Promise<{ daemon: boolean; yielded: boolean }> {
  const client = await tryConnect(address, { client: 'cli', name: 'pager', timeoutMs: 1500 })
  if (client === undefined || client.pid !== holder) {
    client?.close()
    return { daemon: false, yielded: false }
  }
  try {
    const r = await client.call<{ yielded?: boolean }>('chats.yield', {}, 15_000)
    return { daemon: true, yielded: r.yielded === true }
  } catch {
    // A daemon from before `chats.yield` refuses the request; it still holds the lock.
    return { daemon: true, yielded: false }
  } finally {
    client.close()
  }
}

/**
 * `acquireLock`, except that a lock held by this machine's session daemon is asked for instead of refused. The daemon runs a chat
 * engine for the desktop's Chats block and keeps it after the block closes; it closes the engine, releases the lock before it
 * answers, and reconnects chat by itself once the caller quits. A lock held by anything else is still `AlreadyRunningError`.
 */
export async function acquireLockOrAskDaemon(dir: string, opts: HandoffOptions = {}): Promise<() => void> {
  try {
    return acquireLock(dir)
  } catch (err) {
    if (!(err instanceof AlreadyRunningError)) throw err
    const asked = await askDaemon(err.pid, opts.address ?? resolvePaths({ dir }).address)
    if (!asked.daemon) throw err
    if (!asked.yielded) throw new HeldByDaemonError(err.pid)
  }
  // The daemon let go before it answered and stays off the lock for HANDOFF_SETTLE_MS; the retries cover a file system that lags behind.
  const until = Date.now() + (opts.settleMs ?? HANDOFF_SETTLE_MS)
  for (;;) {
    try {
      return acquireLock(dir)
    } catch (err) {
      if (!(err instanceof AlreadyRunningError) || Date.now() >= until) throw err
      await sleep(50)
    }
  }
}
