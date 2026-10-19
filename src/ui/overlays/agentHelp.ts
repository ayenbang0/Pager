import type { AgentView } from '../../agents/types.js'
import { ageText } from '../home/homeAgents.js'
import type { KeySection } from '../input/keymap.js'

export interface AgentHelpCommand {
  name: string
  description: string
  hint?: string
}

export interface AgentHelpInput {
  agents: readonly AgentView[]
  commandsOf(name: string): readonly AgentHelpCommand[]
  usageOf(name: string): { text: string; at: number } | undefined
  now: number
}

/** One help section per ready agent: how to talk to it, what it advertises, and its model, effort and usage. */
export function agentHelpSections(input: AgentHelpInput): KeySection[] {
  return input.agents.map((a): KeySection => {
    const commands = input.commandsOf(a.name)
    const usage = input.usageOf(a.name)
    const usageLine = usage?.text.split('\n').map((l) => l.trim()).find((l) => l !== '')
    const pct = a.contextPct === undefined ? undefined : Math.round(a.contextPct * 100)
    const rows: [string, string][] = [
      [`@${a.name} <message>`, `Talk to it from any chat, or open its tab (${a.cli})`],
      ['Alt+M', `Model ${a.model ?? 'default'} · effort ${a.effort ?? 'default'}${pct === undefined ? '' : ` · context ${pct}%`}; /agent model ${a.name} <value> sets it directly`],
      [`/agent usage ${a.name}`, usage === undefined || usageLine === undefined ? 'Provider limits and context use' : `${usageLine} (${ageText(input.now - usage.at)})`],
    ]
    if (commands.some((c) => c.name === 'compact')) rows.push([`/agent compact ${a.name}`, 'Shrink its context'])
    if (commands.length === 0) rows.push(['commands', 'None advertised yet: they appear after its first message'])
    else {
      rows.push([`/agent ${a.name} /<cmd>`, 'Run any of these from any tab; inside its tab just type /<cmd>'])
      for (const c of commands) rows.push([`/${c.name}${c.hint === undefined || c.hint === '' ? '' : ` <${c.hint}>`}`, c.description])
    }
    return { title: `Agent ${a.name} (${a.cli})`, rows, agent: a.name }
  })
}
