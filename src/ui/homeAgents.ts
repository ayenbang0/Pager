import type { AgentStats } from '../agents/orchestrator.js'
import type { QuestionView } from '../agents/questions.js'
import type { AgentView } from '../agents/types.js'

/** Usage text older than this is not shown on Home. */
export const USAGE_SHOW_MS = 86_400_000

export interface HomeAgentRow {
  name: string
  cli: string
  state: AgentView['state']
  model?: string
  /** Context window in use, whole percent. */
  ctx?: number
  turns: number
  files: number
  approved: number
  changes: number
}

export interface HomeAgents {
  rows: HomeAgentRow[]
  /** Turns per day for the last 14 days, oldest first. */
  week: number[]
  weekTotal: number
  questions: number
  reviewsPending: number
  approved: number
  changes: number
  usage?: { agent: string; line: string; age: string }
  /** Installed agents that passed their check but have no teammate yet. */
  unadded: number
  /** The next step worth taking, in one line. */
  hint: string
}

export interface HomeAgentsInput {
  agents: readonly AgentView[]
  stats: AgentStats
  questions: readonly QuestionView[]
  reviewsPending: number
  usages: readonly { agent: string; text: string; at: number }[]
  unadded: number
  now: number
}

/** `12m ago`, `3h ago`. */
export function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

function hintFor(i: HomeAgentsInput, rows: readonly HomeAgentRow[]): string {
  const more = i.unadded > 0 ? ` · ${i.unadded} installed, not added` : ''
  if (rows.length === 0) return `no agents ready — /agent setup${more}`
  if (i.questions.length > 0) return `${i.questions.length} question${i.questions.length === 1 ? '' : 's'} waiting — Alt+Q`
  if (i.reviewsPending > 0) return `${i.reviewsPending} review${i.reviewsPending === 1 ? '' : 's'} running`
  if (rows.every((r) => r.turns === 0)) return `try @${rows[0]?.name ?? 'omp'} <task> in any chat`
  if (i.unadded > 0) return `${i.unadded} more installed — /agent setup`
  return '/agent usage · /agent review on|off · Alt+M model'
}

/** Everything the Home AGENTS card shows, from live state and the recorded stats. */
export function homeAgents(i: HomeAgentsInput): HomeAgents {
  const rows = i.agents.map((a): HomeAgentRow => {
    const t = Object.hasOwn(i.stats.perAgent, a.name) ? i.stats.perAgent[a.name] : undefined
    return {
      name: a.name,
      cli: a.cli,
      state: a.state,
      ...(a.model === undefined ? {} : { model: a.model }),
      ...(a.contextPct === undefined ? {} : { ctx: Math.round(a.contextPct * 100) }),
      turns: t?.turns ?? 0,
      files: t?.files ?? 0,
      approved: t?.approved ?? 0,
      changes: t?.changes ?? 0,
    }
  })
  const fresh = i.usages
    .filter((u) => i.now - u.at < USAGE_SHOW_MS && u.text.trim() !== '')
    .sort((a, b) => b.at - a.at)[0]
  const line = fresh?.text.split('\n').map((l) => l.trim()).find((l) => l !== '')
  return {
    rows,
    week: i.stats.week,
    weekTotal: i.stats.week.reduce((a, b) => a + b, 0),
    questions: i.questions.length,
    reviewsPending: i.reviewsPending,
    approved: i.stats.reviews.approved,
    changes: i.stats.reviews.changes,
    ...(fresh === undefined || line === undefined ? {} : { usage: { agent: fresh.agent, line, age: ageText(i.now - fresh.at) } }),
    unadded: i.unadded,
    hint: hintFor(i, rows),
  }
}
