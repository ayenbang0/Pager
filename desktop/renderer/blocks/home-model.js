// Home block model: plain functions over the daemon state, the changelog text and the folder history. No DOM, no
// imports, so it runs under `node --test` (home-model.test.mjs).

export const HOME_KIND = 'block:home'
export const RECENT_KEY = 'pager.home.recent.v1'

/** Pane ids of a split tree, left to right. */
export function leavesOf(node, out = []) {
  if (!node) return out
  if (node.type === 'pane') out.push(node.paneId)
  else {
    leavesOf(node.a, out)
    leavesOf(node.b, out)
  }
  return out
}

const isBlockKind = (k) => typeof k === 'string' && k.startsWith('block:')
const AGENTS = new Set(['omp', 'claude', 'opencode', 'hermes', 'custom'])

/** Lower is listed first: agents, then the Pager terminal, shells, then block panes. */
export function kindRank(kind) {
  if (AGENTS.has(kind)) return 0
  if (kind === 'pager') return 1
  if (isBlockKind(kind)) return 3
  return 2
}

/**
 * Every live pane of every session as list rows, ordered for "Running now": running before restored, then by kind rank,
 * then by position (session, tab, split order). Exited panes and the Home pane itself are left out.
 * Row: { paneId, tabId, sessionId, sessionName, pane, order }
 */
export function livePanes(state) {
  const rows = []
  const byId = new Map(((state && state.panes) || []).map((p) => [p.id, p]))
  let order = 0
  for (const s of (state && state.sessions) || []) {
    for (const t of s.tabs || []) {
      for (const id of leavesOf(t.root)) {
        const pane = byId.get(id)
        if (!pane || pane.kind === HOME_KIND || pane.state === 'exited') continue
        rows.push({ paneId: id, tabId: t.id, sessionId: s.id, sessionName: s.name, pane, order: order++ })
      }
    }
  }
  const live = (r) => (r.pane.state === 'running' ? 0 : 1)
  return rows.sort((a, b) => live(a) - live(b) || kindRank(a.pane.kind) - kindRank(b.pane.kind) || a.order - b.order)
}

/** The tab that holds the Home pane, if any. */
export function homeTab(state) {
  const home = ((state && state.panes) || []).find((p) => p.kind === HOME_KIND)
  if (!home) return null
  for (const s of state.sessions || []) for (const t of s.tabs || []) if (leavesOf(t.root).includes(home.id)) return { tab: t, session: s }
  return null
}

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * Recent folders: folders of the panes open now first (newest pane first), then the stored history, de-duplicated
 * ignoring case and slash style, never the user's home folder itself, at most `max`. `home` is dropped as noise.
 */
export function mergeRecent(stored, state, home, max = 6) {
  const open = []
  const panes = ((state && state.panes) || []).filter((p) => p.kind !== HOME_KIND && !isBlockKind(p.kind) && p.cwd)
  for (let i = panes.length - 1; i >= 0; i--) open.push(panes[i].cwd)
  const seen = new Set()
  const out = []
  for (const p of [...open, ...(Array.isArray(stored) ? stored : [])]) {
    if (typeof p !== 'string' || !p) continue
    const k = norm(p)
    if (!k || seen.has(k) || (home && k === norm(home))) continue
    seen.add(k)
    out.push(p)
    if (out.length >= max) break
  }
  return out
}

/** Folder names are stored in the form they were first seen in; this is what goes back to localStorage. */
export const packRecent = (list, max = 12) => list.slice(0, max)

/** "Good morning" / "Good afternoon" / "Good evening" for a Date. */
export function dayPart(date) {
  const h = date.getHours()
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/** `welov` -> `Welov`; dots, dashes and underscores split words; empty -> ''. */
export function displayName(user) {
  const s = String(user || '').trim()
  if (!s) return ''
  return s
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/** Inline markdown -> plain text (links keep their label, code and emphasis lose their markers). */
export function plain(md) {
  return String(md)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cut at a word boundary near `max` characters and end with an ellipsis. */
export function clip(text, max) {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:(\u2013-]+$/, '') + '\u2026'
}

/**
 * The newest release of a Keep-a-Changelog file: { version, date, items: [{ section, lead, text }], total }, the first
 * `max` bullets in file order (Added, Changed, Fixed, ...). `lead` is the bold start of a bullet when there is one.
 * An empty [Unreleased] section is skipped. null when no release has any bullet.
 */
export function parseChangelog(md, max = 5, width = 110) {
  const lines = String(md || '').split(/\r?\n/)
  let rel = null
  let section = ''
  const releases = []
  for (const line of lines) {
    const r = /^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+(\S+))?/.exec(line)
    if (r && !line.startsWith('###')) {
      rel = { version: r[1], date: r[2] || '', bullets: [] }
      releases.push(rel)
      section = ''
      continue
    }
    if (!rel) continue
    const sec = /^###\s+(.+?)\s*$/.exec(line)
    if (sec) {
      section = sec[1]
      continue
    }
    const b = /^[-*]\s+(.*\S)\s*$/.exec(line)
    if (b) rel.bullets.push({ section, raw: b[1] })
  }
  const newest = releases.find((x) => x.bullets.length > 0)
  if (!newest) return null
  const items = newest.bullets.slice(0, max).map(({ section: sec, raw }) => {
    const m = /^\*\*([^*]+)\*\*[:.]?\s*(.*)$/.exec(raw)
    const lead = m ? plain(m[1]).replace(/[:.]+$/, '') : ''
    return { section: sec, lead, text: clip(firstSentence(plain(m ? m[2] : raw)), width) }
  })
  return { version: newest.version, date: newest.date, items, total: newest.bullets.length }
}

/** The text up to its first full stop followed by a space (at least 30 characters in, so `e.g.` and `v1.2` survive); no final stop. */
export function firstSentence(text) {
  const re = /\.\s+(?=\S)/g
  let hit
  while ((hit = re.exec(text)) !== null) if (hit.index >= 30) return text.slice(0, hit.index)
  return text.replace(/\.$/, '')
}
