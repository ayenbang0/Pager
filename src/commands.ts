import { COLOR_WORDS } from './colors.js'
import { DENSITIES } from './settings.js'
import { THEMES } from './themes.js'

export interface CommandSpec {
  name: string
  usage: string
  summary: string
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'help', usage: '/help', summary: 'List commands' },
  { name: 'code', usage: '/code', summary: 'Show your contact code' },
  { name: 'name', usage: '/name <new name>', summary: 'Change your display name' },
  { name: 'add', usage: '/add <code> [note]', summary: 'Send a contact request' },
  { name: 'accept', usage: '/accept [n]', summary: 'Accept a pending request or invite' },
  { name: 'decline', usage: '/decline [n]', summary: 'Decline a pending request or invite' },
  { name: 'open', usage: '/open <name>', summary: 'Open a conversation' },
  { name: 'remove', usage: '/remove <name>', summary: 'Remove a contact' },
  { name: 'group', usage: '/group new|invite|members|leave', summary: 'Manage groups' },
  { name: 'terminal', usage: '/terminal', summary: 'Open the built-in terminal tab' },
  { name: 'doc', usage: '/doc new <name> [in <chat>]', summary: 'Shared Markdown documents (Docs tab)' },
  { name: 'agent', usage: '/agent <name> <task>', summary: 'Run coding agents in isolated worktrees' },
  { name: 'update', usage: '/update', summary: 'Check for a newer pager version' },
  { name: 'theme', usage: '/theme [name]', summary: 'Open the theme picker, or switch theme by name' },
  { name: 'accent', usage: '/accent <color|#hex|auto>', summary: 'Recolor the accent everywhere (auto resets it)' },
  { name: 'badge', usage: '/badge <emoji|none|auto>', summary: 'The glyph shown beside your name' },
  { name: 'density', usage: '/density compact|cozy|roomy', summary: 'Spacing between messages' },
  { name: 'quit', usage: '/quit', summary: 'Exit pager' },
  { name: 'notify', usage: '/notify on|off', summary: 'Desktop notifications outside the terminal' },
  { name: 'sound', usage: '/sound on|off', summary: 'Chime with each notification' },
  { name: 'exit', usage: '/exit', summary: 'Exit pager (same as /quit)' },
]

export const GROUP_SUBCOMMANDS: readonly CommandSpec[] = [
  { name: 'new', usage: '/group new <name>', summary: 'Create a group' },
  { name: 'invite', usage: '/group invite <name>', summary: 'Invite a contact (creator only)' },
  { name: 'members', usage: '/group members', summary: 'List members' },
  { name: 'leave', usage: '/group leave', summary: 'Leave this group for good' },
]

export const THEME_ARGUMENTS: readonly CommandSpec[] = THEMES.map((t) => ({
  name: t.name,
  usage: `/theme ${t.name}`,
  summary: t.description,
}))

export const ACCENT_ARGUMENTS: readonly CommandSpec[] = ['auto', ...COLOR_WORDS].map((c) => ({
  name: c,
  usage: `/accent ${c}`,
  summary: c === 'auto' ? "Use the theme's own accent" : `Accent ${c}`,
}))

const BADGE_CHOICES: readonly [string, string][] = [
  ['auto', 'A glyph chosen from your name'],
  ['none', 'No badge'],
  [':rocket:', '🚀'],
  [':fire:', '🔥'],
  [':sparkles:', '✨'],
  [':crown:', '👑'],
  [':zap:', '⚡'],
  [':skull:', '💀'],
]

export const BADGE_ARGUMENTS: readonly CommandSpec[] = BADGE_CHOICES.map(([name, summary]) => ({ name, usage: `/badge ${name}`, summary }))

const DENSITY_NOTES: Record<(typeof DENSITIES)[number], string> = {
  compact: 'One row per message',
  cozy: 'A header row for each speaker (default)',
  roomy: 'A header row and a blank row between speakers',
}

export const DENSITY_ARGUMENTS: readonly CommandSpec[] = DENSITIES.map((d) => ({ name: d, usage: `/density ${d}`, summary: DENSITY_NOTES[d] }))

/** Subcommands of `/agent` that do not depend on which agents exist. */
const AGENT_SUBCOMMANDS: readonly CommandSpec[] = [
  { name: 'new', usage: '/agent new <cli> [name]', summary: 'Add a teammate (omp-2, or a name you pick)' },
  { name: 'color', usage: '/agent color <name> <color|auto>', summary: "Give an agent its own color (sidebar, messages, tabs)" },
  { name: 'setup', usage: '/agent setup', summary: 'See which agents are installed and add them' },
  { name: 'add', usage: '/agent add <id> <command…>', summary: 'Register a custom agent that speaks ACP over stdio' },
  { name: 'remove', usage: '/agent remove <name>', summary: 'Remove a teammate' },
  { name: 'chain', usage: '/agent chain a>b <task>', summary: 'Run agents in turn; each reviews the previous work' },
  { name: 'model', usage: '/agent model <name> [model]', summary: "Pick an agent's model (no value opens the picker)" },
  { name: 'effort', usage: '/agent effort <name> [level]', summary: "Pick an agent's thinking effort" },
  { name: 'usage', usage: '/agent usage [name]', summary: 'Show provider limits and context use' },
  { name: 'compact', usage: '/agent compact <name> [handoff|shake]', summary: "Shrink an agent's context" },
  { name: 'review', usage: '/agent review on|off', summary: 'Automatic peer review after file changes' },
  { name: 'goal', usage: '/agent goal <text>', summary: 'Set the shared goal every agent sees' },
  { name: 'runs', usage: '/agent runs', summary: 'List agent runs' },
  { name: 'stop', usage: '/agent stop [name|run]', summary: 'Stop running agents' },
  { name: 'merge', usage: '/agent merge <name|run>', summary: "Merge an agent's branch into this one" },
  { name: 'drop', usage: '/agent drop <run|all|name>', summary: 'Discard run records, or an agent workspace' },
  { name: 'reset', usage: '/agent reset <name>', summary: "Forget an agent's saved session" },
  { name: 'cli', usage: '/agent cli <name> <args>', summary: "Run an agent's own CLI command (mcp list, models, ...)" },
  { name: 'commands', usage: '/agent commands <name>', summary: "List an agent's slash commands" },
  { name: 'memory', usage: '/agent memory [add <text>|clear]', summary: "Show or edit this repository's shared agent notes" },
  { name: 'check', usage: '/agent check [name]', summary: 'Test that each agent CLI responds' },
]

/** The `/agent` argument menu: the ready agents first, then the fixed subcommands. */
export const agentArguments = (names: readonly string[]): readonly CommandSpec[] => [
  ...names.map((n) => ({ name: n, usage: `/agent ${n} <task>`, summary: `Ask ${n}` })),
  ...AGENT_SUBCOMMANDS,
]

/** `line` starts with '/'. `rest` is the text after the first token, trimmed. */
export function parseCommand(line: string): { name: string; args: string[]; rest: string } {
  const body = line.slice(1).trim()
  const m = /^(\S*)\s*([\s\S]*)$/.exec(body)
  const rest = (m?.[2] ?? '').trim()
  return { name: (m?.[1] ?? '').toLowerCase(), args: rest === '' ? [] : rest.split(/\s+/), rest }
}
