import fs from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'

export const AGENT_NAMES = ['omp', 'claude', 'opencode', 'hermes'] as const
export type AgentName = (typeof AGENT_NAMES)[number]

export interface AdapterSpec {
  /** Command name on PATH, or an absolute path. */
  bin: string
  args(prompt: string, cwd: string): string[]
  extract(stdout: string): string
  /** Args after `bin` that start the agent's ACP server over stdio; absent = one-shot only. */
  acp?: string[]
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

// One-shot runs are headless, auto-approving (runs only inside a throwaway worktree) and stateless.
// `acp` adds the args that start the agent's Agent Client Protocol server: pager then streams its
// replies live and keeps its native session between tasks (see acp.ts). claude has no ACP mode.
export const ADAPTERS: Record<AgentName, AdapterSpec> = {
  omp: {
    bin: 'omp',
    args: (prompt, cwd) => ['-p', '--no-session', '--cwd', cwd, prompt],
    extract: cleanOutput,
    acp: ['acp'],
    resume: false, // session/load fails when the cwd differs from the session's (each run has its own worktree)
  },
  claude: {
    bin: 'claude',
    args: (prompt) => ['-p', '--permission-mode', 'bypassPermissions', '--no-session-persistence', prompt],
    extract: cleanOutput,
  },
  opencode: {
    bin: 'opencode',
    args: (prompt, cwd) => ['run', '--auto', '--dir', cwd, prompt],
    extract: cleanOutput,
    acp: ['acp'],
    resume: false, // session/load succeeds but keeps working in the old worktree, ignoring the new cwd
  },
  hermes: {
    bin: 'hermes',
    args: (prompt, cwd) => ['chat', '-Q', '--oneshot', '--yolo', '--in', cwd, '-q', prompt],
    extract: hermesExtract,
    acp: ['acp'],
  },
}

export function isAgentName(s: string): s is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(s)
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
