import path from 'node:path'
import { HOST_FILE } from './install.js'
import type { InstallIo } from './io.js'
import { hostPaths } from './paths.js'
import { contextMenuRemove } from './registry.js'

/** Removes everything `install` added. Missing pieces are fine; the data dir is never touched except the host record. Returns what could not be removed. */
export async function uninstall(dataDir: string, io: InstallIo): Promise<string[]> {
  if (io.platform !== 'win32') throw new Error('The desktop host is Windows only')
  const p = hostPaths(io.env)
  const w = path.win32
  const problems: string[] = []
  const rm = (what: string, file: string): void => {
    try {
      io.remove(file)
    } catch (e) {
      problems.push(`${what}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  rm('fragment', p.fragmentDir)
  rm('shortcut', w.join(p.startMenu, 'Pager.lnk'))
  rm('shortcut', w.join(p.startMenu, 'Pager.cmd'))
  // reg.exe exits 1 when the key is already gone; that is the state we want.
  for (const args of contextMenuRemove()) await io.exec('reg.exe', args)
  rm('host record', path.join(dataDir, HOST_FILE))
  return problems
}
