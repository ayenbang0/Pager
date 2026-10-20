import path from 'node:path'

export interface HostPaths {
  /** The Store alias of Windows Terminal. */
  wt: string
  fragmentDir: string
  startMenu: string
  conhost: string
}

/** Per-user locations only: nothing here needs administrator rights. Windows paths on any platform, so tests can run anywhere. */
export function hostPaths(env: NodeJS.ProcessEnv): HostPaths {
  const local = env.LOCALAPPDATA
  const roaming = env.APPDATA
  if (local === undefined || roaming === undefined) throw new Error('LOCALAPPDATA/APPDATA are not set')
  const w = path.win32
  return {
    wt: w.join(local, 'Microsoft', 'WindowsApps', 'wt.exe'),
    fragmentDir: w.join(local, 'Microsoft', 'Windows Terminal', 'Fragments', 'Pager'),
    startMenu: w.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    conhost: w.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe'),
  }
}
