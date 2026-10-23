// Pure helpers for the git block's commit graph: lane layout, ref decorations, avatars, subject search.
// No DOM, no I/O: unit-tested in gitgraph.test.mjs.

/** Number of distinct lane colours; the renderer maps a colour index to a CSS variable. */
export const LANE_COLORS = 8

/**
 * Lays commits out in lanes.
 *
 * `commits` must be ordered children-before-parents (git log --topo-order, newest first); every element needs
 * `{ hash, parents: string[] }`. Parents that are not in the list (history cut by a limit) simply keep their lane
 * to the bottom edge.
 *
 * Returns one row per commit:
 *   lane   column of the commit's node            color  lane colour index of the node
 *   up     lines from the row's top edge into the node: [{ lane, color }] (lane = column the line comes from)
 *   pass   lines running straight through the row:      [{ lane, color }]
 *   down   lines from the node to the bottom edge:      [{ lane, color }] (lane = column the line arrives in)
 *   width  columns used by this row (max lane + 1)
 * and `width`, the maximum over all rows.
 */
export function layoutGraph(commits, colors = LANE_COLORS) {
  /** @type {({hash:string,color:number}|null)[]} */
  const lanes = []
  let nextColor = 0
  const newColor = () => nextColor++ % colors
  const free = () => {
    const i = lanes.findIndex((l) => l === null)
    return i < 0 ? lanes.length : i
  }
  const rows = []
  let width = 0
  for (const c of commits) {
    const hits = []
    for (let i = 0; i < lanes.length; i++) if (lanes[i] && lanes[i].hash === c.hash) hits.push(i)
    let lane
    let color
    if (hits.length) {
      lane = hits[0]
      color = lanes[lane].color
    } else {
      lane = free()
      color = newColor()
    }
    const up = hits.map((i) => ({ lane: i, color: lanes[i].color }))
    const hitSet = new Set(hits)
    const pass = []
    for (let i = 0; i < lanes.length; i++) if (lanes[i] && !hitSet.has(i)) pass.push({ lane: i, color: lanes[i].color })
    for (const i of hits) lanes[i] = null
    if (lane >= lanes.length) lanes[lane] = null

    const down = []
    const parents = c.parents ?? []
    if (parents.length) {
      const p0 = parents[0]
      const at = lanes.findIndex((l) => l && l.hash === p0)
      if (at >= 0) {
        // The first parent is already expected by another lane: this line joins it and our lane frees up.
        down.push({ lane: at, color: lanes[at].color })
      } else {
        lanes[lane] = { hash: p0, color }
        down.push({ lane, color })
      }
      for (let k = 1; k < parents.length; k++) {
        const p = parents[k]
        const j = lanes.findIndex((l) => l && l.hash === p)
        if (j >= 0) {
          if (!down.some((d) => d.lane === j)) down.push({ lane: j, color: lanes[j].color })
        } else {
          const n = free()
          const col = newColor()
          lanes[n] = { hash: p, color: col }
          down.push({ lane: n, color: col })
        }
      }
    }
    let w = lane + 1
    for (const l of up) w = Math.max(w, l.lane + 1)
    for (const l of pass) w = Math.max(w, l.lane + 1)
    for (const l of down) w = Math.max(w, l.lane + 1)
    width = Math.max(width, w)
    rows.push({ hash: c.hash, lane, color, up, pass, down, width: w })
  }
  return { rows, width }
}

/** Prepends the virtual working-tree commit (hash `#wip`) whose parent is HEAD, so the graph draws its line. */
export function withWorkingTree(commits, headHash) {
  return [{ hash: WIP, parents: headHash ? [headHash] : [], wip: true }, ...commits]
}
export const WIP = '#wip'

/** "Ada Lovelace" -> "AL", "ada" -> "AD", "" -> "?". */
export function initials(name, email = '') {
  const src = (name || '').trim() || (email || '').split('@')[0] || ''
  const words = src.split(/[\s._-]+/).filter(Boolean)
  if (!words.length) return '?'
  const a = [...words[0]][0]
  const b = words.length > 1 ? [...words[words.length - 1]][0] : [...words[0]][1] ?? ''
  return (a + b).toUpperCase()
}

/** Stable hue 0..359 for an author (by email, else name). */
export function avatarHue(key) {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 360
}

/**
 * Parses git's `%D` decoration ("HEAD -> main, origin/main, tag: v1.0") into chips.
 * `remotes` (names of the configured remotes) tells `origin/main` from a local branch called `feature/x`.
 */
export function parseDecoration(text, remotes = []) {
  const out = []
  if (!text) return out
  for (const raw of text.split(', ')) {
    const part = raw.trim()
    if (!part) continue
    if (part === 'HEAD') {
      out.push({ type: 'head', name: 'HEAD', current: true })
    } else if (part.startsWith('HEAD -> ')) {
      out.push({ type: 'branch', name: part.slice(8), current: true })
    } else if (part.startsWith('tag: ')) {
      out.push({ type: 'tag', name: part.slice(5) })
    } else {
      const slash = part.indexOf('/')
      const remote = slash > 0 && remotes.includes(part.slice(0, slash))
      if (remote) {
        if (part.endsWith('/HEAD')) continue
        out.push({ type: 'remote', name: part, remote: part.slice(0, slash) })
      } else out.push({ type: 'branch', name: part })
    }
  }
  // current branch first, then local branches, remotes, tags
  const order = { head: 0, branch: 2, remote: 3, tag: 4 }
  return out
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.current ? -1 : 0) - (b.r.current ? -1 : 0) || order[a.r.type] - order[b.r.type] || a.i - b.i)
    .map((x) => x.r)
}

/** Case-insensitive subject search. Returns indexes of matching commits, in list order. */
export function searchSubjects(commits, query) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits = []
  for (let i = 0; i < commits.length; i++) if (commits[i].subject.toLowerCase().includes(q)) hits.push(i)
  return hits
}

/** Splits `text` around case-insensitive occurrences of `query`: [{ text, hit }]. */
export function highlightParts(text, query) {
  const q = query.trim().toLowerCase()
  if (!q) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const parts = []
  let at = 0
  for (;;) {
    const i = lower.indexOf(q, at)
    if (i < 0) break
    if (i > at) parts.push({ text: text.slice(at, i), hit: false })
    parts.push({ text: text.slice(i, i + q.length), hit: true })
    at = i + q.length
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return parts.length ? parts : [{ text, hit: false }]
}

/** "2 minutes ago" style age from a unix timestamp (seconds). */
export function relativeTime(unixSeconds, nowMs = Date.now()) {
  const s = Math.max(0, Math.round(nowMs / 1000 - unixSeconds))
  if (s < 45) return 'now'
  const units = [
    ['y', 31536000],
    ['mo', 2592000],
    ['w', 604800],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ]
  for (const [u, n] of units) if (s >= n) return `${Math.floor(s / n)}${u}`
  return 'now'
}
