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

// Headless, one-shot, auto-approving (runs only inside a throwaway worktree), stateless.
export const ADAPTERS: Record<AgentName, AdapterSpec> = {
  omp: {
    bin: 'omp',
    args: (prompt, cwd) => ['-p', '--no-session', '--cwd', cwd, prompt],
    extract: cleanOutput,
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
  },
  hermes: {
    bin: 'hermes',
    args: (prompt, cwd) => ['chat', '-Q', '--oneshot', '--yolo', '--in', cwd, '-q', prompt],
    extract: hermesExtract,
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
