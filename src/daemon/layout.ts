import type { Node, Session, Tab } from './protocol.js'

// Pane trees. Pure and immutable: every operation returns a new tree, the daemon swaps it in.

export const MIN_RATIO = 0.1
export const MAX_RATIO = 0.9

export const clampRatio = (r: number): number => (Number.isFinite(r) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)) : 0.5)

export function paneIds(node: Node): string[] {
  return node.type === 'pane' ? [node.paneId] : [...paneIds(node.a), ...paneIds(node.b)]
}

export const hasPane = (node: Node, paneId: string): boolean => paneIds(node).includes(paneId)

/** Replaces the leaf `paneId` with a split holding it and `newId` (after it, or before it). */
export function splitPane(root: Node, paneId: string, dir: 'row' | 'col', newId: string, opts: { before?: boolean; ratio?: number } = {}): Node {
  const ratio = clampRatio(opts.ratio ?? 0.5)
  const go = (n: Node): Node => {
    if (n.type === 'pane') {
      if (n.paneId !== paneId) return n
      const fresh: Node = { type: 'pane', paneId: newId }
      return opts.before ? { type: 'split', dir, ratio: 1 - ratio, a: fresh, b: n } : { type: 'split', dir, ratio, a: n, b: fresh }
    }
    return { ...n, a: go(n.a), b: go(n.b) }
  }
  return go(root)
}

/** Removes a leaf; its sibling takes the place of their parent. Null when it was the only pane. */
export function removePane(root: Node, paneId: string): Node | null {
  if (root.type === 'pane') return root.paneId === paneId ? null : root
  const a = removePane(root.a, paneId)
  const b = removePane(root.b, paneId)
  if (a === null) return b
  if (b === null) return a
  return a === root.a && b === root.b ? root : { ...root, a, b }
}

/** Sets the divider of the split that directly holds `paneId` (on either side); `ratio` is the share of that split's first child. */
export function setRatio(root: Node, paneId: string, ratio: number): Node {
  if (root.type === 'pane') return root
  const direct = (root.a.type === 'pane' && root.a.paneId === paneId) || (root.b.type === 'pane' && root.b.paneId === paneId)
  if (direct) return { ...root, ratio: clampRatio(ratio) }
  return hasPane(root.a, paneId) ? { ...root, a: setRatio(root.a, paneId, ratio) } : { ...root, b: setRatio(root.b, paneId, ratio) }
}

/** Which pane to focus after `paneId` closes: the nearest leaf of its sibling subtree. */
export function focusAfterClose(root: Node, paneId: string): string | undefined {
  if (root.type === 'pane') return undefined
  for (const [mine, other] of [[root.a, root.b], [root.b, root.a]] as const) {
    if (mine.type === 'pane' && mine.paneId === paneId) return paneIds(other)[mine === root.a ? 0 : paneIds(other).length - 1]
    if (hasPane(mine, paneId)) return focusAfterClose(mine, paneId) ?? paneIds(other)[0]
  }
  return undefined
}

export interface Located {
  session: Session
  tab: Tab
}

export function locatePane(sessions: readonly Session[], paneId: string): Located | undefined {
  for (const session of sessions) for (const tab of session.tabs) if (hasPane(tab.root, paneId)) return { session, tab }
  return undefined
}

export function locateTab(sessions: readonly Session[], tabId: string): Located | undefined {
  for (const session of sessions) {
    const tab = session.tabs.find((t) => t.id === tabId)
    if (tab !== undefined) return { session, tab }
  }
  return undefined
}

/** Takes `paneId` out of its tab. The tab is removed when that empties it (its session keeps its other tabs). Returns where it was. */
export function detachPane(sessions: Session[], paneId: string): { located: Located; tabClosed: boolean } | undefined {
  const located = locatePane(sessions, paneId)
  if (located === undefined) return undefined
  const { session, tab } = located
  const next = focusAfterClose(tab.root, paneId)
  const root = removePane(tab.root, paneId)
  if (root === null) {
    const i = session.tabs.indexOf(tab)
    session.tabs.splice(i, 1)
    if (session.activeTab === tab.id) session.activeTab = (session.tabs[Math.min(i, session.tabs.length - 1)] ?? { id: '' }).id
    return { located, tabClosed: true }
  }
  tab.root = root
  if (tab.focus === paneId) tab.focus = next ?? paneIds(root)[0]!
  return { located, tabClosed: false }
}

/** Moves a pane into another tab, beside that tab's focused pane. Returns false if either end is missing. */
export function movePane(sessions: Session[], paneId: string, toTabId: string): boolean {
  const from = locatePane(sessions, paneId)
  const to = locateTab(sessions, toTabId)
  if (from === undefined || to === undefined || from.tab === to.tab) return false
  const target = to.tab
  const anchor = hasPane(target.root, target.focus) ? target.focus : paneIds(target.root)[0]!
  detachPane(sessions, paneId)
  target.root = splitPane(target.root, anchor, 'row', paneId)
  target.focus = paneId
  return true
}

export function newTab(id: string, title: string, paneId: string): Tab {
  return { id, title, root: { type: 'pane', paneId }, focus: paneId }
}

export function splitCount(root: Node): number {
  return root.type === 'pane' ? 0 : 1 + splitCount(root.a) + splitCount(root.b)
}

/** Sets the divider of the split reached by `route` from the root ('' is the root split; each 'a' or 'b' descends into that child). */
export function setRatioAt(root: Node, route: string, ratio: number): Node {
  if (root.type === 'pane') return root
  if (route === '') return { ...root, ratio: clampRatio(ratio) }
  const side = route[0]
  if (side !== 'a' && side !== 'b') return root
  return { ...root, [side]: setRatioAt(root[side], route.slice(1), ratio) }
}
