import { AGENT_NAMES } from './agents/adapters.js'
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
  { name: 'agent', usage: '/agent <name> <task>', summary: 'Run coding agents in isolated worktrees' },
  { name: 'update', usage: '/update', summary: 'Check for a newer pager version' },
  { name: 'theme', usage: '/theme [name]', summary: 'Show or switch the color theme' },
  { name: 'quit', usage: '/quit', summary: 'Exit pager' },
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

export const AGENT_ARGUMENTS: readonly CommandSpec[] = [
  ...AGENT_NAMES.map((n) => ({ name: n, usage: `/agent ${n} <task>`, summary: `Ask ${n}` })),
  { name: 'runs', usage: '/agent runs', summary: 'List agent runs' },
  { name: 'stop', usage: '/agent stop [run]', summary: 'Stop running agents' },
  { name: 'merge', usage: '/agent merge <run>', summary: 'Merge a finished run into this branch' },
  { name: 'drop', usage: '/agent drop <run|all>', summary: 'Discard finished runs' },
  { name: 'cli', usage: '/agent cli <name> <args>', summary: "Run an agent's own CLI command (mcp list, models, ...)" },
  { name: 'check', usage: '/agent check', summary: 'Test that each agent CLI responds' },
]

/** `line` starts with '/'. `rest` is the text after the first token, trimmed. */
export function parseCommand(line: string): { name: string; args: string[]; rest: string } {
  const body = line.slice(1).trim()
  const m = /^(\S*)\s*([\s\S]*)$/.exec(body)
  const rest = (m?.[2] ?? '').trim()
  return { name: (m?.[1] ?? '').toLowerCase(), args: rest === '' ? [] : rest.split(/\s+/), rest }
}
