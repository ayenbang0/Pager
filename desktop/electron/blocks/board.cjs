'use strict'
// Main-process handler of the Board block: a TODO.md kanban. The markdown file is the database.
//   `## Heading`  = a lane          `- [ ] text` / `- [x] text` (top level) = a card
//   `#tag`        = a label         `📅 2025-01-31`, `@{2025-01-31}`, `due:2025-01-31` = a due date
//   indented `- [ ]` under a card = subtasks (counter on the card); other indented lines are notes
// Everything else in the file (front matter, prose, other lists, Obsidian Kanban `%% kanban:settings %%` footers,
// fenced code, headings of other levels) is kept verbatim, in place, with each line's own line ending. Edits touch
// only the lines they mean to change and are written atomically (temp file + rename); the file is re-read before
// every edit, so edits made elsewhere while the board was open are never lost.
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')

const DONE_LANE = /^(done|completed?|finished|shipped|closed)$/i
const CARD = /^([-*+])([ \t]+)\[([ xX])\]([ \t]+|$)(.*)$/
const SUB = /^[ \t]+(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]([ \t]+|$)(.*)$/
const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const DATE = '\\d{4}-\\d{2}-\\d{2}'
const DUE_STYLES = [
  { style: 'tasks', re: new RegExp('📅[ \\t]*(' + DATE + ')'), make: (d) => `📅 ${d}` },
  { style: 'kanban', re: new RegExp('@\\{(' + DATE + ')(?:[T ][\\d:]+)?\\}'), make: (d) => `@{${d}}` },
  { style: 'due', re: new RegExp('(?:^|(?<=\\s))due:(' + DATE + ')(?=\\s|$)'), make: (d) => `due:${d}` },
  { style: 'dataview', re: new RegExp('\\[due::[ \\t]*(' + DATE + ')\\]'), make: (d) => `[due:: ${d}]` },
]
const NEW_BOARD = '# TODO\n\n## Todo\n\n## Doing\n\n## Done\n'
const SAVE_RETRIES = 3

class BoardError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'BoardError'
    this.code = code
  }
}
const stale = () => new BoardError('The file changed under this card; the board was refreshed.', 'STALE')

// ---------------------------------------------------------------- parsing

/** FNV-1a, 6 hex digits: enough to tell "same line" from "line was edited elsewhere". */
function hash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}

/** Split into lines that each remember their own terminator, so any mix of CRLF/LF/CR/none survives a round trip. */
function splitLines(text) {
  const lines = []
  const re = /\r\n|\n|\r/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    lines.push({ t: text.slice(last, m.index), e: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) lines.push({ t: text.slice(last), e: '' })
  return lines
}

function joinLines(doc) {
  let out = doc.bom ? '\ufeff' : ''
  for (const l of doc.lines) out += l.t + l.e
  return out
}

/** Spans of inline code, which never contain labels or dates. */
function codeSpans(s) {
  const out = []
  const re = /`[^`]*`/g
  let m
  while ((m = re.exec(s))) out.push([m.index, m.index + m[0].length])
  return out
}
const inSpan = (spans, i) => spans.some(([a, b]) => i >= a && i < b)

/** A card line's text after the checkbox -> { title, labels, due, dueStyle }. */
function parseBody(body) {
  const spans = codeSpans(body)
  const cut = []
  const labels = []
  const tagRe = /(^|\s)#([A-Za-z][\w\-/]*)/g
  let m
  while ((m = tagRe.exec(body))) {
    const at = m.index + m[1].length
    if (inSpan(spans, at)) continue
    if (!labels.includes(m[2])) labels.push(m[2])
    cut.push([at, at + 1 + m[2].length])
  }
  let due = null
  let dueStyle = null
  for (const d of DUE_STYLES) {
    const re = new RegExp(d.re.source, 'g')
    while ((m = re.exec(body))) {
      if (inSpan(spans, m.index)) continue
      if (!due) {
        due = m[1]
        dueStyle = d.style
      }
      cut.push([m.index, m.index + m[0].length])
    }
  }
  cut.sort((a, b) => a[0] - b[0])
  let title = ''
  let pos = 0
  for (const [a, b] of cut) {
    if (a >= pos) title += body.slice(pos, a)
    pos = Math.max(pos, b)
  }
  title += body.slice(pos)
  return { title: title.replace(/\s+/g, ' ').trim(), labels, due, dueStyle }
}

function buildBody({ title, labels, due, dueStyle }) {
  const parts = []
  if (title) parts.push(title)
  for (const l of labels || []) parts.push('#' + l)
  if (due) parts.push((DUE_STYLES.find((d) => d.style === dueStyle) || DUE_STYLES[0]).make(due))
  return parts.join(' ')
}

const isBlank = (t) => t.trim() === ''
const indentOf = (t) => (/^[ \t]*/.exec(t) || [''])[0].length

/**
 * Parse a markdown text. Never mutates anything; `doc.lines` is the source of truth and everything else is an
 * index over it (rebuilt by parseDoc after each change).
 */
function parse(text) {
  let bom = false
  if (text.charCodeAt(0) === 0xfeff) {
    bom = true
    text = text.slice(1)
  }
  const lines = splitLines(text)
  const first = lines.find((l) => l.e)
  return indexDoc({ bom, lines, eol: first ? first.e : '\n' })
}

function indexDoc(doc) {
  const { lines } = doc
  const n = lines.length
  const lanes = []
  const cards = new Map() // line -> card
  const subs = new Map() // line -> subtask
  let lane = null
  let archived = false
  let fence = null
  let i = 0
  // YAML front matter (Obsidian Kanban stores `kanban-plugin: board` here): verbatim
  if (n && /^---\s*$/.test(lines[0].t)) {
    for (let j = 1; j < n; j++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[j].t)) {
        i = j + 1
        break
      }
    }
  }
  const openLane = (line, title, level) => {
    lane = { line, title, level, archived, done: DONE_LANE.test(title.trim()), cards: [], end: line + 1, id: `${line}:${hash(line >= 0 ? lines[line].t : '')}` }
    lanes.push(lane)
  }
  for (; i < n; i++) {
    const t = lines[i].t
    const fm = FENCE.exec(t)
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && t.trim() === fm[1]) fence = null
      continue
    }
    if (fm) {
      fence = fm[1]
      continue
    }
    if (/^(\*\*\*|\* \* \*)\s*$/.test(t)) {
      archived = true
      continue
    }
    const hm = HEADING.exec(t)
    if (hm) {
      if (hm[1].length === 2) openLane(i, hm[2], 2)
      continue
    }
    const cm = CARD.exec(t)
    if (!cm) continue
    if (!lane) openLane(-1, 'Tasks', 2)
    // block extent: following lines indented deeper than the card (blank lines only when more indented lines follow)
    let j = i + 1
    while (j < n) {
      const u = lines[j].t
      if (isBlank(u)) {
        let k = j + 1
        while (k < n && isBlank(lines[k].t)) k++
        if (k < n && indentOf(lines[k].t) > 0 && !HEADING.test(lines[k].t)) {
          j = k + 1
          continue
        }
        break
      }
      if (indentOf(u) > 0) j++
      else break
    }
    const body = cm[5]
    const bodyStart = t.length - body.length
    const pb = parseBody(body)
    const card = {
      line: i,
      end: j,
      marker: cm[1],
      checked: cm[3] !== ' ',
      bodyStart,
      body,
      title: pb.title,
      labels: pb.labels,
      due: pb.due,
      dueStyle: pb.dueStyle,
      subtasks: [],
      notes: [],
      h: hash(t),
      id: `${i}:${hash(t)}`,
      lane,
    }
    for (let k = i + 1; k < j; k++) {
      const sm = SUB.exec(lines[k].t)
      if (sm) {
        const sub = { line: k, checked: sm[1] !== ' ', text: sm[3].trim(), h: hash(lines[k].t), id: `${k}:${hash(lines[k].t)}`, card }
        card.subtasks.push(sub)
        subs.set(k, sub)
      } else if (!isBlank(lines[k].t)) card.notes.push(lines[k].t.trim())
    }
    lane.cards.push(card)
    cards.set(i, card)
    lane.end = j
    i = j - 1
  }
  // Obsidian Kanban marks a lane that completes its cards with a `**Complete**` line right under the heading
  for (const l of lanes) {
    if (l.line < 0) continue
    let k = l.line + 1
    while (k < n && isBlank(lines[k].t)) k++
    if (k < n && /^\*\*Complete\*\*\s*$/.test(lines[k].t)) l.done = true
  }
  doc.lanes = lanes
  doc.cards = cards
  doc.subs = subs
  return doc
}

function snapshot(doc, extra) {
  let open = 0
  let done = 0
  const lanes = doc.lanes.map((l) => ({
    id: l.id,
    title: l.title,
    done: l.done,
    archived: l.archived,
    implicit: l.line < 0,
    cards: l.cards.map((c) => {
      if (!l.archived) c.checked ? done++ : open++
      return {
        id: c.id,
        done: c.checked,
        title: c.title,
        labels: c.labels,
        due: c.due,
        subtasks: c.subtasks.map((s) => ({ id: s.id, done: s.checked, text: s.text })),
        notes: c.notes,
      }
    }),
  }))
  return { ...extra, lanes, counts: { open, done }, kanban: doc.lines.slice(0, 6).some((l) => /^kanban-plugin:/.test(l.t)) }
}

// ---------------------------------------------------------------- edits (all pure over doc.lines, then reindex)

function resolveCard(doc, id) {
  const m = /^(\d+):([0-9a-f]{6})$/.exec(String(id))
  const c = m && doc.cards.get(Number(m[1]))
  if (!c || c.h !== m[2]) throw stale()
  return c
}

function resolveSub(doc, id) {
  const m = /^(\d+):([0-9a-f]{6})$/.exec(String(id))
  const s = m && doc.subs.get(Number(m[1]))
  if (!s || s.h !== m[2]) throw stale()
  return s
}

function resolveLane(doc, id) {
  const l = doc.lanes.find((x) => x.id === id)
  if (!l) throw stale()
  return l
}

function setCheck(t, checked) {
  return t.replace(/^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)[ xX](\])/, `$1${checked ? 'x' : ' '}$2`)
}

/** Insert lines at `at` (every line is terminated while an edit runs; see runOp). */
function insertLines(doc, at, texts) {
  doc.lines.splice(at, 0, ...texts.map((t) => ({ t, e: doc.eol })))
}

/**
 * Where a card goes in `lane` at position `index` among its cards (ignoring `skip`, the card being moved).
 * Returns { at, padAfter }: padAfter asks for a blank line when the insertion butts against the next heading.
 */
function insertionPoint(doc, lane, index, skip) {
  const cards = lane.cards.filter((c) => c !== skip)
  let at
  if (index != null && index < cards.length && index >= 0) at = cards[index].line
  else if (cards.length) at = cards[cards.length - 1].end
  else if (lane.line >= 0) {
    // under the heading, past its `**Complete**` marker and the blank line, but never into the next lane's territory
    at = lane.line + 1
    while (at < doc.lines.length && (isBlank(doc.lines[at].t) || /^\*\*Complete\*\*\s*$/.test(doc.lines[at].t))) at++
  } else at = 0
  const nextLine = doc.lines[at]
  const padAfter = !!nextLine && !isBlank(nextLine.t) && HEADING.test(nextLine.t) && !(index != null && index < cards.length && index >= 0)
  return { at, padAfter }
}

const ops = {
  add(doc, { lane, text, labels, due, index }) {
    const l = resolveLane(doc, lane)
    const title = String(text || '').replace(/\s+/g, ' ').trim()
    if (!title) throw new BoardError('A card needs some text.')
    const body = buildBody({ title, labels: cleanLabels(labels), due: cleanDue(due), dueStyle: 'tasks' })
    const done = l.done
    const { at, padAfter } = insertionPoint(doc, l, index, null)
    insertLines(doc, at, [`- [${done ? 'x' : ' '}] ${body}`, ...(padAfter ? [''] : [])])
  },

  update(doc, { card, title, labels, due }) {
    const c = resolveCard(doc, card)
    const next = { title: c.title, labels: c.labels, due: c.due, dueStyle: c.dueStyle }
    if (title !== undefined) {
      next.title = String(title).replace(/\s+/g, ' ').trim()
      if (!next.title) throw new BoardError('A card needs some text.')
    }
    if (labels !== undefined) next.labels = cleanLabels(labels)
    if (due !== undefined) next.due = cleanDue(due)
    const t = doc.lines[c.line].t
    // untouched fields keep the original text: only rebuild when something really changed
    const same = next.title === c.title && next.labels.join(' ') === c.labels.join(' ') && next.due === c.due
    if (same) return
    doc.lines[c.line].t = t.slice(0, c.bodyStart) + buildBody(next)
  },

  toggle(doc, { card, move = true }) {
    const c = resolveCard(doc, card)
    const checked = !c.checked
    doc.lines[c.line].t = setCheck(doc.lines[c.line].t, checked)
    if (!move) return
    const live = doc.lanes.filter((l) => !l.archived)
    const target = checked ? live.find((l) => l.done) : c.lane.done ? live.find((l) => !l.done) : null
    if (target && target !== c.lane) moveCard(doc, c, target, null, checked)
  },

  move(doc, { card, lane, index }) {
    const c = resolveCard(doc, card)
    const to = resolveLane(doc, lane)
    moveCard(doc, c, to, index, to.done ? true : c.lane.done && !to.done ? false : c.checked)
  },

  remove(doc, { card }) {
    const c = resolveCard(doc, card)
    removeLines(doc, c.line, c.end)
  },

  addSub(doc, { card, text }) {
    const c = resolveCard(doc, card)
    const title = String(text || '').replace(/\s+/g, ' ').trim()
    if (!title) throw new BoardError('A subtask needs some text.')
    const last = c.subtasks[c.subtasks.length - 1]
    const indent = last ? (/^[ \t]*/.exec(doc.lines[last.line].t) || [''])[0] : '  '
    // after the last subtask, or at the end of the card's block
    insertLines(doc, last ? last.line + 1 : c.end, [`${indent}- [ ] ${title}`])
  },

  toggleSub(doc, { sub }) {
    const s = resolveSub(doc, sub)
    doc.lines[s.line].t = setCheck(doc.lines[s.line].t, !s.checked)
  },

  removeSub(doc, { sub }) {
    const s = resolveSub(doc, sub)
    removeLines(doc, s.line, s.line + 1)
  },

  addLane(doc, { title }) {
    const name = String(title || '').replace(/\s+/g, ' ').trim()
    if (!name) throw new BoardError('A lane needs a name.')
    // before an archive rule, a Kanban settings footer, or at the end
    let at = doc.lines.length
    for (let i = 0; i < doc.lines.length; i++) {
      if (/^(\*\*\*|\* \* \*)\s*$/.test(doc.lines[i].t) || /^%%\s*kanban:settings/.test(doc.lines[i].t)) {
        at = i
        break
      }
    }
    while (at > 0 && isBlank(doc.lines[at - 1].t) && at === doc.lines.length) at--
    const pre = at > 0 && !isBlank(doc.lines[at - 1].t) ? [''] : []
    insertLines(doc, at, [...pre, `## ${name}`, ''])
  },

  renameLane(doc, { lane, title }) {
    const l = resolveLane(doc, lane)
    const name = String(title || '').replace(/\s+/g, ' ').trim()
    if (!name) throw new BoardError('A lane needs a name.')
    if (l.line < 0) throw new BoardError('This lane has no heading to rename.')
    doc.lines[l.line].t = '## ' + name
  },

  removeLane(doc, { lane }) {
    const l = resolveLane(doc, lane)
    if (l.cards.length) throw new BoardError('Move or delete the lane\'s cards first.')
    if (l.line < 0) return
    let end = l.line + 1
    while (end < doc.lines.length && isBlank(doc.lines[end].t)) end++
    // only the heading and the blank lines right under it; any prose beneath stays where it is
    removeLines(doc, l.line, end)
  },
}

function cleanLabels(labels) {
  const out = []
  for (const raw of labels || []) {
    const l = String(raw).replace(/^#/, '').replace(/[^\w\-/]/g, '')
    if (/^[A-Za-z]/.test(l) && !out.includes(l)) out.push(l)
  }
  return out
}

function cleanDue(due) {
  if (due == null || due === '') return null
  const s = String(due)
  if (!new RegExp('^' + DATE + '$').test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) throw new BoardError('Dates look like 2025-01-31.')
  return s
}

function removeLines(doc, from, to) {
  doc.lines.splice(from, to - from)
}

function moveCard(doc, c, to, index, checked) {
  const { at, padAfter } = insertionPoint(doc, to, index, c)
  const block = doc.lines.slice(c.line, c.end).map((l) => ({ ...l }))
  block[0].t = setCheck(block[0].t, checked)
  const len = block.length
  doc.lines.splice(c.line, len)
  const pos = at > c.line ? at - len : at
  doc.lines.splice(pos, 0, ...block)
  if (padAfter) doc.lines.splice(pos + len, 0, { t: '', e: doc.eol })
}

/**
 * Run one edit. Every line is terminated while it runs (so inserts and moves never have to special-case the
 * last line); a file that had no final newline gets none back.
 */
function runOp(doc, name, args) {
  const { lines } = doc
  const open = lines.length > 0 && lines[lines.length - 1].e === ''
  if (open) lines[lines.length - 1].e = doc.eol
  ops[name](doc, args)
  if (open && doc.lines.length) doc.lines[doc.lines.length - 1].e = ''
}

/** Apply an op to a text and return the new text (pure; used by the tests). */
function applyOp(text, name, args) {
  const doc = parse(text)
  runOp(doc, name, args)
  return joinLines(doc)
}

// ---------------------------------------------------------------- files

const boards = new Map() // session id -> { id, file, real, dir, name, known, queue, watcher, emit }
let seq = 0

const isMarkdown = (p) => /\.(md|markdown)$/i.test(p)

function findTodo(dir) {
  const names = (() => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  })()
  return names.find((n) => /^todo\.md$/i.test(n)) || null
}

/** TODO.md in `cwd`, else in the nearest parent up to the repository root (or home). */
function locate(cwd) {
  let dir = path.resolve(cwd)
  const home = require('node:os').homedir()
  for (let hop = 0; hop < 32; hop++) {
    const f = findTodo(dir)
    if (f && fs.statSync(path.join(dir, f)).isFile()) return path.join(dir, f)
    if (fs.existsSync(path.join(dir, '.git')) || dir === home) break
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

function readFileText(file) {
  const buf = fs.readFileSync(file)
  return { text: buf.toString('utf8'), stat: fs.statSync(file) }
}

async function atomicWrite(file, text, mode) {
  const tmp = `${file}.pager-${process.pid}-${++seq}.tmp`
  const fh = await fsp.open(tmp, 'wx', mode)
  try {
    await fh.writeFile(text, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  let err
  for (let i = 0; i < 8; i++) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (e) {
      err = e
      // Windows: the target is briefly locked by a scanner, an editor or a sync client
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break
      await new Promise((r) => setTimeout(r, 25 * (i + 1)))
    }
  }
  fsp.unlink(tmp).catch(() => {})
  throw err
}

function entryOf(id) {
  const e = boards.get(String(id))
  if (!e) throw new BoardError('This board is closed.', 'CLOSED')
  return e
}

function serial(e, fn) {
  const run = e.queue.then(fn, fn)
  e.queue = run.catch(() => {})
  return run
}

function view(e, doc, text) {
  return snapshot(doc, { board: e.id, path: e.file, name: path.basename(e.file), exists: true, rev: hash(text) + text.length })
}

function watch(e) {
  const dir = path.dirname(e.file)
  const base = path.basename(e.file).toLowerCase()
  let timer = null
  try {
    e.watcher = fs.watch(dir, { persistent: false }, (_ev, name) => {
      if (name && String(name).toLowerCase() !== base) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        let text
        try {
          text = fs.readFileSync(e.file, 'utf8')
        } catch {
          text = null
        }
        const h = text === null ? 'gone' : hash(text) + text.length
        if (h === e.known) return
        e.known = h
        e.emit('changed', { board: e.id })
      }, 120)
    })
    e.watcher.on('error', () => {})
    e.clear = () => clearTimeout(timer)
  } catch {
    /* an unwatchable directory: the block refreshes on demand */
  }
}

function closeEntry(e) {
  if (e.watcher) e.watcher.close()
  if (e.clear) e.clear()
  boards.delete(e.id)
}

const methods = {
  /** Find (or point at) the board file for a pane. `file` wins; otherwise TODO.md at/above `cwd`. */
  async open({ cwd, file } = {}, ctx) {
    let target
    if (file) {
      target = path.resolve(String(file))
      if (!isMarkdown(target)) throw new BoardError('A board is a markdown file (.md).')
    } else {
      if (!cwd || typeof cwd !== 'string') throw new BoardError('No folder to look for TODO.md in.')
      const dir = path.resolve(cwd)
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new BoardError('Not a folder: ' + dir)
      target = locate(dir) || path.join(dir, 'TODO.md')
    }
    if (!fs.existsSync(path.dirname(target))) throw new BoardError('Folder does not exist: ' + path.dirname(target))
    let exists = false
    try {
      exists = fs.statSync(target).isFile()
      if (!exists && fs.existsSync(target)) throw new BoardError('Not a file: ' + target)
    } catch (e) {
      if (e instanceof BoardError) throw e
    }
    const id = 'b' + ++seq
    const e = {
      id,
      file: exists ? fs.realpathSync(target) : target,
      known: null,
      queue: Promise.resolve(),
      emit: ctx && typeof ctx.emit === 'function' ? ctx.emit.bind(ctx) : () => {},
    }
    boards.set(id, e)
    if (!exists) return { board: id, path: e.file, name: path.basename(e.file), exists: false }
    const { text } = readFileText(e.file)
    e.known = hash(text) + text.length
    watch(e)
    return view(e, parse(text), text)
  },

  /** Create the file with Todo/Doing/Done lanes (only when it does not exist). */
  async create({ board }) {
    const e = entryOf(board)
    return serial(e, async () => {
      if (fs.existsSync(e.file)) throw new BoardError('TODO.md already exists.')
      await atomicWrite(e.file, NEW_BOARD)
      e.file = fs.realpathSync(e.file)
      e.known = hash(NEW_BOARD) + NEW_BOARD.length
      watch(e)
      return view(e, parse(NEW_BOARD), NEW_BOARD)
    })
  },

  async load({ board }) {
    const e = entryOf(board)
    return serial(e, async () => {
      let text
      try {
        text = readFileText(e.file).text
      } catch (err) {
        if (err.code === 'ENOENT') return { board: e.id, path: e.file, name: path.basename(e.file), exists: false }
        throw err
      }
      e.known = hash(text) + text.length
      return view(e, parse(text), text)
    })
  },

  async close({ board }) {
    const e = boards.get(String(board))
    if (e) closeEntry(e)
    return true
  },
}

for (const name of Object.keys(ops)) {
  methods[name] = async (args = {}) => {
    const e = entryOf(args.board)
    return serial(e, async () => {
      for (let attempt = 0; ; attempt++) {
        let read
        try {
          read = readFileText(e.file)
        } catch (err) {
          if (err.code === 'ENOENT') throw new BoardError('TODO.md is gone.', 'GONE')
          throw err
        }
        const doc = parse(read.text)
        runOp(doc, name, args)
        const text = joinLines(doc)
        if (text === read.text) return view(e, doc, text)
        // someone saved between our read and now: redo the edit on top of their version
        const again = fs.statSync(e.file)
        if (again.mtimeMs !== read.stat.mtimeMs || again.size !== read.stat.size) {
          if (attempt < SAVE_RETRIES) continue
          throw new BoardError('TODO.md keeps changing; try again.', 'BUSY')
        }
        await atomicWrite(e.file, text, read.stat.mode & 0o777)
        e.known = hash(text) + text.length
        return view(e, parse(text), text)
      }
    })
  }
}

function dispose() {
  for (const e of [...boards.values()]) closeEntry(e)
}

module.exports = { methods, dispose, _t: { parse, joinLines, applyOp, snapshot, parseBody, buildBody, splitLines, hash, atomicWrite, locate, ops, boards } }
