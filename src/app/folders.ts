import { ROOM_ID } from '../agents/orchestrator.js'
import { AI_ID } from '../ai/chat.js'
import { DOCS_ID } from '../docs/store.js'
import type { Folder } from './settings.js'

/** Ids that can be filed into a folder: chats, groups, the agents room, docs and the AI tab. */
export function fileable(id: string | null, convs: readonly { id: string }[], agentsOn: boolean): boolean {
  if (id === null) return false
  if (id === DOCS_ID) return true
  if (id === ROOM_ID || id === AI_ID) return agentsOn
  return convs.some((c) => c.id === id)
}

/** The folder that holds `id`, if any. */
export const folderOf = (folders: readonly Folder[], id: string): Folder | undefined => folders.find((f) => f.ids.includes(id))

/** `folders` with `id` taken out of every folder and, when `to` is given, appended to that folder. */
export function filed(folders: readonly Folder[], id: string, to: string | null): Folder[] {
  return folders.map((f) => {
    const ids = f.ids.filter((x) => x !== id)
    return f.name === to ? { ...f, ids: [...ids, id] } : { ...f, ids }
  })
}
