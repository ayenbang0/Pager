import { setTimeout as sleep } from 'node:timers/promises'

/** Polls `cond` until truthy; throws on timeout. */
export async function waitFor(cond: () => boolean, timeoutMs = 15_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}
