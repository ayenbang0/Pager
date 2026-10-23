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
