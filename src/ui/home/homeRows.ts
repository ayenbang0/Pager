import stringWidth from 'string-width'
import type { ChangelogKind, Highlight } from '../../app/changelog.js'
import type { ConvView, HomeStats } from '../../app/engine.js'
import type { Theme } from '../theme/themes.js'
import { ctxTone, stateColor, stateWord } from '../chrome/agentChrome.js'
import type { HomeAgentRow, HomeAgents } from './homeAgents.js'
import { agentTint, type Look } from '../theme/look.js'
import { clipSegs, fitSegs, segsWidth, type Seg } from '../kit/segs.js'
import { chip, ruleRow } from '../kit/tern.js'
import { buildRow, chatRowSpec } from '../sidebar/sidebarRows.js'

/**
 * The Home screen as plain rows, built from the same pieces as every other screen: a quiet heading (a dim bold label, a hairline, a note
 * at the end) over rows laid out like the sidebar's, raised chips for keys, the accent only for what needs you. No boxes, no logo.
 */

/** Two columns of quick actions from this width. */
export const TWO_COLUMN_MIN_WIDTH = 80
/** Recent chats shown. */
export const RECENT_CHATS = 4
/** Agent rows shown before `+N more`. */
export const AGENT_ROWS_MAX = 4
const NAME_MAX = 14
const MODEL_MAX = 12
const BLANK: Seg[] = [{ text: ' ' }]
/** The name Look carries before the user has chosen one; the welcome lines may know better. */
const DEFAULT_ME = 'you'

/** A conversation as Home lists it. */
export type HomeChat = Pick<ConvView, 'kind' | 'online' | 'title' | 'unread' | 'call' | 'last' | 'thinking'>

/** The newest release as a few lines (see `Engine.whatsNew`). */
export interface WhatsNew {
  version: string
  items: readonly Highlight[]
  /** First start of this version. */
  fresh: boolean
}

export interface HomeInput {
  /** Pane width and height in cells. */
  width: number
  height: number
  /** Local hour 0-23, for the greeting. */
  hour: number
  /** Clock for the relative times. */
  now: number
  theme: Theme
  look: Look
  stats: HomeStats
  agents: HomeAgents
  /** False in a run without agents: the agent lines, rows and shortcuts are left out. Default true. */
  agentsOn?: boolean
  /** Every conversation; the newest few are listed. */
  chats: readonly HomeChat[]
  /** The engine's welcome lines after the title: name, contact code, getting-started steps. */
  info: readonly string[]
  /** What happened while pager was closed. */
  recap?: string
  news?: WhatsNew
}

export interface HomeInfo {
  name?: string
  code?: string
  steps: string[]
  /** Lines this parser does not know, kept so nothing the engine says is lost. */
  extra: string[]
}

/** The engine's welcome lines (`You  name`, `Contact code`, `  pgr1-…`, `Get started`, `  1. …`) as parts. */
export function parseInfo(info: readonly string[]): HomeInfo {
  const out: HomeInfo = { steps: [], extra: [] }
  for (const raw of info) {
    const line = raw.trim()
    const step = /^\d+\.\s+(.*)$/.exec(line)
    const you = /^You\s+(.+)$/.exec(line)
    if (line === '' || line === 'Contact code' || line === 'Get started') continue
    if (line.startsWith('pgr1-')) out.code = line
    else if (step?.[1] !== undefined) out.steps.push(step[1])
    else if (you?.[1] !== undefined) out.name = you[1]
    else out.extra.push(line)
  }
  return out
}

/** `text` cut to `n` columns with an ellipsis when it is longer; never padded. */
export function clipText(text: string, n: number): string {
  if (stringWidth(text) <= n) return text
  if (n <= 0) return ''
  const cut = clipSegs([{ text }], n - 1)[0]?.text ?? ''
  return `${cut}…`
}

/** `text` clipped (with an ellipsis) or padded to exactly `n` columns. */
export function fitText(text: string, n: number): string {
  const out = clipText(text, n)
  return out + ' '.repeat(Math.max(0, n - stringWidth(out)))
}

/** Word-wraps `text` to `width` display columns; a word longer than a line is broken. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter((x) => x !== '')) {
    let rest = word
    while (stringWidth(rest) > w) {
      if (cur !== '') lines.push(cur)
      cur = ''
      const part = clipSegs([{ text: rest }], w)[0]?.text || ([...rest][0] ?? rest)
      lines.push(part)
      rest = rest.slice(part.length)
    }
    const next = cur === '' ? rest : `${cur} ${rest}`
    if (stringWidth(next) <= w) cur = next
    else {
      lines.push(cur)
      cur = rest
    }
  }
  if (cur !== '') lines.push(cur)
  return lines.length > 0 ? lines : ['']
}

const BARS = '▁▂▃▄▅▆▇█'

/** One bar per value, scaled to the largest; zeros stay on the lowest bar so the row never has gaps. */
export function sparkline(values: readonly number[]): string {
  const max = Math.max(0, ...values)
  return values.map((v) => (max === 0 ? BARS[0] : BARS[Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))])).join('')
}

/** Time-of-day opener. */
export function greetingWord(hour: number): string {
  if (hour < 5) return 'Up late'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/** `Good evening, name ◆`: the name bold in the accent, your badge after it. */
export function greetingSegs(name: string, badge: string, hour: number, theme: Theme): Seg[] {
  const tail: Seg[] = badge === '' ? [] : [{ text: ` ${badge}`, color: theme.accent2, bold: true }]
  return [{ text: ' ' }, { text: `${greetingWord(hour)}, `, color: theme.text }, { text: name, color: theme.accent, bold: true }, ...tail]
}

/** A section heading: the quiet bold label, a hairline across the gap, an optional note at the end (dropped first when tight). Exactly `width` columns. */
export function heading(title: string, note: readonly Seg[], width: number, theme: Theme): Seg[] {
  return ruleRow([{ text: ' ' }, { text: title, color: theme.dim, bold: true }], note, width, theme)
}

const dim = (text: string, theme: Theme): Seg => ({ text, color: theme.dim })

/** A piece of a row that may be dropped when the row is tight; the highest rank goes first. */
export interface Part {
  rank: number
  segs: Seg[]
}

/** The parts joined by two spaces, the least important dropped until they fit `room`; nothing when even the first does not. */
export function detailFor(parts: readonly Part[], room: number): Seg[] {
  const ranks = [...new Set(parts.map((p) => p.rank))].sort((a, b) => b - a)
  for (const max of ranks) {
    const segs = parts.filter((p) => p.rank <= max).flatMap((p, n): Seg[] => (n === 0 ? p.segs : [{ text: '  ' }, ...p.segs]))
    if (segsWidth(segs) <= room) return segs
  }
  return []
}

/** The two summary lines under the greeting: what the chats and the agents are doing now. */
export function summaryRows(i: HomeInput, width: number): Seg[][] {
  const { stats, agents, theme } = i
  const label = (text: string): Seg[] => [{ text: ' ' }, { text: text.padEnd(7), color: theme.dim }]
  const count = (n: number, text: string, tone: string | undefined): Seg => ({ text: `${n} ${text}`, color: n > 0 && tone !== undefined ? tone : theme.text, bold: n > 0 && tone !== undefined })
  const online = stats.online > 0
  const chats: Part[] = [
    { rank: 1, segs: [{ text: online ? '● ' : '○ ', color: online ? theme.online : theme.dim, bold: online }, { text: `${stats.online} online of ${stats.contacts} contact${stats.contacts === 1 ? '' : 's'}`, color: theme.text }] },
    { rank: 2, segs: [count(stats.unread, 'unread', theme.accent)] },
    { rank: 2, segs: [count(stats.pending, 'pending', theme.warning)] },
    { rank: 3, segs: [{ text: `${stats.groups} group${stats.groups === 1 ? '' : 's'}`, color: theme.text }] },
  ]
  const rows: Seg[][] = [[...label('Chats'), ...detailFor(chats, width - 8)]]
  if (i.agentsOn !== false) {
    const ready: Part = { rank: 1, segs: [{ text: `${agents.rows.length} ready`, color: theme.text }] }
    const parts: Part[] = [
      ready,
      { rank: 1, segs: [count(stats.agentsRunning, 'running', theme.accent)] },
      { rank: 2, segs: [count(agents.questions, 'asking', theme.warning)] },
      { rank: 3, segs: [count(stats.mergeable, 'to merge', theme.success)] },
      { rank: 4, segs: [{ text: `reviews ✓${agents.approved} ↻${agents.changes}`, color: theme.text }] },
    ]
    rows.push([...label('Agents'), ...detailFor(parts, width - 8)])
  }
  return rows
}

/** The agent rows' shared columns, so the state words, context and models line up from row to row. */
export interface AgentColumns {
  name: number
  state: number
  ctx: number
  model: number
}

const ctxText = (row: HomeAgentRow): string => (row.ctx === undefined ? 'ctx —' : `ctx ${row.ctx}%`)
const modelText = (row: HomeAgentRow): string => row.model ?? row.cli
const widest = (texts: readonly string[], cap: number): number => Math.min(cap, Math.max(0, ...texts.map((t) => stringWidth(t))))

export function agentColumns(rows: readonly HomeAgentRow[]): AgentColumns {
  return {
    name: widest(rows.map((r) => r.name), NAME_MAX),
    state: widest(rows.map((r) => stateWord(r.state)), 12),
    ctx: widest(rows.map(ctxText), 10),
    model: widest(rows.map(modelText), MODEL_MAX),
  }
}

/**
 * One agent as a sidebar-style row: its dot and name in its own color, then at the right the state word in the state's color, context
 * pressure, model and counts. Narrow rows drop counts, then the model, then context; the name is cut last.
 */
export function agentLine(row: HomeAgentRow, cols: AgentColumns, width: number, theme: Theme, tint: string): Seg[] {
  const tone = row.ctx === undefined ? undefined : ctxTone(row.ctx)
  const ctxColor = tone === 'bad' ? theme.error : tone === 'warn' ? theme.warning : theme.dim
  const parts: Part[] = [
    { rank: 1, segs: [{ text: fitText(stateWord(row.state), cols.state), color: stateColor(row.state, theme), bold: row.state !== 'idle' }] },
    { rank: 2, segs: [{ text: fitText(ctxText(row), cols.ctx), color: ctxColor }] },
    { rank: 3, segs: [dim(fitText(modelText(row), cols.model), theme)] },
    { rank: 4, segs: [dim(`${row.turns}t ${row.files}f`, theme)] },
  ]
  const room = width - 3 - cols.name - 3
  const detail = detailFor(parts, room)
  return buildRow({ glyph: '●', glyphColor: tint, label: row.name, labelColor: tint, ...(detail.length === 0 ? {} : { badge: detail }) }, false, width, theme)
}

/** The agent block: heading, a row per agent (the first few), the usage line, and the next step (first when it is urgent, otherwise last). */
export function agentRows(i: HomeInput, width: number): Seg[][] {
  const { agents, theme } = i
  const out: Seg[][] = [heading('Agents', [dim(`${agents.rows.length} ready`, theme)], width, theme)]
  const urgent = agents.rows.length === 0 || agents.questions > 0
  const hint = wrapText(agents.hint, Math.max(1, width - 4)).map(
    (text, n): Seg[] => (urgent ? [{ text: n === 0 ? ' ▸ ' : '   ', color: theme.accent, bold: true }, { text, color: theme.text }] : [{ text: '   ' }, dim(text, theme)]),
  )
  if (urgent) out.push(...hint)
  if (agents.rows.length === 0) out.push([{ text: '   ' }, dim('coding agents you @mention in any chat', theme)])
  else {
    const cols = agentColumns(agents.rows)
    out.push(...agents.rows.slice(0, AGENT_ROWS_MAX).map((row) => agentLine(row, cols, width, theme, agentTint(theme, i.look, row.name))))
    if (agents.rows.length > AGENT_ROWS_MAX) out.push([{ text: '   ' }, dim(`+${agents.rows.length - AGENT_ROWS_MAX} more`, theme)])
    if (agents.usage !== undefined) {
      const age = ` · ${agents.usage.age}`
      out.push([{ text: '   ' }, dim(clipText(`usage ${agents.usage.agent}: ${agents.usage.line}`, Math.max(1, width - 3 - stringWidth(age))) + age, theme)])
    }
  }
  if (!urgent) out.push(...hint)
  return out
}

/** The newest chats first; conversations with no message yet last. */
export function recentChats(chats: readonly HomeChat[], n = RECENT_CHATS): HomeChat[] {
  return [...chats].sort((a, b) => (b.last ?? 0) - (a.last ?? 0)).slice(0, n)
}

/** The chat block: heading, the newest conversations as sidebar rows, then a dim line of totals once there is any traffic. */
export function chatRows(i: HomeInput, width: number): Seg[][] {
  const { stats, theme } = i
  const out: Seg[][] = [heading('Chats', [dim(`${stats.contacts + stats.groups}`, theme)], width, theme)]
  const shown = recentChats(i.chats)
  if (shown.length === 0) out.push([{ text: '   ' }, dim('no chats yet · /add <code> adds a friend', theme)])
  else out.push(...shown.map((c) => buildRow(chatRowSpec(c, i.now, theme), false, width, theme)))
  if (stats.sent + stats.received > 0) {
    const week = stats.week.reduce((a, b) => a + b, 0)
    const parts: Part[] = [
      { rank: 1, segs: [dim(`↑ ${stats.sent} sent`, theme)] },
      { rank: 1, segs: [dim(`↓ ${stats.received} received`, theme)] },
      { rank: 2, segs: [{ text: sparkline(stats.week), color: theme.accent }, dim(` ${week} this week`, theme)] },
      { rank: 3, segs: [dim(`top ${stats.busiest === null ? '—' : `${clipText(stats.busiest.title, 16)} ${stats.busiest.count}`}`, theme)] },
    ]
    out.push([{ text: '   ' }, ...detailFor(parts, width - 3)])
  }
  return out
}

/** The keys and commands worth knowing, each with what it does. */
export function actionItems(agentsOn: boolean): readonly (readonly [string, string])[] {
  return [
    ['Ctrl+P', 'commands and search'],
    ['Ctrl+G', 'shortcuts and help'],
    ['Alt+↑↓', 'switch tab'],
    ['Alt+S', 'settings'],
    ['/add', 'add a friend by contact code'],
    ['/code', 'show your contact code'],
    ...(agentsOn ? ([['Alt+M', 'model and effort'], ['Alt+I', 'invite a contact to your agents']] as const) : []),
  ]
}

/** One shortcut: its key on a raised chip (all keys padded to one width), then what it does. */
function actionSegs(key: string, label: string, keyWidth: number, theme: Theme): Seg[] {
  return [chip(key + ' '.repeat(Math.max(0, keyWidth - stringWidth(key))), theme), { text: ' ' }, { text: label, color: theme.text }]
}

/** The quick actions block: heading, then the shortcuts one per row, or two to a row on a wide pane. */
export function actionRows(i: HomeInput, width: number): Seg[][] {
  const items = actionItems(i.agentsOn !== false)
  const keyWidth = Math.max(...items.map(([key]) => stringWidth(key)))
  const out: Seg[][] = [heading('Quick actions', [], width, i.theme)]
  const cells = items.map(([key, label]) => actionSegs(key, label, keyWidth, i.theme))
  if (width < TWO_COLUMN_MIN_WIDTH) return [...out, ...cells.map((c) => [{ text: ' ' }, ...c])]
  const colWidth = Math.floor((width - 1) / 2)
  for (let n = 0; n < cells.length; n += 2) {
    const left = fitSegs([{ text: ' ' }, ...(cells[n] ?? [])], colWidth)
    out.push([...left, ...fitSegs([{ text: ' ' }, ...(cells[n + 1] ?? [])], width - colWidth)])
  }
  return out
}

/** The contact code wrapped to `width` columns so none of it is cut. */
export function codeLines(code: string, width: number, theme: Theme): Seg[][] {
  const room = Math.max(8, width - 2)
  const rows: Seg[][] = []
  for (let at = 0; at < code.length; at += room) rows.push([{ text: ' ' }, { text: code.slice(at, at + room), color: theme.text, bold: true }])
  return rows
}

/** The contact code and the engine's other lines (LAN mode), under `title`; a new pager adds the getting-started steps. */
export function codeRows(title: string, info: HomeInfo, withSteps: boolean, width: number, theme: Theme): Seg[][] {
  const out: Seg[][] = [heading(title, [], width, theme)]
  if (info.code !== undefined) out.push(...codeLines(info.code, width, theme))
  if (withSteps) {
    info.steps.forEach((step, n) => {
      wrapText(step, width - 4).forEach((text, row) => out.push([{ text: row === 0 ? ` ${n + 1}  ` : '    ', color: theme.accent, bold: true }, { text, color: theme.text }]))
    })
  }
  for (const extra of info.extra) for (const text of wrapText(extra, width - 2)) out.push([{ text: ' ' }, dim(text, theme)])
  return out
}

const KIND_MARK: Record<ChangelogKind, string> = { Added: '+', Changed: '~', Fixed: '✓', Removed: '−', Deprecated: '!', Security: '!' }

function kindColor(kind: ChangelogKind, theme: Theme): string {
  if (kind === 'Added') return theme.success
  if (kind === 'Changed') return theme.info
  if (kind === 'Fixed') return theme.accent
  if (kind === 'Removed') return theme.error
  return theme.warning
}

/** What's new: the newest release's few lines, one row each, cut with an ellipsis. */
export function newsRows(news: WhatsNew, width: number, theme: Theme): Seg[][] {
  const note: Seg[] = [dim(`v${news.version} · /changelog`, theme), ...(news.fresh ? [{ text: ' ' }, chip('new', theme, 'accent')] : [])]
  const out: Seg[][] = [heading("What's new", note, width, theme)]
  for (const item of news.items) {
    out.push([{ text: ` ${KIND_MARK[item.kind]} `, color: kindColor(item.kind, theme), bold: true }, { text: clipText(item.text, Math.max(1, width - 4)), color: theme.text }])
  }
  return out
}

/** The block ids, in the order Home shows them. */
export type BlockId = 'agents' | 'chats' | 'actions' | 'code' | 'start' | 'news'

/** A brand-new pager (no messages, no contacts, no agents) sees how to get started first; everyone else sees what is running. */
export function blockOrder(stats: HomeStats, agents: HomeAgents, agentsOn: boolean): BlockId[] {
  const fresh = stats.sent + stats.received === 0 && stats.contacts === 0 && agents.rows.length === 0
  const order: BlockId[] = fresh ? ['start', 'actions', 'agents', 'chats', 'news'] : ['agents', 'chats', 'actions', 'code', 'news']
  return order.filter((id) => id !== 'agents' || agentsOn)
}

function block(id: BlockId, i: HomeInput, info: HomeInfo, width: number): Seg[][] {
  if (id === 'agents') return agentRows(i, width)
  if (id === 'chats') return chatRows(i, width)
  if (id === 'actions') return actionRows(i, width)
  if (id === 'code') return codeRows('Contact code', info, false, width, i.theme)
  if (id === 'start') return codeRows('Get started', info, true, width, i.theme)
  return i.news === undefined ? [] : newsRows(i.news, width, i.theme)
}

/** The greeting, the chat and agent summary lines, and the recap of what happened while pager was closed. */
export function headerRows(i: HomeInput, info: HomeInfo, width: number): Seg[][] {
  const name = i.look.me !== DEFAULT_ME ? i.look.me : (info.name ?? DEFAULT_ME)
  const rows: Seg[][] = [greetingSegs(name, i.look.badge, i.hour, i.theme), ...summaryRows(i, width)]
  if (i.recap !== undefined && i.recap !== '') rows.push([{ text: ' ' }, dim(clipText(i.recap, Math.max(1, width - 2)), i.theme)])
  return rows
}

/**
 * The whole Home screen as rows: the header, then the blocks one under another with a blank row between, at most `height` rows of
 * exactly `width` columns, like every other screen. A short pane drops blocks from the bottom (a block is cut to its heading and a row or two, the
 * contact code never in the middle).
 */
export function homeRows(i: HomeInput): Seg[][] {
  const width = Math.max(1, i.width)
  const info = parseInfo(i.info)
  const rows = headerRows(i, info, width)
  for (const id of blockOrder(i.stats, i.agents, i.agentsOn !== false)) {
    const rest = block(id, i, info, width)
    const left = i.height - rows.length - 1
    if (rest.length === 0 || left < Math.min(3, rest.length)) continue
    if ((id === 'code' || id === 'start') && rest.length > left) continue
    rows.push(BLANK, ...rest.slice(0, left))
  }
  return rows.slice(0, Math.max(0, i.height)).map((r) => fitSegs(r, width))
}
