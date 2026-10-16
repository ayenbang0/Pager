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
  { name: 'quit', usage: '/quit', summary: 'Exit pager' },
]

export const GROUP_SUBCOMMANDS: readonly CommandSpec[] = [
  { name: 'new', usage: '/group new <name>', summary: 'Create a group' },
  { name: 'invite', usage: '/group invite <name>', summary: 'Invite a contact (creator only)' },
  { name: 'members', usage: '/group members', summary: 'List members' },
  { name: 'leave', usage: '/group leave', summary: 'Leave this group for good' },
]

/** `line` starts with '/'. `rest` is the text after the first token, trimmed. */
export function parseCommand(line: string): { name: string; args: string[]; rest: string } {
  const body = line.slice(1).trim()
  const m = /^(\S*)\s*([\s\S]*)$/.exec(body)
  const rest = (m?.[2] ?? '').trim()
  return { name: (m?.[1] ?? '').toLowerCase(), args: rest === '' ? [] : rest.split(/\s+/), rest }
}
