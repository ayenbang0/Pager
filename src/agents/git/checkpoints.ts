import { checkpointRefPrefix, commitAll, deleteRefs, deleteRefsUnder, firstCommitSince, isAncestor, isClean, readNoteRefs, resetHard, writeNoteRef, type NoteRef } from './git.js'

/** How many pre-turn checkpoints each agent keeps. */
export const MAX_CHECKPOINTS = 10

/** Where one agent's worktree stood just before one of its turns. */
export interface Checkpoint {
  /** Increases with every turn; the last segment of the ref name. */
  n: number
  /** The agent branch's HEAD before the turn started. */
  sha: string
  run: string
  at: number
  /** First line of the message that started the turn. */
  ask: string
  /** The agent's board notes as they were before the turn. */
  task: string
  purpose: string
}

export type CheckpointInput = Pick<Checkpoint, 'sha' | 'run' | 'ask' | 'task' | 'purpose'>

/** What `CheckpointLog.restore` undid. `snapshot` is true when uncommitted work was committed first. */
export interface RestoreResult {
  removed: Checkpoint[]
  snapshot: boolean
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

function parse(note: NoteRef): Checkpoint | undefined {
  const n = Number.parseInt(note.ref.slice(note.ref.lastIndexOf('/') + 1), 10)
  if (!Number.isSafeInteger(n) || n < 1) return undefined
  try {
    const meta: unknown = JSON.parse(note.message.slice(note.message.indexOf('\n') + 1))
    if (typeof meta !== 'object' || meta === null) return undefined
    const m = meta as Record<string, unknown>
    if (typeof m.run !== 'string' || typeof m.at !== 'number' || typeof m.ask !== 'string' || typeof m.task !== 'string' || typeof m.purpose !== 'string') return undefined
    return { n, sha: note.target, run: m.run, at: m.at, ask: m.ask, task: m.task, purpose: m.purpose }
  } catch {
    return undefined
  }
}

/**
 * The last `MAX_CHECKPOINTS` pre-turn shas of one agent branch. Held in memory and mirrored to
 * `refs/pager/checkpoints/<branch>/<n>`, so they survive a restart and are never garbage collected.
 */
export class CheckpointLog {
  private items: Checkpoint[] | undefined
  private readonly prefix: string

  constructor(
    private readonly root: string,
    branch: string,
  ) {
    this.prefix = checkpointRefPrefix(branch)
  }

  /** The checkpoints, oldest first. */
  async list(): Promise<readonly Checkpoint[]> {
    return this.load()
  }

  async record(input: CheckpointInput, at = Date.now()): Promise<Checkpoint> {
    const items = await this.load()
    const cp: Checkpoint = {
      n: (items.at(-1)?.n ?? 0) + 1,
      sha: input.sha,
      run: input.run,
      at,
      ask: oneLine(input.ask),
      task: oneLine(input.task),
      purpose: oneLine(input.purpose),
    }
    const meta = JSON.stringify({ run: cp.run, at: cp.at, ask: cp.ask, task: cp.task, purpose: cp.purpose })
    await writeNoteRef(this.root, this.ref(cp.n), cp.sha, `pager checkpoint ${cp.n}\n\n${meta}`)
    items.push(cp)
    const excess = items.splice(0, Math.max(0, items.length - MAX_CHECKPOINTS))
    await deleteRefs(this.root, excess.map((c) => this.ref(c.n)))
    return cp
  }

  /**
   * Puts the worktree `dir` back to where it was before its last `count` turns and forgets those checkpoints.
   * Uncommitted work is committed first (so `git reflog` still has it); throws when that does not leave the tree clean.
   */
  async restore(dir: string, count: number): Promise<RestoreResult> {
    const items = await this.load()
    if (!Number.isInteger(count) || count < 1 || count > items.length) throw new Error(`There are ${items.length} turn(s) to undo, not ${count}`)
    const removed = items.slice(-count)
    const target = removed[0] as Checkpoint
    // The next turn merges the main checkout back in, so work that is already merged there would simply return.
    const first = await firstCommitSince(dir, target.sha)
    if (first !== undefined && (await isAncestor(this.root, first))) throw new Error('That work is already merged into your checkout, so undoing the agent branch would not take it back (use git revert there)')
    let snapshot = false
    if (!(await isClean(dir))) {
      snapshot = await commitAll(dir, 'pager: uncommitted work saved before undo')
      if (!(await isClean(dir))) throw new Error(`The worktree has changes that could not be saved; commit or discard them in ${dir}`)
    }
    await resetHard(dir, target.sha)
    await deleteRefs(this.root, removed.map((c) => this.ref(c.n)))
    items.splice(items.length - count, count)
    return { removed, snapshot }
  }

  /** Forgets every checkpoint of this branch. */
  async clear(): Promise<void> {
    await deleteRefsUnder(this.root, this.prefix)
    this.items = []
  }

  private ref(n: number): string {
    return `${this.prefix}/${n}`
  }

  private async load(): Promise<Checkpoint[]> {
    this.items ??= (await readNoteRefs(this.root, this.prefix))
      .map(parse)
      .filter((c): c is Checkpoint => c !== undefined)
      .sort((a, b) => a.n - b.n)
    return this.items
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** One line per checkpoint, newest first; the number is how many turns `/agent undo <name> <n>` would undo. */
export function checkpointLines(items: readonly Checkpoint[]): string[] {
  return items
    .map((c, i) => ({ c, back: items.length - i }))
    .reverse()
    .map(({ c, back }) => {
      const d = new Date(c.at)
      const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      return `${back}  ${c.sha.slice(0, 7)}  ${c.run}  ${when}  ${c.ask.slice(0, 60)}`
    })
}
