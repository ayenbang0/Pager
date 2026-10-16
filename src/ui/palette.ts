import { COMMANDS, GROUP_SUBCOMMANDS, type CommandSpec } from '../commands.js'

const MAX_ROWS = 6
const GROUP_PREFIX = '/group '

/** Slash-command suggestions for the current prompt text. */
export function matchCommands(text: string): CommandSpec[] {
  if (text.startsWith(GROUP_PREFIX)) {
    const typed = text.slice(GROUP_PREFIX.length)
    if (/\s/.test(typed)) return []
    return GROUP_SUBCOMMANDS.filter((c) => c.name.startsWith(typed.toLowerCase())).slice(0, MAX_ROWS)
  }
  if (!text.startsWith('/') || /\s/.test(text)) return []
  const typed = text.slice(1).toLowerCase()
  return COMMANDS.filter((c) => c.name.startsWith(typed)).slice(0, MAX_ROWS)
}

/** Text the prompt becomes when `spec` is chosen from the palette. */
export function completion(text: string, spec: CommandSpec): string {
  return text.startsWith(GROUP_PREFIX) ? `${GROUP_PREFIX}${spec.name} ` : `/${spec.name} `
}
