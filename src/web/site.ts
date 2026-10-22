import path from 'node:path'
import { StatsLog, summarize } from '../agents/state/stats.js'
import { AGENT_SUBCOMMANDS, BOT_SUBCOMMANDS, COMMANDS, GROUP_SUBCOMMANDS, SETTINGS_ARGUMENTS } from '../app/commands.js'
import { summarizeTerm, TermUsageLog, type TermSummary } from '../app/usage.js'
import { KEY_SECTIONS } from '../ui/input/keymap.js'

export interface Row {
  usage: string
  summary: string
}
export interface DocsData {
  version: string
  commands: Row[]
  /** Subcommand tables, one per parent command. */
  subcommands: { title: string; rows: Row[] }[]
  keys: { title: string; rows: [string, string][] }[]
  cli: Row[]
  env: Row[]
  features: { title: string; body: string }[]
}

/** What the running pager knows that the data directory does not. */
export interface ChatStats {
  contacts: number
  online: number
  groups: number
  pending: number
  unread: number
  sent: number
  received: number
  week: number[]
  busiest: { title: string; count: number } | null
}
export interface StatsSources {
  dir: string
  version: string
  chat(): ChatStats
  agentUsages(): { agent: string; text: string; at: number }[]
}

const CLI: Row[] = [
  { usage: 'pager', summary: 'Start pager' },
  { usage: 'pager --cwd <dir>', summary: 'Start with the Terminal tab in a folder' },
  { usage: 'pager --lan [host:port]', summary: 'Chat over the local network only' },
  { usage: 'pager --no-agents', summary: 'Turn off the agents room, the AI tab and the agent tool server' },
  { usage: 'pager run [--cwd <dir>] [--] <command...>', summary: 'Run a command in a new Terminal tab of the running pager (or start pager with it)' },
  { usage: 'pager docs', summary: 'Open this documentation and your usage stats in the browser' },
  { usage: 'pager desktop install|uninstall|launch|status', summary: 'Windows: glass window host, Start menu entry, "Open Pager here"' },
  { usage: 'pager update', summary: 'Install the latest release' },
  { usage: 'pager lock | unlock', summary: 'Protect (or stop protecting) your identity key and history with a passphrase' },
  { usage: 'pager -v | --version', summary: 'Print the version' },
]
const ENV: Row[] = [
  { usage: 'PAGER_HOME', summary: 'Data directory (default ~/.pager)' },
  { usage: 'PAGER_BOOTSTRAP', summary: 'Comma-separated host:port DHT bootstrap nodes' },
  { usage: 'PAGER_NO_UPDATE_CHECK', summary: 'Set to 1 to skip the daily check for a newer version' },
  { usage: 'PAGER_PASSPHRASE', summary: 'Passphrase to try first when pager is locked' },
]
const FEATURES = [
  ['Peer-to-peer chat', 'Contacts and groups talk directly over a DHT. No server holds your messages; history is stored locally and can be encrypted with a passphrase.'],
  ['Bots', 'Add AI bots to a DM or a group with /bot add. They answer when called with @name and chime in when their job calls for it. Backends: a ready agent, Ollama or OpenAI.'],
  ['Terminal tabs', 'A real shell on a pseudo-terminal, up to six tabs. Commands become blocks with exit status and timing; select a block to explain it or run a lens over its output.'],
  ['Run from anywhere', '`pager run` and /run open a Terminal tab in a folder and type a command, even from another process. The desktop window forwards its own command line the same way.'],
  ['Coding agents', 'Run agents in isolated git worktrees with /agent: chains, reviews, merge, undo, and a shared room contacts can watch or control.'],
  ['Shared documents', 'Markdown documents shared with a chat (/doc new), edited together with a CRDT, with a built-in Vim mode.'],
  ['Themes', 'Flat and visual themes, accent and density settings, and custom themes you define yourself. All under Settings > Appearance.'],
  ['Desktop window', 'Windows: a pitch-black window with an opt-in glass material, Departure Mono pixel glyphs for the logo and spinners, per-user install without admin.'],
  ['Web and AI tabs', 'Open pages and talk to a local or hosted model without leaving pager.'],
  ['Usage stats', 'This site: messages, agent turns, tokens and terminal commands, all computed from files in your data directory. Nothing leaves your machine.'],
].map(([title, body]) => ({ title: title!, body: body! }))

const rows = (list: readonly Row[]): Row[] => list.map((c) => ({ usage: c.usage, summary: c.summary }))

export function docsData(version: string): DocsData {
  return {
    version,
    commands: rows(COMMANDS),
    subcommands: [
      { title: '/group', rows: rows(GROUP_SUBCOMMANDS) },
      { title: '/bot', rows: rows(BOT_SUBCOMMANDS) },
      { title: '/agent', rows: rows(AGENT_SUBCOMMANDS) },
      { title: '/settings', rows: rows(SETTINGS_ARGUMENTS) },
    ],
    keys: KEY_SECTIONS.map((s) => ({ title: s.title, rows: s.rows.map((r) => [r[0], r[1]]) })),
    cli: CLI,
    env: ENV,
    features: FEATURES,
  }
}

export interface StatsData {
  generatedAt: number
  version: string
  chat: ChatStats
  agents: {
    turns: number
    ms: number
    files: number
    tokensIn: number
    tokensOut: number
    reviews: { approved: number; changes: number }
    week: number[]
    byAgent: { agent: string; cli: string; turns: number; ms: number; files: number; tokensIn: number; tokensOut: number; approved: number; changes: number; lastTs: number }[]
    stops: Record<string, number>
    usages: { agent: string; text: string; at: number }[]
  }
  terminal: TermSummary
}

export function statsData(src: StatsSources, now = Date.now()): StatsData {
  const records = new StatsLog(path.join(src.dir, 'agent-stats.jsonl')).read()
  const { perAgent, week } = summarize(records, now)
  const extra = new Map<string, { cli: string; tokensIn: number; tokensOut: number }>()
  const stops: Record<string, number> = {}
  for (const r of records) {
    if (r.stop === 'review') continue
    stops[r.stop] = (stops[r.stop] ?? 0) + 1
    const e = extra.get(r.agent) ?? { cli: r.cli, tokensIn: 0, tokensOut: 0 }
    e.cli = r.cli
    e.tokensIn += r.tokensIn ?? 0
    e.tokensOut += r.tokensOut ?? 0
    extra.set(r.agent, e)
  }
  const byAgent = Object.entries(perAgent)
    .map(([agent, t]) => ({ agent, cli: extra.get(agent)?.cli ?? '', turns: t.turns, ms: t.ms, files: t.files, tokensIn: extra.get(agent)?.tokensIn ?? 0, tokensOut: extra.get(agent)?.tokensOut ?? 0, approved: t.approved, changes: t.changes, lastTs: t.lastTs }))
    .sort((a, b) => b.turns - a.turns || a.agent.localeCompare(b.agent))
  const sum = (f: (a: (typeof byAgent)[number]) => number): number => byAgent.reduce((n, a) => n + f(a), 0)
  return {
    generatedAt: now,
    version: src.version,
    chat: src.chat(),
    agents: {
      turns: sum((a) => a.turns),
      ms: sum((a) => a.ms),
      files: sum((a) => a.files),
      tokensIn: sum((a) => a.tokensIn),
      tokensOut: sum((a) => a.tokensOut),
      reviews: { approved: sum((a) => a.approved), changes: sum((a) => a.changes) },
      week,
      byAgent,
      stops,
      usages: src.agentUsages(),
    },
    terminal: summarizeTerm(new TermUsageLog(path.join(src.dir, 'terminal-usage.jsonl')).read(), now),
  }
}
