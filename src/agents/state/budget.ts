import fs from 'node:fs'
import path from 'node:path'
import { isRecord } from '../../util/guards.js'
import type { StatRecord } from './stats.js'

/** Share of a cap at which the one daily warning is given. */
export const WARN_AT = 0.8

/** The key of the cap every agent without a cap of its own falls under (Settings > Agents). */
export const ALL_KEY = '*'

const MINUTE_MS = 60_000

/** Daily caps for one agent. A missing field means no cap on that. */
export interface Cap {
  turns?: number
  minutes?: number
}

/** What an agent has used in the current local day. */
export interface Used {
  turns: number
  ms: number
}

export interface BudgetCheck {
  status: 'ok' | 'warn' | 'over'
  /** The most used share of any cap, 0 to beyond 1. */
  pct: number
  /** The cap that is closest to (or past) its limit. */
  limit: 'turns' | 'minutes' | undefined
}

/** Local midnight at or before `now`, and the next one (DST-safe). */
function dayBounds(now: number): { start: number; end: number } {
  const d = new Date(now)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return { start, end }
}

/** `YYYY-MM-DD` of the local day `now` falls in. */
export function dayKey(now: number): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Turns and run time `agent` used since local midnight. Review verdict records are not turns. */
export function usedToday(records: readonly StatRecord[], agent: string, now: number): Used {
  const { start, end } = dayBounds(now)
  const used: Used = { turns: 0, ms: 0 }
  for (const rec of records) {
    if (rec.agent !== agent || rec.stop === 'review' || rec.ts < start || rec.ts >= end) continue
    used.turns++
    used.ms += rec.ms
  }
  return used
}

/** Compares use with the caps: `over` at 100% of any cap, `warn` from 80%. */
export function check(caps: Cap | undefined, used: Used): BudgetCheck {
  let pct = 0
  let limit: BudgetCheck['limit']
  if (caps?.turns !== undefined && caps.turns > 0) {
    pct = used.turns / caps.turns
    limit = 'turns'
  }
  if (caps?.minutes !== undefined && caps.minutes > 0) {
    const share = used.ms / (caps.minutes * MINUTE_MS)
    if (limit === undefined || share > pct) {
      pct = share
      limit = 'minutes'
    }
  }
  return { status: pct >= 1 ? 'over' : pct >= WARN_AT ? 'warn' : 'ok', pct, limit }
}

function capText(cap: Cap, limit: BudgetCheck['limit']): string {
  if (limit === 'minutes' && cap.minutes !== undefined) return `${cap.minutes} min`
  return `${cap.turns ?? 0} turns`
}

/** The cap in the Settings > Agents syntax: `turns=20 minutes=60`. */
export function describeCap(cap: Cap): string {
  return [cap.turns === undefined ? '' : `turns=${cap.turns}`, cap.minutes === undefined ? '' : `minutes=${cap.minutes}`].filter(Boolean).join(' ')
}

/** `3/5 turns, 12/30 min` for the caps that are set. */
export function describeUse(cap: Cap, used: Used): string {
  const parts: string[] = []
  if (cap.turns !== undefined) parts.push(`${used.turns}/${cap.turns} turns`)
  if (cap.minutes !== undefined) parts.push(`${Math.round(used.ms / MINUTE_MS)}/${cap.minutes} min`)
  return parts.join(', ')
}

/** Why a turn was refused. */
export function refusal(name: string, cap: Cap, c: BudgetCheck): string {
  return `${name} hit its daily budget (${capText(cap, c.limit)}); Settings > Agents to lift`
}

/** The once-a-day note when use reaches 80% (or 100%) of a cap. */
export function warning(name: string, cap: Cap, used: Used, c: BudgetCheck): string {
  if (c.status === 'over') return `${refusal(name, cap, c)} (used ${describeUse(cap, used)} today)`
  return `${name} used ${Math.round(c.pct * 100)}% of its daily budget (${describeUse(cap, used)}); Settings > Agents to review`
}

/** Remembers which keys were already told about today, so each warning comes once per local day. */
export class DailyOnce {
  private readonly seen = new Map<string, string>()

  /** True the first time `key` is asked in the local day of `now`. */
  first(key: string, now: number): boolean {
    const day = dayKey(now)
    if (this.seen.get(key) === day) return false
    this.seen.set(key, day)
    return true
  }
}

export type BudgetCommand = { kind: 'show' } | { kind: 'set'; key: string; cap: Cap } | { kind: 'off'; key: string } | { kind: 'error'; message: string }

export const BUDGET_USAGE = '<name|all> turns=<N> minutes=<N> | <name|all> off'

function wholeNumber(raw: string): number | undefined {
  const m = /^(\d{1,7})(?:\/day)?$/i.exec(raw)
  const n = m === null ? NaN : Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** `args` is the agent (or `all`) then the cap words. `names` are the configured agents. */
export function parseBudget(args: readonly string[], names: readonly string[]): BudgetCommand {
  if (args.length === 0) return { kind: 'show' }
  const who = (args[0] ?? '').toLowerCase()
  const known = who === 'all' ? ALL_KEY : names.includes(who) ? who : undefined
  if (known === undefined) return { kind: 'error', message: `Unknown agent "${who.slice(0, 30)}". Usage: ${BUDGET_USAGE}  (agents: ${names.join(', ') || 'none'})` }
  const rest = args.slice(1)
  if (rest.length === 1 && (rest[0] ?? '').toLowerCase() === 'off') return { kind: 'off', key: known }
  const cap: Cap = {}
  for (const word of rest) {
    const m = /^(turns|minutes|mins?)=(\S*)$/i.exec(word)
    const n = m === null ? undefined : wholeNumber(m[2] ?? '')
    if (m === null || n === undefined) return { kind: 'error', message: `"${word.slice(0, 30)}" is not a cap. Usage: ${BUDGET_USAGE}  (whole numbers above zero; per local day)` }
    if ((m[1] ?? '').toLowerCase() === 'turns') cap.turns = n
    else cap.minutes = n
  }
  if (cap.turns === undefined && cap.minutes === undefined) return { kind: 'error', message: `Usage: ${BUDGET_USAGE}` }
  return { kind: 'set', key: known, cap }
}

function parseCap(x: unknown): Cap | undefined {
  if (!isRecord(x)) return undefined
  const cap: Cap = {}
  if (typeof x.turns === 'number' && Number.isSafeInteger(x.turns) && x.turns > 0) cap.turns = x.turns
  if (typeof x.minutes === 'number' && Number.isSafeInteger(x.minutes) && x.minutes > 0) cap.minutes = x.minutes
  return cap.turns === undefined && cap.minutes === undefined ? undefined : cap
}

/** Daily caps per agent (`agent-budgets.json`), plus an optional default for every agent. */
export class BudgetStore {
  private readonly caps = new Map<string, Cap>()

  constructor(private readonly file: string) {
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return
    }
    if (!isRecord(raw)) return
    for (const [key, value] of Object.entries(raw)) {
      const cap = parseCap(value)
      if (cap !== undefined) this.caps.set(key, cap)
    }
  }

  /** The cap that applies to `agent`: its own, else the default for all. */
  get(agent: string): Cap | undefined {
    return this.caps.get(agent) ?? this.caps.get(ALL_KEY)
  }

  /** Every stored cap, the default (key ALL_KEY) included. */
  entries(): [string, Cap][] {
    return [...this.caps]
  }

  set(key: string, cap: Cap): void {
    this.caps.set(key, cap)
    this.save()
  }

  /** True when there was a cap to remove. */
  clear(key: string): boolean {
    const had = this.caps.delete(key)
    if (had) this.save()
    return had
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.caps), null, 2))
      fs.renameSync(tmp, this.file)
    } catch {
      // Budgets are a convenience: a full disk must not break the command that set one.
    }
  }
}
