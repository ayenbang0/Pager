import path from 'node:path'
import { buildFragment } from './fragment.js'
import type { InstallIo } from './io.js'
import { hostPaths } from './paths.js'
import { contextMenuAdd } from './registry.js'

export type HostKind = 'wt' | 'exe'

export interface InstallOptions {
  node: string
  /** Pager's compiled `cli.js`. */
  cli: string
  /** The folder holding `assets/` (the icon). */
  assetsDir: string
  dataDir: string
  /** The own-window host to prefer when it can start. */
  exe?: string
}

export interface InstallReport {
  host: HostKind
  wt: string
  fragmentDir: string
  shortcut: 'lnk' | 'cmd'
  shortcutPath: string
  contextMenu: true
  note?: string
}

/** What `desktop-host.json` in the data dir records, for `launch` and `status`. */
export interface HostRecord {
  host: HostKind
  exe?: string
}

export const HOST_FILE = 'desktop-host.json'

const SHORTCUT_SCRIPT =
  '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:PAGER_LNK);$s.TargetPath=$env:PAGER_TARGET;$s.Arguments=$env:PAGER_ARGS;' +
  '$s.IconLocation=$env:PAGER_ICON;$s.WorkingDirectory=$env:PAGER_WD;$s.WindowStyle=[int]$env:PAGER_STYLE;$s.Save()'

const q = (s: string): string => `"${s}"`

/** The program and arguments that start Pager in its glass window, for the Start menu entry and the context menu. */
export function launchTarget(o: { host: HostKind; exe?: string; node: string; cli: string; conhost: string; hasConhost: boolean }): { file: string; args: string; hidden: boolean } {
  if (o.host === 'exe') return { file: o.exe!, args: '', hidden: false }
  // conhost --headless runs the launcher without a console window; plain node would flash one.
  if (o.hasConhost) return { file: o.conhost, args: `--headless ${q(o.node)} ${q(o.cli)} desktop launch`, hidden: false }
  return { file: o.node, args: `${q(o.cli)} desktop launch`, hidden: true }
}

export async function install(o: InstallOptions, io: InstallIo): Promise<InstallReport> {
  if (io.platform !== 'win32') throw new Error('The desktop host is Windows only')
  const p = hostPaths(io.env)
  const w = path.win32
  if (!io.exists(p.wt)) throw new Error('Windows Terminal is not installed (Microsoft Store: 9N0DX20HK701)')

  // 2. Fragment + its icon; Windows Terminal 1.24+ resolves relative paths next to the fragment.
  const icon = w.join(p.fragmentDir, 'pager.ico')
  io.write(w.join(p.fragmentDir, 'pager.json'), `${JSON.stringify(buildFragment({ node: o.node, cli: o.cli }), null, 2)}\n`)
  io.copy(path.join(o.assetsDir, 'assets', 'pager.ico'), icon)

  // 4. Host: the own-window exe only when it can actually start here.
  let host: HostKind = 'wt'
  let note: string | undefined
  if (o.exe !== undefined) {
    const t = await io.selftest(o.exe)
    if (t.ok) host = 'exe'
    else note = `${o.exe}: ${t.reason ?? 'failed its self-test'}; using Windows Terminal`
  }

  // 5. Launch target
  const target = launchTarget({ host, ...(o.exe === undefined ? {} : { exe: o.exe }), node: o.node, cli: o.cli, conhost: p.conhost, hasConhost: io.exists(p.conhost) })

  // 6. Start menu shortcut (COM through PowerShell), else a .cmd file in the same folder.
  const lnk = w.join(p.startMenu, 'Pager.lnk')
  let shortcut: 'lnk' | 'cmd' = 'lnk'
  let shortcutPath = lnk
  io.remove(w.join(p.startMenu, 'Pager.cmd'))
  const made = await io.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SHORTCUT_SCRIPT], {
    PAGER_LNK: lnk,
    PAGER_TARGET: target.file,
    PAGER_ARGS: target.args,
    PAGER_ICON: icon,
    PAGER_WD: io.env.USERPROFILE ?? 'C:\\',
    PAGER_STYLE: target.hidden ? '7' : '1',
  })
  if (made.code !== 0) {
    shortcut = 'cmd'
    shortcutPath = w.join(p.startMenu, 'Pager.cmd')
    io.write(shortcutPath, `@echo off\r\nstart "" ${q(target.file)} ${target.args}\r\n`)
  }

  // 7. Explorer context menu on folders and folder backgrounds
  const launch = `${q(target.file)}${target.args === '' ? '' : ` ${target.args}`}`
  for (const args of contextMenuAdd({ launch, icon })) {
    const r = await io.exec('reg.exe', args)
    if (r.code !== 0) throw new Error(`context menu: ${r.out || `reg exited ${r.code}`}`)
  }

  // 8. Remember the host
  const record: HostRecord = { host, ...(host === 'exe' ? { exe: o.exe! } : {}) }
  io.write(path.join(o.dataDir, HOST_FILE), `${JSON.stringify(record)}\n`)
  return { host, wt: p.wt, fragmentDir: p.fragmentDir, shortcut, shortcutPath, contextMenu: true, ...(note === undefined ? {} : { note }) }
}
