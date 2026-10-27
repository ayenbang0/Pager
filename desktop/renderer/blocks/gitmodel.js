// Shared, DOM-free helpers of the git block and its sidebar Changes view.

/** Window-local bus: any git view that changes the repository announces it so every other view refreshes at once
 * (the main process suppresses watcher events caused by its own commands, so siblings would not hear about them). */
const bus = new EventTarget()
export const announce = (root, source) => bus.dispatchEvent(new CustomEvent('mutated', { detail: { root, source } }))
export function onAnnounce(fn) {
  const f = (e) => fn(e.detail.root, e.detail.source)
  bus.addEventListener('mutated', f)
  return () => bus.removeEventListener('mutated', f)
}

/** Normalises `ctx.onEvent` callbacks: fn(event, payload) or fn({ event, payload }). Returns an unsubscribe (or noop). */
export function subscribe(ctx, fn) {
  if (typeof ctx.onEvent !== 'function') return () => {}
  const off = ctx.onEvent((a, b) => (typeof a === 'string' ? fn(a, b) : a && fn(a.event ?? a.type, a.payload ?? a.data)))
  return typeof off === 'function' ? off : () => {}
}

/** Splits porcelain-v2 files into the staged list and the working-tree list (untracked and conflicted go to the latter). */
export function splitStatus(files) {
  const staged = []
  const unstaged = []
  for (const f of files) {
    if (f.kind === 'unmerged') unstaged.push({ path: f.path, status: '!', conflict: true })
    else if (f.kind === 'untracked') unstaged.push({ path: f.path, status: 'U', untracked: true })
    else {
      if (f.index !== '.') staged.push({ path: f.path, orig: f.orig, status: f.index })
      if (f.worktree !== '.') unstaged.push({ path: f.path, status: f.worktree })
    }
  }
  return { staged, unstaged }
}

export const STATUS_NAME = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked', '!': 'Conflict' }
export const statusClass = (s) => (s === 'M' || s === 'T' ? 'mod' : s === 'A' || s === 'U' ? 'add' : s === 'D' ? 'del' : s === '!' ? 'conf' : 'ren')

export function splitPath(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) }
}

export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

export function errorText(e) {
  const m = String(e && e.message ? e.message : e || '')
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Git)?Error:\s*/, '')
  return m || 'Something went wrong'
}

/** Absolute date for tooltips. */
export const fullDate = (unix) => (unix ? new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')

/** Whether the working tree row has anything. */
export const dirty = (st) => !!st && st.staged + st.modified + st.untracked + st.conflicted > 0

/** Ahead/behind text: "↑2 ↓1". */
export const trackText = (b) => [b.ahead ? `\u2191${b.ahead}` : '', b.behind ? `\u2193${b.behind}` : ''].filter(Boolean).join(' ')

// ------------------------------------------------------------------ the Changes view

/** The four groups of the Changes column, in display order. */
export const GROUPS = ['conflicted', 'staged', 'unstaged', 'untracked']

/**
 * Porcelain-v2 files -> the four groups. Every entry has a stable `key` (`group:path`), so a file that is both staged and
 * modified appears once in each group and selects independently.
 * @returns {{ conflicted: Entry[], staged: Entry[], unstaged: Entry[], untracked: Entry[] }}
 *   Entry: { key, group, path, status, orig?, conflict?, untracked? }
 */
export function groupStatus(files) {
  const out = { conflicted: [], staged: [], unstaged: [], untracked: [] }
  const add = (group, f) => out[group].push({ key: `${group}:${f.path}`, group, ...f })
  for (const f of files ?? []) {
    if (f.kind === 'unmerged') add('conflicted', { path: f.path, status: '!', conflict: true })
    else if (f.kind === 'untracked') add('untracked', { path: f.path, status: 'U', untracked: true })
    else {
      if (f.index !== '.') add('staged', { path: f.path, status: f.index, orig: f.orig })
      if (f.worktree !== '.') add('unstaged', { path: f.path, status: f.worktree })
    }
  }
  return out
}

/** Keeps the entries whose path contains every whitespace-separated word of `query` (case-insensitive). */
export function filterEntries(entries, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return entries
  return entries.filter((e) => {
    const p = e.path.toLowerCase()
    return words.every((w) => p.includes(w))
  })
}

/**
 * Multi-select with the usual modifiers. `order` is every visible key top to bottom, `anchor` the last plain/ctrl click.
 * plain click -> only that key; `toggle` (ctrl/cmd) -> flip that key; `range` (shift) -> everything between anchor and key.
 * @returns {{ selected: Set<string>, anchor: string|null }}
 */
export function selectKeys({ order, selected, anchor }, key, { toggle = false, range = false } = {}) {
  if (range && anchor && order.includes(anchor) && order.includes(key)) {
    const a = order.indexOf(anchor)
    const b = order.indexOf(key)
    const [lo, hi] = a < b ? [a, b] : [b, a]
    const next = toggle ? new Set(selected) : new Set()
    for (let i = lo; i <= hi; i++) next.add(order[i])
    return { selected: next, anchor }
  }
  if (toggle) {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return { selected: next, anchor: key }
  }
  return { selected: new Set([key]), anchor: key }
}

/** Drops keys that are no longer in the list. */
export function pruneSelection(selected, order) {
  const live = new Set(order)
  return new Set([...selected].filter((k) => live.has(k)))
}

/** Paths of the selected entries of one group (what a bulk action sends to git). */
export function pathsOf(entries, selected, group) {
  return entries.filter((e) => e.group === group && selected.has(e.key)).map((e) => e.path)
}

/**
 * State of the commit button.
 * @param {{ staged: number, conflicted: number, summary: string, amend: boolean, committing: boolean }} s
 * @returns {{ disabled: boolean, label: string, hint: string }}
 */
export function commitButton({ staged, conflicted, summary, amend, committing }) {
  const files = plural(staged, 'file')
  if (committing) return { disabled: true, label: 'Committing\u2026', hint: '' }
  if (conflicted) return { disabled: true, label: 'Resolve conflicts', hint: `${plural(conflicted, 'file')} still ${conflicted === 1 ? 'has' : 'have'} conflicts. Resolve and stage ${conflicted === 1 ? 'it' : 'them'} first.` }
  if (amend) return { disabled: false, label: staged ? `Amend with ${files}` : 'Amend message', hint: '' }
  if (!staged) return { disabled: true, label: 'Nothing staged', hint: 'Stage some changes to commit them.' }
  if (!String(summary ?? '').trim()) return { disabled: true, label: `Commit ${files}`, hint: 'Write a summary first.' }
  return { disabled: false, label: `Commit ${files}`, hint: '' }
}

/** The banner text of a merge/rebase/cherry-pick/revert in progress. */
export function operationText(op, conflicted = 0) {
  if (!op) return null
  const step = op.kind === 'rebase' && op.step && op.total ? ` (step ${op.step} of ${op.total})` : ''
  const noun = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[op.kind] ?? op.kind
  return {
    title: `${op.label || `${noun} in progress`}${step}`,
    detail: conflicted ? `${plural(conflicted, 'file')} ${conflicted === 1 ? 'has' : 'have'} conflicts` : 'No conflicts left. Continue to finish.',
    canSkip: op.kind !== 'merge',
    continueLabel: op.kind === 'merge' ? 'Commit merge' : 'Continue',
  }
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'tif', 'tiff'])
/** Whether a path looks like an image (the diff shows a placeholder card for it). */
export const isImagePath = (p) => IMAGE_EXT.has(String(p ?? '').split('.').pop().toLowerCase()) && String(p).includes('.')

// ------------------------------------------------------------------ the Branches panel

/**
 * Flattens refs into the rows of the branches panel: headers and items, filtered by `query`, with collapsed sections kept as
 * a bare header. Item: { type:'item', kind:'branch'|'remote'|'tag'|'stash', id, name, ... }.
 * @param {{ branches, remotes, tags, stashes, remoteInfo? }} refs  git.cjs `refs()` result
 * @param {string} query
 * @param {Set<string>} collapsed section ids: branches, remotes, tags, stashes
 */
export function refRows(refs, query = '', collapsed = new Set()) {
  const q = String(query).trim().toLowerCase()
  const hit = (s) => !q || String(s).toLowerCase().includes(q)
  const rows = []
  const section = (id, title, items, body = items) => {
    if (!items.length) return
    rows.push({ type: 'header', id, title, count: items.length, collapsed: collapsed.has(id) })
    if (!collapsed.has(id)) rows.push(...body)
  }
  const byDate = (a, b) => (b.date || 0) - (a.date || 0)
  const local = (refs.branches ?? [])
    .filter((b) => hit(b.name))
    .sort((a, b) => Number(b.current) - Number(a.current) || byDate(a, b) || (a.name < b.name ? -1 : 1))
    .map((b) => ({ type: 'item', kind: 'branch', id: `branch:${b.name}`, ...b }))
  section('branches', 'Branches', local)
  // Remote branches grouped under a sub-header per remote (with its url).
  const names = refs.remoteNames ?? (refs.remoteInfo ?? []).map((r) => r.name)
  const remoteOf = (n) => names.find((r) => n.startsWith(`${r}/`)) ?? n.split('/')[0]
  const urls = new Map((refs.remoteInfo ?? []).map((r) => [r.name, r.url]))
  const groups = new Map()
  for (const r of (refs.remotes ?? []).filter((x) => hit(x.name)).sort(byDate)) {
    const g = remoteOf(r.name)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push({ type: 'item', kind: 'remote', id: `remote:${r.name}`, remote: g, short: r.name.slice(g.length + 1), ...r })
  }
  const remoteItems = [...groups.values()].flat()
  const remoteBody = []
  for (const [name, items] of groups) remoteBody.push({ type: 'subheader', id: `remote-name:${name}`, title: name, url: urls.get(name) ?? '' }, ...items)
  section('remotes', 'Remotes', remoteItems, remoteBody)
  const tags = (refs.tags ?? []).filter((t) => hit(t.name)).sort(byDate).map((t) => ({ type: 'item', kind: 'tag', id: `tag:${t.name}`, ...t }))
  section('tags', 'Tags', tags)
  const stashes = (refs.stashes ?? [])
    .filter((s) => hit(s.message) || hit(s.ref))
    .map((s) => ({ type: 'item', kind: 'stash', id: `stash:${s.ref}`, name: s.ref, title: String(s.message).replace(/^(WIP )?[Oo]n [^:]+: /, ''), ...s }))
  section('stashes', 'Stashes', stashes)
  return rows
}

/** The branches a merge into `current` may take: every other local branch, then remote branches. */
export const mergeCandidates = (refs, current) => [
  ...(refs.branches ?? []).filter((b) => b.name !== current).map((b) => b.name),
  ...(refs.remotes ?? []).map((r) => r.name),
]

/** Keyboard shortcuts shown by `?`: [keys, what]. */
export const SHORTCUTS = [
  ['Alt 1 / 2 / 3', 'Changes, History, Branches'],
  ['Ctrl F', 'Filter files (Changes) or search commits (History)'],
  ['Ctrl B', 'Switch branch'],
  ['Ctrl Enter', 'Commit'],
  ['\u2191 \u2193', 'Move through files or commits'],
  ['Space', 'Stage or unstage the selected files'],
  ['Ctrl A', 'Select every file in the list'],
  ['Delete', 'Discard the selected files (asks first)'],
  ['F5', 'Refresh'],
  ['Ctrl Z / Ctrl Shift Z', 'Undo / redo the last stage or commit'],
  ['?', 'This list'],
]
