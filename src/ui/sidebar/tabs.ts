import type { ConvView } from '../../app/engine.js'
import { agentTabId, sharedTabId } from '../../agents/ids.js'
import { ROOM_ID } from '../../agents/orchestrator.js'
import { AI_ID } from '../../ai/chat.js'
import { fileable } from '../../app/folders.js'
import type { Folder } from '../../app/settings.js'
import { SETTINGS_ID } from '../../app/settingsView.js'
import { DOCS_ID } from '../../docs/store.js'
import { WEB_ID } from '../../tools/web/tool.js'

export type SectionKey = 'pending' | 'direct' | 'groups' | 'agents' | 'tools' | `folder:${string}`

export type SidebarEntry =
  /** HOME and PENDING headers: not foldable. */
  | { kind: 'static'; title: string }
  | { kind: 'header'; key: SectionKey; title: string; open: boolean; count: number }
  /** `null` is the Home tab. */
  | { kind: 'tab'; id: string | null }
  /** An invite or contact request waiting for /accept; not clickable. */
  | { kind: 'pending'; n: number }

export interface SidebarInput {
  convs: readonly ConvView[]
  pendingCount: number
  agentNames: readonly string[]
  shared: readonly string[]
  agentsOn: boolean
  folders: readonly Folder[]
  collapsed: ReadonlySet<string>
  activeId: string | null
  /** Terminal tab ids, in order. */
  terminals: readonly string[]
}

export { fileable }

/** The sidebar as a flat list: what is drawn, what a click hits and what Alt+Up/Down walks. */
export function sidebarEntries(input: SidebarInput): SidebarEntry[] {
  const { convs, agentsOn, folders, collapsed, activeId, terminals } = input
  const filed = new Set(folders.flatMap((f) => f.ids))
  const out: SidebarEntry[] = [{ kind: 'static', title: 'HOME' }, { kind: 'tab', id: null }]
  if (input.pendingCount > 0) {
    out.push({ kind: 'static', title: 'PENDING' })
    for (let n = 1; n <= input.pendingCount; n++) out.push({ kind: 'pending', n })
  }
  const section = (key: SectionKey, title: string, ids: readonly string[]): void => {
    const open = !collapsed.has(key)
    out.push({ kind: 'header', key, title, open, count: ids.length })
    for (const id of ids) if (open || id === activeId) out.push({ kind: 'tab', id })
  }
  for (const f of folders) {
    const ids = f.ids.filter((id) => fileable(id, convs, agentsOn))
    section(`folder:${f.name}`, f.name, ids)
  }
  const unfiled = (id: string): boolean => !filed.has(id)
  const direct = convs.filter((c) => c.kind === 'dm' && unfiled(c.id)).map((c) => c.id)
  const groups = convs.filter((c) => c.kind === 'group' && unfiled(c.id)).map((c) => c.id)
  if (direct.length > 0) section('direct', 'DIRECT', direct)
  if (groups.length > 0) section('groups', 'GROUPS', groups)
  if (agentsOn) {
    const ids = [...[ROOM_ID, AI_ID].filter(unfiled), ...input.agentNames.map(agentTabId), ...input.shared.map(sharedTabId)]
    section('agents', 'AGENTS', ids)
  }
  section('tools', 'TOOLS', [...terminals, ...[DOCS_ID].filter(unfiled), WEB_ID, SETTINGS_ID])
  return out
}

/** The tab ids on screen, top to bottom (Home first); Alt+Up/Down walks exactly this list. */
export const visibleTabIds = (entries: readonly SidebarEntry[]): (string | null)[] => entries.flatMap((e) => (e.kind === 'tab' ? [e.id] : []))

/** The entry under 1-based sidebar row `row`, given how far the list is scrolled. */
export function sidebarHit(entries: readonly SidebarEntry[], scroll: number, row: number): SidebarEntry | undefined {
  return row < 1 ? undefined : entries[scroll + row - 1]
}

/** The index of the entry showing `id`, or -1. */
export const entryIndexOf = (entries: readonly SidebarEntry[], id: string | null): number => entries.findIndex((e) => e.kind === 'tab' && e.id === id)
