import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VERSION } from '../app/version.js'
import { writeShellFiles } from '../tools/terminal/integration.js'
import { resolveShell } from '../tools/terminal/shell.js'
import type { PaneKind } from './protocol.js'
import type { Settings } from './settings.js'

export interface LaunchContext {
  dataDir: string
  /** The node that runs `cliPath`: the daemon's own. */
  nodePath: string
  cliPath: string
  socket: string
  hostPipe: string
  hostToken: string
  settings: Settings
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
}

export interface LaunchSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Typed into the shell once its first prompt shows (or a short wait for shells without prompt marks), then Enter. */
  typeAhead?: string
  /** The program is the shell itself, which reports prompts and finished commands (OSC 133). */
  integrated: boolean
  shell: boolean
}

/** What a typed agent block runs when the request names no command. */
export const AGENT_COMMANDS: Readonly<Record<string, string>> = { omp: 'omp', claude: 'claude', opencode: 'opencode', hermes: 'hermes' }
/** How an agent block comes back after a reboot or a daemon restart (the agent keeps its own session; these continue the latest). */
export const RESUME_COMMANDS: Readonly<Record<string, string>> = { omp: 'omp --continue', claude: 'claude --continue', opencode: 'opencode --continue', hermes: 'hermes --continue' }

export const isBlockKind = (kind: PaneKind): boolean => kind.startsWith('block:')

/** The folder to start in: the asked one if it exists, else home. */
export function usableCwd(cwd: string | undefined): string {
  if (cwd !== undefined && cwd !== '') {
    try {
      if (fs.statSync(cwd).isDirectory()) return cwd
    } catch {
      // gone: fall back
    }
  }
  return os.homedir()
}

export interface LaunchRequest {
  id: string
  kind: PaneKind
  cwd: string
  command?: string
  /** Run this program directly instead of a shell (tests, scripts that know what they want). */
  argv?: string[]
  /** The pane comes back after a restart: run the agent's resume command instead of its plain command. */
  resume?: string
}

export async function resolveLaunch(req: LaunchRequest, ctx: LaunchContext): Promise<LaunchSpec> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(ctx.env)) if (v !== undefined) env[k] = v
  Object.assign(env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'pager-desktop',
    TERM_PROGRAM_VERSION: VERSION,
    PAGER_PANE: req.id,
    PAGER_DAEMON_SOCKET: ctx.socket,
    PAGER_DESKTOP_PIPE: ctx.hostPipe,
    PAGER_DESKTOP_TOKEN: ctx.hostToken,
  })
  const cwd = usableCwd(req.cwd)
  if (req.argv !== undefined && req.argv.length > 0) return { file: req.argv[0]!, args: req.argv.slice(1), cwd, env, integrated: false, shell: false }
  if (req.kind === 'pager') {
    env.PAGER_NO_UPDATE_CHECK = '1'
    return { file: ctx.nodePath, args: [ctx.cliPath], cwd, env, integrated: false, shell: false }
  }
  const shellDir = path.join(ctx.dataDir, 'shell')
  writeShellFiles(shellDir)
  const pick = ctx.settings.shell.trim()
  const spec = await resolveShell(pick === '' ? ctx.env : { ...ctx.env, PAGER_SHELL: pick }, ctx.platform, shellDir)
  Object.assign(env, spec.env)
  const typed = req.resume ?? req.command ?? AGENT_COMMANDS[req.kind]
  return { file: spec.file, args: spec.args, cwd, env, integrated: spec.integrated, shell: true, ...(typed === undefined || typed === '' ? {} : { typeAhead: typed }) }
}
