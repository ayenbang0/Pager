import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Data directory: `$PAGER_HOME` if set, else `~/.pager`. Created if missing. */
export function dataDir(): string {
  const dir = process.env.PAGER_HOME || path.join(os.homedir(), '.pager')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
