import { ACCENT_ARGUMENTS, agentArguments, BADGE_ARGUMENTS, COMMANDS, DENSITY_ARGUMENTS, GROUP_SUBCOMMANDS, THEME_ARGUMENTS, type CommandSpec } from '../commands.js'
import { emojiMatches } from '../emoji.js'

const MAX_ROWS = 6
/** Commands whose first argument completes from a fixed list. */
const ARGUMENTS: Record<string, readonly CommandSpec[]> = {
  group: GROUP_SUBCOMMANDS,
  theme: THEME_ARGUMENTS,
  accent: ACCENT_ARGUMENTS,
  badge: BADGE_ARGUMENTS,
  density: DENSITY_ARGUMENTS,
}
const ARGUMENT_RE = /^\/(\S+) (\S*)$/

/** Slash-command suggestions for the current prompt text. `agents` are the ready agents' names, `contacts` the accepted contacts' names. */
export function matchCommands(text: string, agents: readonly string[] = [], contacts: readonly string[] = []): CommandSpec[] {
  const invite = /^\/agent invite (\S*)$/i.exec(text)
  if (invite) {
    const typed = (invite[1] ?? '').toLowerCase()
    return contacts
      .filter((name) => name.toLowerCase().startsWith(typed))
      .slice(0, MAX_ROWS)
      .map((name) => ({ name, usage: `/agent invite ${name}`, summary: 'Invite them to your agents (add --view to let them only watch)' }))
  }
  const arg = ARGUMENT_RE.exec(text)
  if (arg) {
    const command = (arg[1] ?? '').toLowerCase()
    const typed = (arg[2] ?? '').toLowerCase()
    const specs = command === 'agent' ? agentArguments(agents) : Object.hasOwn(ARGUMENTS, command) ? ARGUMENTS[command] : undefined
    return (specs ?? []).filter((c) => c.name.startsWith(typed)).slice(0, MAX_ROWS)
  }
  if (!text.startsWith('/') || /\s/.test(text)) return []
  const typed = text.slice(1).toLowerCase()
  return COMMANDS.filter((c) => c.name.startsWith(typed)).slice(0, MAX_ROWS)
}

/** Text the prompt becomes when `spec` is chosen from the palette: its name replaces the last word. */
export function completion(text: string, spec: CommandSpec): string {
  const space = text.lastIndexOf(' ')
  return space === -1 ? `/${spec.name} ` : `${text.slice(0, space)} ${spec.name} `
}

/** One row of the menu above the prompt. Picking it replaces `text[from, to)` with `insert`. */
export interface MenuItem {
  label: string
  summary: string
  insert: string
  from: number
  to: number
}

/** A `:name` of at least two characters ending the text, at the start or after a space. */
const EMOJI_FRAGMENT = /(?:^|\s)(:[a-z0-9_+-]{2,})$/

/** Emoji suggestions for a `:name` fragment at the end of `before`, the text left of the cursor; `after` is the text right of it. Slash lines never get them. */
export function matchEmoji(before: string, after = ''): MenuItem[] {
  const fragment = EMOJI_FRAGMENT.exec(before)?.[1]
  if (fragment === undefined || before.startsWith('/')) return []
  return emojiMatches(fragment.slice(1), MAX_ROWS).map(({ name, char }) => ({
    label: `${char} :${name}:`,
    summary: '',
    insert: /^\s/.test(after) ? char : `${char} `,
    from: before.length - fragment.length,
    to: before.length,
  }))
}

/** One agent's advertised slash commands, offered in the `/` menu while its tab is active. */
export interface AgentMenu {
  agent: string
  commands: readonly { name: string; description: string; hint?: string }[]
}

/** Rows the agent's own commands add below the pager commands. */
const AGENT_ROWS = 5

/**
 * The agent's commands matching a `/word` being typed. Pager commands win a name clash, so a clashing command is offered only
 * in its long form (`/agent <name> /<cmd>`), which is how it reaches the agent.
 */
function agentMatches(text: string, menu: AgentMenu): MenuItem[] {
  if (!text.startsWith('/') || /\s/.test(text)) return []
  const typed = text.slice(1).toLowerCase()
  return menu.commands
    .filter((c) => c.name.toLowerCase().startsWith(typed))
    .slice(0, AGENT_ROWS)
    .map((c) => {
      const clash = COMMANDS.some((p) => p.name === c.name.toLowerCase())
      const hint = c.hint === undefined || c.hint === '' ? '' : ` <${c.hint}>`
      return {
        label: clash ? `/agent ${menu.agent} /${c.name}${hint}` : `/${c.name}${hint}`,
        summary: `${menu.agent} · ${c.description}`,
        insert: clash ? `/agent ${menu.agent} /${c.name} ` : `/${c.name} `,
        from: 0,
        to: text.length,
      }
    })
}

/**
 * The menu for the prompt: pager command completions while a `/` menu is open, then the active agent's own commands,
 * else emoji for a `:name` before the cursor when `emoji` is allowed.
 */
export function menuItems(text: string, cursor: number, emoji: boolean, agents: readonly string[] = [], agentMenu?: AgentMenu, contacts: readonly string[] = []): MenuItem[] {
  const commands: MenuItem[] = matchCommands(text, agents, contacts).map((spec) => ({ label: spec.usage, summary: spec.summary, insert: completion(text, spec), from: 0, to: text.length }))
  const own = agentMenu === undefined ? [] : agentMatches(text, agentMenu)
  if (commands.length > 0 || own.length > 0) return [...commands, ...own]
  return emoji ? matchEmoji(text.slice(0, cursor), text.slice(cursor)) : []
}
