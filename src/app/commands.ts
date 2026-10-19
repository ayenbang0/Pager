export interface CommandSpec {
  name: string
  usage: string
  summary: string
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'help', usage: '/help', summary: 'List commands' },
  { name: 'code', usage: '/code', summary: 'Show your contact code' },
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
  { name: 'changelog', usage: '/changelog [version]', summary: 'Show what changed in recent updates' },
  { name: 'search', usage: '/search <text>', summary: 'Find text in your chats and the agent room (newest 20 matches)' },
  { name: 'settings', usage: '/settings [section]', summary: 'Open Settings' },
  { name: 'quit', usage: '/quit', summary: 'Exit pager' },
  { name: 'exit', usage: '/exit', summary: 'Exit pager (same as /quit)' },
]

export const GROUP_SUBCOMMANDS: readonly CommandSpec[] = [
  { name: 'new', usage: '/group new <name>', summary: 'Create a group' },
  { name: 'invite', usage: '/group invite <name>', summary: 'Invite a contact (creator only)' },
  { name: 'members', usage: '/group members', summary: 'List members' },
  { name: 'leave', usage: '/group leave', summary: 'Leave this group for good' },
]

export const SETTINGS_SECTIONS_KEYS = ['profile', 'appearance', 'notifications', 'folders', 'agents', 'ai', 'privacy', 'updates', 'advanced'] as const

export const SETTINGS_ARGUMENTS: readonly CommandSpec[] = SETTINGS_SECTIONS_KEYS.map((k) => ({ name: k, usage: `/settings ${k}`, summary: `Open Settings at ${k}` }))

/** Commands that moved into the Settings tab, and the section that now holds each. */
export const MOVED: Readonly<Record<string, string>> = {
  name: 'Profile',
  badge: 'Profile',
  theme: 'Appearance',
  accent: 'Appearance',
  density: 'Appearance',
  notify: 'Notifications',
  sound: 'Notifications',
  net: 'Privacy and Network',
}

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
  { name: 'budget', usage: '/agent budget [<name|all> turns=<N> minutes=<N>|off]', summary: 'Show or set daily turn/minute caps per agent' },
  { name: 'compact', usage: '/agent compact <name> [handoff|shake]', summary: "Shrink an agent's context" },
  { name: 'review', usage: '/agent review on|off', summary: 'Automatic peer review after file changes' },
  { name: 'risk', usage: '/agent risk on|off', summary: 'Ask before risky agent actions (push, rm -rf, publish…)' },
  { name: 'goal', usage: '/agent goal <text>', summary: 'Set the shared goal every agent sees' },
  { name: 'runs', usage: '/agent runs', summary: 'List agent runs' },
  { name: 'stop', usage: '/agent stop [name|run]', summary: 'Stop running agents' },
  { name: 'merge', usage: '/agent merge <name|run> [--force]', summary: "Merge an agent's branch into this one (--force skips the verify check)" },
  { name: 'verify', usage: '/agent verify [<command>|off]', summary: 'Show or set the check run in each worktree after a turn and before a merge' },
  { name: 'log', usage: '/agent log <run|name>', summary: "Show the last verify output for an agent's branch" },
  { name: 'drop', usage: '/agent drop <run|all|name>', summary: 'Discard run records, or an agent workspace' },
  { name: 'reset', usage: '/agent reset <name>', summary: "Forget an agent's saved session" },
  { name: 'undo', usage: '/agent undo <name> [n]', summary: "Put an agent's worktree back to before its last turn(s)" },
  { name: 'checkpoints', usage: '/agent checkpoints <name>', summary: "List the turns of an agent that /agent undo can take back" },
  { name: 'cli', usage: '/agent cli <name> <args>', summary: "Run an agent's own CLI command (mcp list, models, ...)" },
  { name: 'commands', usage: '/agent commands <name>', summary: "List an agent's slash commands" },
  { name: 'memory', usage: '/agent memory [add <text>|clear]', summary: "Show or edit this repository's shared agent notes" },
  { name: 'check', usage: '/agent check [name]', summary: 'Test that each agent CLI responds' },
  { name: 'invite', usage: '/agent invite <contact> [--view]', summary: 'Let a contact into your agent room (they can control it, or only watch with --view)' },
  { name: 'guests', usage: '/agent guests', summary: 'List who is in your shared agent session' },
  { name: 'kick', usage: '/agent kick <contact|all>', summary: 'Remove a guest from your shared agent session' },
  { name: 'leave', usage: '/agent leave [host]', summary: "Leave someone else's shared agent session" },
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
