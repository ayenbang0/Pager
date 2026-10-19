import type { AgentState } from '../types.js'

/** How many times a reviewer may send an author back before the review stops. */
export const REVIEW_MAX_ROUNDS = 2
/** The diff in a review request is cut at a file boundary below this many characters. */
export const REVIEW_DIFF_MAX_CHARS = 20_000
/** The author's closing message is cut to this many characters. */
export const REVIEW_FINAL_MAX_CHARS = 4000

export type Verdict = 'approve' | 'changes' | 'unknown'

/**
 * Who reviews `author`'s work: never the author, never someone who is waiting on the user. A teammate on a
 * different CLI is preferred (a second opinion); among the eligible, the first after `lastIndex` in
 * `workers` order wins, wrapping around. `lastIndex` is -1 when nobody has reviewed yet.
 */
export function pickReviewer(
  author: string,
  workers: { name: string; cli: string; state: AgentState }[],
  lastIndex: number,
): string | undefined {
  const eligible = workers.filter((w) => w.name !== author && w.state !== 'asking')
  const authorCli = workers.find((w) => w.name === author)?.cli
  const different = eligible.filter((w) => w.cli !== authorCli)
  const pool = different.length > 0 ? different : eligible
  const n = workers.length
  for (let step = 1; step <= n; step++) {
    const w = workers[(((lastIndex + step) % n) + n) % n]
    if (w !== undefined && pool.includes(w)) return w.name
  }
  return undefined
}

/** Cuts a unified diff at a `diff --git` boundary so that no file is shown half-way. */
function truncateDiff(diff: string): string {
  if (diff.length <= REVIEW_DIFF_MAX_CHARS) return diff
  const files = diff.split(/^(?=diff --git )/m)
  let kept = ''
  let shown = 0
  for (const file of files) {
    if (kept.length + file.length > REVIEW_DIFF_MAX_CHARS) break
    kept += file
    shown++
  }
  const more = files.length - shown
  if (shown === 0) {
    // One file alone is over budget: show its head so the reviewer still sees something.
    return `${diff.slice(0, REVIEW_DIFF_MAX_CHARS)}\n[diff truncated: ${more - 1} more files; the first file is cut too]`
  }
  return `${kept}${kept.endsWith('\n') ? '' : '\n'}[diff truncated: ${more} more files]`
}

/** The message a reviewer receives when a teammate finished a turn that changed files. */
export function reviewRequest(input: {
  author: string
  branch: string
  dir: string
  stat: string
  diff: string
  finalText: string
}): string {
  const final = input.finalText.trim()
  const cutFinal = final.length > REVIEW_FINAL_MAX_CHARS ? `${final.slice(0, REVIEW_FINAL_MAX_CHARS)}…` : final
  return [
    '--- REVIEW REQUEST ---',
    `Author: ${input.author}`,
    `Branch: ${input.branch}`,
    `Worktree (read-only for you, do not edit it): ${input.dir}`,
    '',
    'Changed files (git diff --stat):',
    input.stat.trim() === '' ? '(none)' : input.stat.trim(),
    '',
    'Diff:',
    input.diff.trim() === '' ? '(no diff)' : truncateDiff(input.diff.trimEnd()),
    '',
    `${input.author}'s final message:`,
    cutFinal === '' ? '(empty)' : cutFinal,
    '',
    'Review these changes for bugs, missing cases and anything that does not fit the goal. ' +
      'When done, call the submit_review tool with verdict "approve" or "changes" and your comments. ' +
      'Do not edit files.',
  ].join('\n')
}

/** What the author hears back from a review. */
export function feedbackText(reviewer: string, verdict: Verdict, comments: string): string {
  const body = comments.trim() === '' ? '(no comments)' : comments.trim()
  if (verdict === 'approve') return `${reviewer} reviewed your changes and approved them.\n${body}`
  if (verdict === 'changes') {
    return `${reviewer} reviewed your changes and asks for changes:\n${body}\nAddress these comments, then finish your turn.`
  }
  return `${reviewer} reviewed your changes but gave no explicit verdict. Their comments:\n${body}`
}
