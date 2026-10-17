/** Tab id of one agent's own chat. */
export const AGENT_TAB_PREFIX = 'agent:'

export const agentTabId = (name: string): string => `${AGENT_TAB_PREFIX}${name}`

/** Tab id of a shared agent session; the part after the prefix is the host's public key. */
export const SHARED_TAB_PREFIX = 'shared:'

export const sharedTabId = (hostPk: string): string => `${SHARED_TAB_PREFIX}${hostPk}`

/** The host's public key behind a shared-session tab id, or undefined for every other tab. */
export const parseSharedTab = (id: string | null): string | undefined =>
  id?.startsWith(SHARED_TAB_PREFIX) === true ? id.slice(SHARED_TAB_PREFIX.length) : undefined

/** The agent name behind a tab id, or undefined for every other tab. */
export const parseAgentTab = (id: string | null): string | undefined =>
  id?.startsWith(AGENT_TAB_PREFIX) === true ? id.slice(AGENT_TAB_PREFIX.length) : undefined
