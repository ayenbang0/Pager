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
  { name: 'group', usage: '/group new|invite|rename|members|leave', summary: 'Manage groups' },
  { name: 'bot', usage: '/bot add|edit|model|effort|list', summary: 'AI bots in the open group that reply when relevant' },
  { name: 'call', usage: '/call [room|setup]', summary: 'Voice call in the open chat, or a named room in a group' },
  { name: 'hangup', usage: '/hangup', summary: 'Leave the call' },
  { name: 'mute', usage: '/mute', summary: 'Mute or unmute your microphone' },
  { name: 'ping', usage: '/ping <name>', summary: 'Play a sound on their machine' },
  { name: 'requests', usage: '/requests', summary: 'Requests and invites to accept or decline' },
  { name: 'terminal', usage: '/terminal [new|close]', summary: 'Open the Terminal tab (new: another one, close: this one)' },
  { name: 'run', usage: '/run [--cwd <dir>] <command>', summary: 'Run a command in a new terminal tab' },
  { name: 'docs', usage: '/docs', summary: 'Open the local docs and your usage stats in the browser pane' },
  { name: 'studio', usage: '/studio', summary: 'Open the bot studio: personas, triggers, test runs' },
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
  { name: 'rename', usage: '/group rename <new name>', summary: 'Rename this group (creator only)' },
  { name: 'members', usage: '/group members', summary: 'People, bots and call rooms' },
  { name: 'leave', usage: '/group leave', summary: 'Leave this group for good' },
]

export const BOT_SUBCOMMANDS: readonly CommandSpec[] = [
  { name: 'add', usage: '/bot add <name> [@backend] <job>', summary: 'Add a bot to this group (backend: a ready agent, ollama or openai)' },
  { name: 'edit', usage: '/bot edit <name> [@backend] [job]', summary: "Change a bot's backend or job" },
  { name: 'model', usage: '/bot model <name> [model|default]', summary: "Set a bot's model (no value lists the choices)" },
  { name: 'effort', usage: '/bot effort <name> [level|default]', summary: "Set a bot's thinking effort (agent CLIs)" },
  { name: 'remove', usage: '/bot remove <name>', summary: 'Remove a bot and its sandbox folder' },
  { name: 'list', usage: '/bot list', summary: 'The group screen: people, bots and calls' },
  { name: 'stop', usage: '/bot stop', summary: 'Stop the bots that are thinking here' },
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

/** Subcommands of `/agent` that do not depend on which agents exist. The rest moved to Settings > Agents and the palette. */
export const AGENT_SUBCOMMANDS: readonly CommandSpec[] = [
  { name: 'chain', usage: '/agent chain a>b <task>', summary: 'Run agents in turn; each reviews the previous work' },
  { name: 'runs', usage: '/agent runs', summary: 'List agent runs' },
  { name: 'stop', usage: '/agent stop [name|run]', summary: 'Stop running agents' },
  { name: 'merge', usage: '/agent merge <name|run> [--force]', summary: "Merge an agent's branch into this one (--force skips the verify check)" },
  { name: 'drop', usage: '/agent drop <run|all|name>', summary: 'Discard run records, or an agent workspace' },
  { name: 'undo', usage: '/agent undo <name> [n]', summary: "Put an agent's worktree back to before its last turn(s)" },
  { name: 'log', usage: '/agent log <run|name>', summary: "Show the last verify output for an agent's branch" },
  { name: 'invite', usage: '/agent invite <contact> [--view]', summary: 'Let a contact into your agent room (they can control it, or only watch with --view)' },
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
