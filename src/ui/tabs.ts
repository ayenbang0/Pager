import type { ConvView } from '../engine.js'
import { agentTabId, sharedTabId } from '../agents/ids.js'
import { ROOM_ID } from '../agents/orchestrator.js'
import { TERM_ID } from '../terminal.js'
import { DOCS_ID } from '../docs/store.js'

/** The sidebar's three groups, as tab ids. `null` is the home tab. */
export interface TabGroups {
  home: null
  chats: string[]
  tools: string[]
}

/** People, groups, the all-agents hub, one tab per ready agent and one per shared agent session (by host key); terminal and docs under tools. */
export function tabGroups(convs: readonly ConvView[], agents: readonly string[], shared: readonly string[] = []): TabGroups {
  return {
    home: null,
    chats: [
      ...convs.filter((c) => c.kind === 'dm').map((c) => c.id),
      ...convs.filter((c) => c.kind === 'group').map((c) => c.id),
      ROOM_ID,
      ...agents.map(agentTabId),
      ...shared.map(sharedTabId),
    ],
    tools: [TERM_ID, DOCS_ID],
  }
}

/** Sidebar order, top to bottom; Alt+Up/Down walks exactly this list. */
export const tabOrder = (g: TabGroups): (string | null)[] => [g.home, ...g.chats, ...g.tools]
