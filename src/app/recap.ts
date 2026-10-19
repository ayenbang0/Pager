import type { RoomLine } from './search.js'

/** At most this many conversations are named; the rest are counted. */
const MAX_CHATS = 4

export interface RecapInput {
  now: number
  /** When pager was last open; undefined on the first run. */
  lastSeen: number | undefined
  /** Text messages from others that arrived since `lastSeen`, per conversation. */
  chats: { title: string; count: number }[]
  /** The agent room transcript (any age; older lines are ignored). */
  room: RoomLine[]
}

export interface AgentActivity {
  turns: number
  failed: number
  merged: number
  mergeFailed: number
}

/** `5m ago`, `2h ago`, `3d ago`. */
export function formatAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** What the agents did after `since`, read from the room transcript: replies are turns, `(failed: …)` replies are failures, pager's `merged …` / `merge of … failed` lines are merges. */
export function agentActivity(room: readonly RoomLine[], since: number): AgentActivity {
  const out: AgentActivity = { turns: 0, failed: 0, merged: 0, mergeFailed: 0 }
  for (const e of room) {
    if (e.ts <= since) continue
    if (e.kind === 'system') {
      if (e.author !== 'pager') continue
      if (/^merged \S/.test(e.text)) out.merged++
      else if (/^merge of .+ failed/.test(e.text)) out.mergeFailed++
      continue
    }
    if (e.author === 'you' || e.author === 'pager' || e.pk !== undefined || e.text.startsWith('→ @')) continue
    out.turns++
    if (/(^|\n)\(failed: /.test(e.text)) out.failed++
  }
  return out
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * One line telling what happened while pager was closed, or undefined when nothing did (and on the first run, when `lastSeen` is unknown):
 * `Since you left (2h ago): 14 messages in team, 3 in alice; agents: 5 turns, 1 failed`.
 */
export function buildRecap(i: RecapInput): string | undefined {
  if (i.lastSeen === undefined || i.lastSeen >= i.now) return undefined
  const chats = i.chats.filter((c) => c.count > 0).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
  const parts: string[] = []
  if (chats.length > 0) {
    const named = chats.slice(0, MAX_CHATS).map((c, n) => (n === 0 ? `${plural(c.count, 'message')} in ${c.title}` : `${c.count} in ${c.title}`))
    const rest = chats.slice(MAX_CHATS).reduce((sum, c) => sum + c.count, 0)
    if (rest > 0) named.push(`${rest} elsewhere`)
    parts.push(named.join(', '))
  }
  const a = agentActivity(i.room, i.lastSeen)
  const agent = [
    a.turns > 0 ? plural(a.turns, 'turn') : '',
    a.failed > 0 ? `${a.failed} failed` : '',
    a.merged > 0 ? `${a.merged} merged` : '',
    a.mergeFailed > 0 ? plural(a.mergeFailed, 'merge failure') : '',
  ].filter(Boolean)
  if (agent.length > 0) parts.push(`agents: ${agent.join(', ')}`)
  if (parts.length === 0) return undefined
  return `Since you left (${formatAgo(i.now - i.lastSeen)}): ${parts.join('; ')}`
}
