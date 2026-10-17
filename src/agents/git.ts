import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | string | undefined,
  ) {
    super(message)
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err ? String(err.stderr).trim() : ''
    const code = err instanceof Error && 'code' in err && (typeof err.code === 'number' || typeof err.code === 'string') ? err.code : undefined
    throw new GitError(stderr || `git ${args[0]} failed`, code)
  }
}

const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l !== '')

export async function repoRoot(dir: string): Promise<string | undefined> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return undefined
  }
}

export async function headSha(root: string): Promise<string> {
  try {
    return (await git(root, ['rev-parse', 'HEAD'])).trim()
  } catch {
    throw new Error('The repository has no commits yet. Make one first.')
  }
}

export async function isDirty(root: string): Promise<boolean> {
  return (await git(root, ['status', '--porcelain', '-uno'])).trim() !== ''
}

export async function addWorktree(root: string, dir: string, branch: string, from: string): Promise<void> {
  await git(root, ['worktree', 'add', '-q', '-b', branch, dir, from])
}

export async function removeWorktree(root: string, dir: string, branch: string): Promise<void> {
  await git(root, ['worktree', 'remove', '--force', dir]).catch(() => undefined)
  await git(root, ['branch', '-D', branch]).catch(() => undefined)
}

export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, ['add', '-A'])
  if ((await git(dir, ['status', '--porcelain'])).trim() === '') return false
  await git(dir, [
    '-c', 'user.name=pager-agent',
    '-c', 'user.email=agents@pager.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--no-verify', '-q', '-m', message,
  ])
  return true
}

export async function changedFiles(dir: string, from: string): Promise<string[]> {
  return lines(await git(dir, ['diff', '--name-only', `${from}..HEAD`]))
}

export async function aheadCount(root: string, branch: string): Promise<number> {
  return Number.parseInt((await git(root, ['rev-list', '--count', `HEAD..${branch}`])).trim(), 10)
}

export async function isAncestor(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ['merge-base', '--is-ancestor', branch, 'HEAD'])
    return true
  } catch (err) {
    if (err instanceof GitError && err.code === 1) return false
    throw err
  }
}

export async function mergeBranch(
  root: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; conflicts: string[]; error: string }> {
  try {
    await git(root, ['merge', '--no-ff', '--no-edit', branch])
    return { ok: true }
  } catch (err) {
    const conflicts = lines(await git(root, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
    await git(root, ['merge', '--abort']).catch(() => undefined)
    return { ok: false, conflicts, error: (err as Error).message }
  }
}

/** Creates the agent's worktree on its own branch, or re-attaches the branch when only the directory is gone. */
export async function ensureWorktree(root: string, dir: string, branch: string, from: string): Promise<'created' | 'existing'> {
  if (fs.existsSync(path.join(dir, '.git'))) return 'existing'
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  await git(root, ['worktree', 'prune']).catch(() => undefined)
  try {
    await git(root, ['worktree', 'add', '-q', '-b', branch, dir, from])
  } catch {
    await git(root, ['worktree', 'add', '-q', dir, branch])
  }
  return 'created'
}

/** Merges `ref` (a sha or branch) into the worktree's branch. A conflict is aborted and reported, leaving the worktree as it was. */
export async function syncWorktree(dir: string, ref: string): Promise<'ok' | 'conflict'> {
  try {
    await git(dir, ['-c', 'user.name=pager-agent', '-c', 'user.email=agents@pager.invalid', '-c', 'commit.gpgsign=false', 'merge', '--no-edit', ref])
    return 'ok'
  } catch {
    await git(dir, ['merge', '--abort']).catch(() => undefined)
    return 'conflict'
  }
}

export async function currentSha(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', 'HEAD'])).trim()
}

/** `git diff --stat` and the full diff between `from` and the worktree's HEAD, for review requests. */
export async function diffSince(dir: string, from: string): Promise<{ stat: string; diff: string }> {
  const [stat, diff] = await Promise.all([git(dir, ['diff', '--stat', `${from}..HEAD`]), git(dir, ['diff', `${from}..HEAD`])])
  return { stat: stat.trim(), diff }
}
