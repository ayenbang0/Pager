import { mergeTreeRaw } from './git.js'

/** Stands for the checkout's HEAD where a conflict names the other side. */
export const CHECKOUT = 'checkout'
const SHOWN_FILES = 3

export interface BranchRef {
  name: string
  branch: string
}

/** `a` would conflict with `b` (the checkout or another agent) in `files`. */
export interface Conflict {
  a: string
  b: string
  files: string[]
}

export type MergeProbe = (cwd: string, a: string, b: string) => Promise<{ code: number | string | undefined; stdout: string }>

export type Prediction = { kind: 'clean' } | { kind: 'conflict'; files: string[] } | { kind: 'unsupported' } | { kind: 'error' }

/** Reads the result of `git merge-tree --write-tree --name-only`: exit 0 is clean, 1 lists the conflicted files after the tree id, 129 means git is older than 2.38. */
export function parseMergeTree(code: number | string | undefined, stdout: string): Prediction {
  if (code === 0) return { kind: 'clean' }
  if (code === 129) return { kind: 'unsupported' }
  if (code !== 1) return { kind: 'error' }
  const files: string[] = []
  const [, ...rest] = stdout.split(/\r?\n/)
  for (const line of rest) {
    if (line === '') break
    if (!files.includes(line)) files.push(line)
  }
  return files.length === 0 ? { kind: 'error' } : { kind: 'conflict', files }
}

/**
 * Dry-runs a merge of every agent branch into the checkout's HEAD and into every other agent branch, without touching any worktree.
 * Returns nothing when git cannot do it (older than 2.38) or a probe fails: prediction is advice, never a gate.
 */
export async function predictConflicts(root: string, agents: readonly BranchRef[], probe: MergeProbe = mergeTreeRaw): Promise<Conflict[]> {
  const jobs: { a: string; b: string; left: string; right: string }[] = []
  for (const [i, x] of agents.entries()) {
    jobs.push({ a: x.name, b: CHECKOUT, left: 'HEAD', right: x.branch })
    for (const y of agents.slice(i + 1)) jobs.push({ a: x.name, b: y.name, left: x.branch, right: y.branch })
  }
  const results = await Promise.all(
    jobs.map(async (j) => {
      const raw = await probe(root, j.left, j.right)
      return { j, p: parseMergeTree(raw.code, raw.stdout) }
    }),
  )
  const found: Conflict[] = []
  for (const { j, p } of results) {
    if (p.kind === 'unsupported') return []
    if (p.kind === 'conflict') found.push({ a: j.a, b: j.b, files: p.files })
  }
  return found
}

function fileList(files: string[]): string {
  const shown = files.slice(0, SHOWN_FILES).join(', ')
  return `${shown}${files.length > SHOWN_FILES ? `, +${files.length - SHOWN_FILES}` : ''}`
}

/** "omp and claude would conflict in a.ts, b.ts" / "omp would conflict with the checkout in a.ts" */
export function describeConflict(c: Conflict): string {
  return c.b === CHECKOUT ? `${c.a} would conflict with the checkout in ${fileList(c.files)}` : `${c.a} and ${c.b} would conflict in ${fileList(c.files)}`
}

/** What one agent conflicts with, for a run line: "checkout (a.ts), claude (b.ts)". Empty when nothing. */
export function conflictsOf(conflicts: readonly Conflict[], agent: string): string {
  const parts: string[] = []
  for (const c of conflicts) {
    if (c.a !== agent && c.b !== agent) continue
    parts.push(`${c.a === agent ? c.b : c.a} (${fileList(c.files)})`)
  }
  return parts.join(', ')
}

/** The latest prediction, so a conflict is announced when it appears or its files change and not on every later turn. */
export class ConflictBook {
  private known = new Map<string, { conflict: Conflict; files: string }>()

  /** Replaces the book with a fresh scan; returns the conflicts that are new or whose files changed. */
  update(found: readonly Conflict[]): Conflict[] {
    const next = new Map<string, { conflict: Conflict; files: string }>()
    const fresh: Conflict[] = []
    for (const conflict of found) {
      const key = [conflict.a, conflict.b].sort().join('|')
      const files = [...conflict.files].sort().join('\n')
      next.set(key, { conflict, files })
      if (this.known.get(key)?.files !== files) fresh.push(conflict)
    }
    this.known = next
    return fresh
  }

  all(): Conflict[] {
    return [...this.known.values()].map((e) => e.conflict)
  }

  forget(agent: string): void {
    for (const [key, e] of this.known) if (e.conflict.a === agent || e.conflict.b === agent) this.known.delete(key)
  }
}
