import { COMMANDS, GROUP_SUBCOMMANDS, THEME_ARGUMENTS, type CommandSpec } from '../commands.js'

const MAX_ROWS = 6
/** Commands whose first argument completes from a fixed list. */
const ARGUMENTS: Record<string, readonly CommandSpec[]> = { group: GROUP_SUBCOMMANDS, theme: THEME_ARGUMENTS }
const ARGUMENT_RE = /^\/(\S+) (\S*)$/

/** Slash-command suggestions for the current prompt text. */
export function matchCommands(text: string): CommandSpec[] {
  const arg = ARGUMENT_RE.exec(text)
  if (arg) {
    const command = (arg[1] ?? '').toLowerCase()
    const typed = (arg[2] ?? '').toLowerCase()
    const specs = Object.hasOwn(ARGUMENTS, command) ? ARGUMENTS[command] : undefined
    return (specs ?? []).filter((c) => c.name.startsWith(typed)).slice(0, MAX_ROWS)
  }
  if (!text.startsWith('/') || /\s/.test(text)) return []
  const typed = text.slice(1).toLowerCase()
  return COMMANDS.filter((c) => c.name.startsWith(typed)).slice(0, MAX_ROWS)
}

/** Text the prompt becomes when `spec` is chosen from the palette. */
export function completion(text: string, spec: CommandSpec): string {
  const space = text.indexOf(' ')
  return space === -1 ? `/${spec.name} ` : `${text.slice(0, space)} ${spec.name} `
}
