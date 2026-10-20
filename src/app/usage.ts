import fs from 'node:fs'
import path from 'node:path'
import { isRecord } from '../util/guards.js'

export const USAGE_MAX_LINES = 5000
export const USAGE_DAYS = 30

const DAY_MS = 86_400_000

/** One finished command in a Terminal tab. Only the program name is kept, never its arguments. */
export interface TermUsage {
  ts: number
  program: string
  ms: number
  exit: number
}

/** `C:\tools\Git.exe --version` becomes `git`; `sudo apt` stays `sudo`; env assignments and a leading `&`/`./` are skipped. */
export function programOf(command: string): string {
  const words = command.trim().split(/\s+/)
  let word = words.find((w) => w !== '&' && !/^\w+=/.test(w)) ?? ''
  word = word.replace(/^["']|["']$/g, '')
  const base = word.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase().slice(0, 40)
}

/** Append-only JSON-lines log of finished terminal commands, for the stats page. */
export class TermUsageLog {
  constructor(private readonly file: string) {}

  append(rec: TermUsage): void {
    if (rec.program === '') return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.appendFileSync(this.file, `${JSON.stringify(rec)}\n`)
    } catch {
      // Statistics are a convenience: a full disk must not disturb the terminal.
    }
  }

  read(): TermUsage[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    const out: TermUsage[] = []
    for (const line of raw.split('\n').slice(-USAGE_MAX_LINES - 1)) {
      if (line.trim() === '') continue
      try {
        const x: unknown = JSON.parse(line)
        if (!isRecord(x)) continue
        const { ts, program, ms, exit } = x
        if (typeof program === 'string' && typeof ts === 'number' && typeof ms === 'number' && typeof exit === 'number' && Number.isFinite(ts + ms + exit)) out.push({ ts, program, ms, exit })
      } catch {
        // A torn or hand-edited line is skipped.
      }
    }
    return out.slice(-USAGE_MAX_LINES)
  }
}

export interface TermSummary {
  total: number
  failed: number
  ms: number
  /** The most used programs, busiest first. */
  top: { program: string; count: number; failed: number }[]
  /** Commands per local day for the last USAGE_DAYS days (oldest first, today last). */
  days: number[]
}

export function summarizeTerm(records: readonly TermUsage[], now: number, topN = 12): TermSummary {
  const today = new Date(now).setHours(0, 0, 0, 0)
  const days = Array.from({ length: USAGE_DAYS }, () => 0)
  const by = new Map<string, { count: number; failed: number }>()
  let failed = 0
  let ms = 0
  for (const r of records) {
    const p = by.get(r.program) ?? { count: 0, failed: 0 }
    p.count++
    ms += r.ms
    if (r.exit !== 0) {
      p.failed++
      failed++
    }
    by.set(r.program, p)
    const age = Math.round((today - new Date(r.ts).setHours(0, 0, 0, 0)) / DAY_MS)
    if (age >= 0 && age < USAGE_DAYS) days[USAGE_DAYS - 1 - age] = (days[USAGE_DAYS - 1 - age] ?? 0) + 1
  }
  const top = [...by].map(([program, v]) => ({ program, ...v })).sort((a, b) => b.count - a.count || a.program.localeCompare(b.program)).slice(0, topN)
  return { total: records.length, failed, ms, top, days }
}
