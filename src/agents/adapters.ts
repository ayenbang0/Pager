import fs from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { PRESETS } from './catalog.js'

/** An agent's CLI id: a catalog preset, a custom entry in agents.json, or a test adapter. */
export type AgentName = string

export interface RunOptions {
  model?: string
  effort?: string
  /** JSON for `--mcp-config` (the pager tool server); only claude's one-shot mode takes it. */
  mcpConfig?: string
}

export interface AdapterSpec {
  /** Command name on PATH, or an absolute path. */
  bin: string
  /** One-shot headless run; absent for agents that only speak ACP. */
  args?(prompt: string, cwd: string, opts?: RunOptions): string[]
  extract?(stdout: string): string
  /** Args after `bin` (or `acpBin`) that start the agent's ACP server over stdio; absent = one-shot only. */
  acp?: string[]
  /** Separate binary for the ACP server when it differs from `bin` (claude-agent-acp). */
  acpBin?: string
  /** False keeps ACP streaming but drops native session resume (default true). */
  resume?: boolean
}

const cleanOutput = (s: string): string => stripVTControlCharacters(s).trim()

/** Drops hermes' trailing "session: <id>" / "resume ..." footer lines. */
function hermesExtract(s: string): string {
  const lines = cleanOutput(s).split(/\r?\n/)
  while (lines.length > 0) {
    const last = lines[lines.length - 1] ?? ''
    if (last.trim() === '' || /^\s*(session(_id)?|resume)\b/i.test(last)) lines.pop()
    else break
  }
  return lines.join('\n').trim()
}

// One-shot runs are headless, auto-approving (runs only inside the agent's own worktree) and stateless.
// `acp` adds the args that start the agent's Agent Client Protocol server: pager then streams its
// replies live and keeps its native session between tasks (see acp.ts). claude has ACP only through
// the separate `claude-agent-acp` adapter, when that is installed.
const flags = (cli: string, opts: RunOptions | undefined): string[] => {
  const preset = PRESETS[cli]
  return [
    ...(opts?.model !== undefined && preset?.modelFlag !== undefined ? [...preset.modelFlag, opts.model] : []),
    ...(opts?.effort !== undefined && preset?.effortFlag !== undefined ? [...preset.effortFlag, opts.effort] : []),
  ]
}

export const ADAPTERS: Record<string, AdapterSpec> = {
  omp: {
    bin: 'omp',
    args: (prompt, cwd, opts) => ['-p', '--no-session', '--cwd', cwd, ...flags('omp', opts), prompt],
    extract: cleanOutput,
    acp: ['acp'],
  },
  claude: {
    bin: 'claude',
    args: (prompt, _cwd, opts) => [
      '-p',
      '--permission-mode',
      'bypassPermissions',
      '--no-session-persistence',
      ...flags('claude', opts),
      ...(opts?.mcpConfig === undefined ? [] : ['--mcp-config', opts.mcpConfig]),
      prompt,
    ],
    extract: cleanOutput,
    acpBin: 'claude-agent-acp',
    acp: [],
  },
  opencode: {
    bin: 'opencode',
    args: (prompt, cwd, opts) => ['run', '--auto', '--dir', cwd, ...flags('opencode', opts), prompt],
    extract: cleanOutput,
    acp: ['acp'],
  },
  hermes: {
    bin: 'hermes',
    args: (prompt, cwd, opts) => ['chat', '-Q', '--oneshot', '--yolo', '--in', cwd, ...flags('hermes', opts), '-q', prompt],
    extract: hermesExtract,
    acp: ['acp'],
  },
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile()
  } catch {
    return false
  }
}

export async function findBinary(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (bin.includes('/') || bin.includes('\\')) return (await isFile(bin)) ? bin : undefined
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : ['']
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (dir === '') continue
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext)
      if (await isFile(candidate)) return candidate
    }
  }
  return undefined
}
