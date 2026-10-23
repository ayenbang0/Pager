import fs from 'node:fs'

/** The part of `fs.rmSync` that removeTree uses; a test passes one that fails. */
export type RmFn = (target: string, options: fs.RmOptions) => void

/**
 * Deletes `target` and everything under it. Windows refuses (EPERM, EBUSY) while another process, often a virus scanner or
 * the indexer, holds a file open, so it retries for about half a second. A tree that still will not go is reported, never
 * thrown: the caller carries on and tells the user what is left. Returns why it was left behind, or undefined when it is gone.
 */
export function removeTree(target: string, rm: RmFn = fs.rmSync): string | undefined {
  try {
    rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
    return undefined
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
