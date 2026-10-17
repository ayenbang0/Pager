/** Tab id of one agent's own chat. */
export const AGENT_TAB_PREFIX = 'agent:'

export const agentTabId = (name: string): string => `${AGENT_TAB_PREFIX}${name}`

/** The agent name behind a tab id, or undefined for every other tab. */
export const parseAgentTab = (id: string | null): string | undefined =>
  id?.startsWith(AGENT_TAB_PREFIX) === true ? id.slice(AGENT_TAB_PREFIX.length) : undefined
