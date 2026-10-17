import fs from 'node:fs'
import path from 'node:path'
import { isRecord } from '../guards.js'

/** The reader looks at this many trailing lines at most. */
export const STATS_MAX_LINES = 5000
export const WEEK_DAYS = 14

const DAY_MS = 86_400_000

/** One finished agent turn, or (stop 'review') the verdict a reviewer gave on `agent`'s work. */
export interface StatRecord {
  ts: number
  agent: string
  cli: string
  ms: number
  files: number
  tokensIn?: number
  tokensOut?: number
  stop: string
  verdict?: 'approve' | 'changes' | 'unknown'
}

export interface AgentTotals {
  turns: number
  files: number
  ms: number
  approved: number
  changes: number
  lastTs: number
}

function parseRecord(x: unknown): StatRecord | undefined {
  if (!isRecord(x)) return undefined
  const { ts, agent, cli, ms, files, tokensIn, tokensOut, stop, verdict } = x
  if (typeof agent !== 'string' || typeof cli !== 'string' || typeof stop !== 'string') return undefined
  if (!Number.isFinite(ts) || !Number.isFinite(ms) || !Number.isFinite(files)) return undefined
  if (typeof ts !== 'number' || typeof ms !== 'number' || typeof files !== 'number') return undefined
  const rec: StatRecord = { ts, agent, cli, ms, files, stop }
  if (typeof tokensIn === 'number' && Number.isFinite(tokensIn)) rec.tokensIn = tokensIn
  if (typeof tokensOut === 'number' && Number.isFinite(tokensOut)) rec.tokensOut = tokensOut
  if (verdict === 'approve' || verdict === 'changes' || verdict === 'unknown') rec.verdict = verdict
  return rec
}

/** Append-only JSON-lines log of finished turns. */
export class StatsLog {
  constructor(private readonly file: string) {}

  append(rec: StatRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.appendFileSync(this.file, `${JSON.stringify(rec)}\n`)
    } catch {
      // Statistics are a convenience: a full disk must not fail the turn that produced them.
    }
  }

  /** The last STATS_MAX_LINES lines, skipping any that are not valid records. */
  read(): StatRecord[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    const out: StatRecord[] = []
    for (const line of raw.split('\n').slice(-STATS_MAX_LINES - 1)) {
      if (line.trim() === '') continue
      try {
        const rec = parseRecord(JSON.parse(line))
        if (rec !== undefined) out.push(rec)
      } catch {
        // A torn or hand-edited line is skipped.
      }
    }
    return out.slice(-STATS_MAX_LINES)
  }
}

/**
 * Per-agent totals plus turns per local day for the last 14 days (oldest first, today last).
 * Review records count towards the author's approved/changes but are not turns.
 */
export function summarize(records: StatRecord[], now: number): { perAgent: Record<string, AgentTotals>; week: number[] } {
  const totals = new Map<string, AgentTotals>()
  const week: number[] = Array.from({ length: WEEK_DAYS }, () => 0)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  for (const rec of records) {
    let t = totals.get(rec.agent)
    if (t === undefined) {
      t = { turns: 0, files: 0, ms: 0, approved: 0, changes: 0, lastTs: 0 }
      totals.set(rec.agent, t)
    }
    if (rec.verdict === 'approve') t.approved++
    else if (rec.verdict === 'changes') t.changes++
    if (rec.stop === 'review') continue
    t.turns++
    t.files += rec.files
    t.ms += rec.ms
    t.lastTs = Math.max(t.lastTs, rec.ts)
    const day = new Date(rec.ts)
    day.setHours(0, 0, 0, 0)
    const age = Math.round((today.getTime() - day.getTime()) / DAY_MS)
    if (age >= 0 && age < WEEK_DAYS) week[WEEK_DAYS - 1 - age] = (week[WEEK_DAYS - 1 - age] ?? 0) + 1
  }
  return { perAgent: Object.fromEntries(totals), week }
}
