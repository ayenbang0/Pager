import { DOC_PREFIX } from '../docs/store.js'

/** What a text event's body really is: a document operation, a group rename or a reaction (null = ordinary chat). */
export type EventOp = 'doc' | 'rename' | 'react'

export const RENAME_PREFIX = '⁣grp:'
export const REACT_PREFIX = '⁣rx:'

export function opOf(body: string): EventOp | null {
  if (body.startsWith(DOC_PREFIX)) return 'doc'
  if (body.startsWith(RENAME_PREFIX)) return 'rename'
  if (body.startsWith(REACT_PREFIX)) return 'react'
  return null
}
