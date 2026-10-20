import path from 'node:path'
import { HOST_FILE } from './install.js'
import type { InstallIo } from './io.js'
import { hostPaths } from './paths.js'
import { readHost } from './launch.js'

/** One `key: value` line per piece of the desktop host. */
export async function status(dataDir: string, io: InstallIo): Promise<string[]> {
  const p = hostPaths(io.env)
  const w = path.win32
  const have = (f: string): string => (io.exists(f) ? 'yes' : 'no')
  const rec = readHost(dataDir, io)
  const lines = [
    `windows terminal: ${io.exists(p.wt) ? p.wt : 'not installed'}`,
    `host: ${rec === undefined ? 'not installed (pager desktop install)' : rec.host}`,
    `fragment: ${have(w.join(p.fragmentDir, 'pager.json'))} (${p.fragmentDir})`,
    `shortcut: ${io.exists(w.join(p.startMenu, 'Pager.lnk')) ? 'lnk' : io.exists(w.join(p.startMenu, 'Pager.cmd')) ? 'cmd' : 'no'}`,
  ]
  const menu = await io.exec('reg.exe', ['query', 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Pager\\command'])
  lines.push(`context menu: ${menu.code === 0 ? 'yes' : 'no'}`)
  if (rec?.exe !== undefined) {
    const t = await io.selftest(rec.exe)
    lines.push(`exe: ${rec.exe} (${t.ok ? 'starts' : (t.reason ?? 'does not start')})`)
  }
  lines.push(`record: ${path.join(dataDir, HOST_FILE)}`)
  return lines
}
