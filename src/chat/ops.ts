import { DOC_PREFIX } from '../docs/store.js'

/** What a text event's body really is: a document operation, a group rename, a reaction or a group bot's message (null = ordinary chat). */
export type EventOp = 'doc' | 'rename' | 'react' | 'bot'

export const RENAME_PREFIX = '⁣grp:'
export const REACT_PREFIX = '⁣rx:'
export const BOT_PREFIX = '⁣bot:'

export function opOf(body: string): EventOp | null {
  if (body.startsWith(DOC_PREFIX)) return 'doc'
  if (body.startsWith(RENAME_PREFIX)) return 'rename'
  if (body.startsWith(REACT_PREFIX)) return 'react'
  if (body.startsWith(BOT_PREFIX)) return 'bot'
  return null
}
