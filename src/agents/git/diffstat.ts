/** Added and deleted lines of a branch against its base. */
export interface DiffStat {
  adds: number
  dels: number
}

/** Sums `git diff --numstat` output; binary files (`-\t-\tpath`) count as zero lines. */
export function parseNumstat(out: string): DiffStat {
  let adds = 0
  let dels = 0
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line)
    if (m === null) continue
    if (m[1] !== '-') adds += Number.parseInt(m[1] ?? '0', 10)
    if (m[2] !== '-') dels += Number.parseInt(m[2] ?? '0', 10)
  }
  return { adds, dels }
}

/** `+12/-3` */
export function formatStat(s: DiffStat): string {
  return `+${s.adds}/-${s.dels}`
}
