import path from 'node:path'
import { findBinary } from '../../agents/run/adapters.js'

export type ShellLabel = 'bash' | 'zsh' | 'fish' | 'pwsh' | 'powershell' | 'cmd' | 'sh'

export interface ShellSpec {
  file: string
  args: string[]
  env: Record<string, string>
  label: ShellLabel
  /** The shell emits OSC 133/7 marks through the scripts in the shell dir. */
  integrated: boolean
}

type Find = (bin: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>

const LABELS: readonly ShellLabel[] = ['bash', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd']

const labelOf = (file: string): ShellLabel => {
  const base = path.win32.basename(file).replace(/\.(exe|com|bat|cmd)$/i, '').toLowerCase()
  return LABELS.find((l) => l === base) ?? 'sh'
}

const quote = (s: string): string => `'${s.replaceAll("'", "''")}'`

/** Picks the shell (PAGER_SHELL, else the platform default) and the arguments/env that load its integration script. */
export async function resolveShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, shellDir: string, find: Find = findBinary): Promise<ShellSpec> {
  const override = env.PAGER_SHELL?.trim()
  let file: string
  if (override) file = (await find(override, env)) ?? override
  else if (platform === 'win32') file = (await find('pwsh', env)) ?? (await find('powershell', env)) ?? env.ComSpec ?? 'cmd.exe'
  else file = env.SHELL || '/bin/sh'
  const label = labelOf(file)
  const at = (name: string): string => path.join(shellDir, name)
  switch (label) {
    case 'bash':
      return { file, label, args: ['--rcfile', at('bash.sh'), '-i'], env: {}, integrated: true }
    case 'zsh':
      return { file, label, args: ['-i'], env: { ZDOTDIR: at('zsh'), PAGER_ZDOTDIR: env.ZDOTDIR ?? env.HOME ?? '' }, integrated: true }
    case 'fish':
      return { file, label, args: ['--interactive', '--init-command', `source '${at('fish.fish').replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`], env: {}, integrated: true }
    case 'pwsh':
    case 'powershell':
      return { file, label, args: ['-NoLogo', '-NoExit', '-Command', `. ${quote(at('pwsh.ps1'))}`], env: {}, integrated: true }
    default:
      return { file, label, args: [], env: {}, integrated: false }
  }
}
