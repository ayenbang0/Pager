export type Mode = 'normal' | 'insert' | 'visual' | 'vline' | 'command' | 'search'

/** Applied in order; each edit's `pos` refers to the text AFTER the previous edits in the same list. Replace text[pos, pos+del) with ins. */
export interface Edit {
  pos: number
  del: number
  ins: string
}

/** line: linewise register (text ends with '\n'). */
export interface Register {
  text: string
  line: boolean
}

export interface VimState {
  mode: Mode
  /** Index into text (UTF-16 code units), 0..text.length. Normal/visual: never ON a '\n' unless the line is empty; insert: may equal line end. */
  cursor: number
  /** Visual modes: the other end of the selection. */
  anchor: number
  /** Remembered column for j/k, -1 = unset. */
  goal: number
  /** Partial normal-mode command shown to the user, e.g. '2d', 'g', '"', 'r'. */
  pending: string
  /** Text typed after ':' or '/' while mode is 'command' | 'search'. Entering ':' from a visual mode pre-fills `'<,'>`. */
  cmdline: string
  register: Register
  /** Last search pattern ('' none). */
  search: string
  /** One-line feedback for the status bar ('' none); cleared on next key. */
  message: string
  /** Last f/F/t/T as kind + char (e.g. 'fx'), used by ; and , — undefined until one is used. */
  lastFind?: string
}

export interface KeyInput {
  /** Printable text (may be multiple chars when pasted); '' for named keys. */
  input: string
  ctrl?: boolean
  named?: 'escape' | 'return' | 'backspace' | 'delete' | 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'pageUp' | 'pageDown' | 'tab'
}

export type Effect =
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'yank'; text: string }
  | { kind: 'save' }
  | { kind: 'close' }
  | { kind: 'quit' }
  | { kind: 'rename'; name: string }

/** height = visible text rows (Ctrl+D/Ctrl+U move half of it, PageUp/PageDown all of it, in logical lines). */
export interface VimContext {
  text: string
  height: number
}

export interface VimResult {
  state: VimState
  edits: Edit[]
  effects: Effect[]
}

const MAX_COUNT = 99999
const END_GOAL = 1e9
// Private-use tokens for keys that are not printable characters: Home, PageDown/Ctrl+F/Ctrl+D...
const HOME = '\uE000'
const PAGE_DOWN = '\uE001'
const PAGE_UP = '\uE002'
const HALF_DOWN = '\uE003'
const HALF_UP = '\uE004'
const REDO = '\uE005'
const MOTIONS = `hljk0^$wWbBeEG{};,nN${HOME}${PAGE_DOWN}${PAGE_UP}${HALF_DOWN}${HALF_UP}`
const NORMAL_CMDS = `xXDCsSYpPJ~uiaIAoOvV:/${REDO}`
const VISUAL_CMDS = 'dxXDcsSCyY<>~JovV:'
const NAMED_TOKENS: Record<string, string> = {
  left: 'h',
  right: 'l',
  up: 'k',
  down: 'j',
  home: HOME,
  end: '$',
  pageDown: PAGE_DOWN,
  pageUp: PAGE_UP,
}
const CTRL_TOKENS: Record<string, string> = { r: REDO, d: HALF_DOWN, u: HALF_UP, f: PAGE_DOWN, b: PAGE_UP }
const REVERSE_FIND: Record<string, string> = { f: 'F', F: 'f', t: 'T', T: 't' }
const EX_SIMPLE: Record<string, 'save' | 'close' | 'quit'> = {
  w: 'save',
  'w!': 'save',
  q: 'close',
  'q!': 'close',
  wq: 'close',
  'wq!': 'close',
  x: 'close',
  'x!': 'close',
  qa: 'quit',
  'qa!': 'quit',
}
const PAIRS: Record<string, [string, string]> = {
  '(': ['(', ')'],
  ')': ['(', ')'],
  b: ['(', ')'],
  '[': ['[', ']'],
  ']': ['[', ']'],
  '{': ['{', '}'],
  '}': ['{', '}'],
  B: ['{', '}'],
}
const LIST_RE = /^([ \t]*)(?:([-*+])|(\d+)\.)([ \t]+)([\s\S]*)$/
const WORD_RE = /[\p{L}\p{N}_]/u

export function initialVim(): VimState {
  return {
    mode: 'normal',
    cursor: 0,
    anchor: 0,
    goal: -1,
    pending: '',
    cmdline: '',
    register: { text: '', line: false },
    search: '',
    message: '',
  }
}

// ---------------------------------------------------------------- text geometry

function lineStart(t: string, i: number): number {
  return i <= 0 ? 0 : t.lastIndexOf('\n', i - 1) + 1
}

function lineEnd(t: string, i: number): number {
  const k = t.indexOf('\n', i)
  return k < 0 ? t.length : k
}

/** First non-blank of the line containing i, or the line end when the line is blank. */
function firstNonBlank(t: string, i: number): number {
  const e = lineEnd(t, i)
  let k = lineStart(t, i)
  while (k < e && (t.charAt(k) === ' ' || t.charAt(k) === '\t')) k++
  return k
}

/** Start of the 0-based line `idx`, clamped to the last line. */
function lineStartAt(t: string, idx: number): number {
  let s = 0
  for (let k = 0; k < idx; k++) {
    const e = lineEnd(t, s)
    if (e >= t.length) break
    s = e + 1
  }
  return s
}

/** Where a cursor may rest in normal/visual modes. */
function norm(t: string, pos: number): number {
  let i = Math.max(pos, 0)
  if (i >= t.length) {
    if (t.length === 0 || t.charAt(t.length - 1) === '\n') return t.length
    i = t.length - 1
  }
  if (t.charAt(i) === '\n' && i > 0 && t.charAt(i - 1) !== '\n') return i - 1
  return i
}

function clampPos(mode: Mode, t: string, pos: number): number {
  return mode === 'insert' ? Math.min(Math.max(pos, 0), t.length) : norm(t, pos)
}

function has(set: string, ch: string): boolean {
  return ch !== '' && set.includes(ch)
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

/** 0 = blank (space, tab, newline), 1 = word char (any non-blank for WORDs), 2 = punctuation. */
function cls(ch: string, big: boolean): number {
  if (ch === '' || ch === ' ' || ch === '\t' || ch === '\n') return 0
  if (big) return 1
  return WORD_RE.test(ch) ? 1 : 2
}

function wordFwd(t: string, from: number, big: boolean): number {
  const n = t.length
  let i = from
  if (i >= n) return n
  const k = cls(t.charAt(i), big)
  if (k !== 0) {
    while (i < n && cls(t.charAt(i), big) === k) i++
  } else if (t.charAt(i) === '\n') {
    i++
  }
  while (i < n && cls(t.charAt(i), big) === 0) {
    if (t.charAt(i) === '\n' && t.charAt(i - 1) === '\n') break
    i++
  }
  return i
}

function wordEnd(t: string, from: number, big: boolean): number {
  const n = t.length
  let i = from + 1
  while (i < n && cls(t.charAt(i), big) === 0) i++
  if (i >= n) return Math.max(n - 1, 0)
  const k = cls(t.charAt(i), big)
  while (i + 1 < n && cls(t.charAt(i + 1), big) === k) i++
  return i
}

function wordBack(t: string, from: number, big: boolean): number {
  if (from <= 0) return 0
  let i = from - 1
  while (i > 0 && cls(t.charAt(i), big) === 0) {
    if (t.charAt(i) === '\n' && t.charAt(i - 1) === '\n') return i
    i--
  }
  const k = cls(t.charAt(i), big)
  if (k === 0) return i
  while (i > 0 && cls(t.charAt(i - 1), big) === k) i--
  return i
}

function paraFwd(t: string, from: number, count: number): number {
  let s = lineStart(t, from)
  for (let k = 0; k < count; k++) {
    for (;;) {
      const e = lineEnd(t, s)
      if (e !== s) break
      if (e >= t.length) return t.length
      s = e + 1
    }
    for (;;) {
      const e = lineEnd(t, s)
      if (e === s) break
      if (e >= t.length) return t.length
      s = e + 1
    }
  }
  return s
}

function paraBack(t: string, from: number, count: number): number {
  let s = lineStart(t, from)
  for (let k = 0; k < count; k++) {
    while (s > 0 && lineEnd(t, s) === s) s = lineStart(t, s - 1)
    while (s > 0 && lineEnd(t, s) !== s) s = lineStart(t, s - 1)
  }
  return s
}

function runStart(t: string, i: number, ls: number, big: boolean): number {
  const k = cls(t.charAt(i), big)
  let j = i
  while (j > ls && cls(t.charAt(j - 1), big) === k) j--
  return j
}

function runEnd(t: string, i: number, le: number, big: boolean): number {
  const k = cls(t.charAt(i), big)
  let j = i
  while (j < le && cls(t.charAt(j), big) === k) j++
  return j
}

function toggleCase(s: string): string {
  let out = ''
  for (const ch of s) out += ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()
  return out
}

// ---------------------------------------------------------------- working state

interface Work {
  mode: Mode
  cursor: number
  anchor: number
  goal: number
  pending: string
  cmdline: string
  register: Register
  search: string
  message: string
  lastFind: string | undefined
  text: string
  height: number
  edits: Edit[]
  effects: Effect[]
}

function splice(w: Work, pos: number, del: number, ins: string): void {
  if (del === 0 && ins === '') return
  w.edits.push({ pos, del, ins })
  w.text = w.text.slice(0, pos) + ins + w.text.slice(pos + del)
}

function toState(w: Work): VimState {
  const s: VimState = {
    mode: w.mode,
    cursor: w.cursor,
    anchor: w.anchor,
    goal: w.goal,
    pending: w.pending,
    cmdline: w.cmdline,
    register: w.register,
    search: w.search,
    message: w.message,
  }
  if (w.lastFind !== undefined) s.lastFind = w.lastFind
  return s
}

function finalize(w: Work): void {
  w.cursor = clampPos(w.mode, w.text, w.cursor)
  w.anchor = w.mode === 'insert' ? Math.min(Math.max(w.anchor, 0), w.text.length) : norm(w.text, w.anchor)
}

// ---------------------------------------------------------------- selection

interface Rng {
  s: number
  e: number
  line: boolean
}

function selectionOf(mode: Mode, cursor: number, anchor: number, t: string): { start: number; end: number; line: boolean } | null {
  if (mode !== 'visual' && mode !== 'vline') return null
  const a = Math.min(cursor, anchor)
  const b = Math.max(cursor, anchor)
  if (mode === 'vline') return { start: lineStart(t, a), end: lineEnd(t, b), line: true }
  return { start: a, end: Math.min(b + 1, t.length), line: false }
}

/** Active selection for rendering/copying: charwise inclusive of both ends; vline = whole lines (end is the last line's end, excluding its '\n'). `end` is exclusive. */
export function selection(state: VimState, text: string): { start: number; end: number; line: boolean } | null {
  return selectionOf(state.mode, state.cursor, state.anchor, text)
}

/** After the text changed outside the editor (remote edit, undo): clamp cursor/anchor into the new text and off a trailing '\n' in normal/visual modes. */
export function clampCursor(state: VimState, text: string): VimState {
  return {
    ...state,
    cursor: clampPos(state.mode, text, state.cursor),
    anchor: clampPos(state.mode === 'insert' ? 'insert' : 'normal', text, state.anchor),
  }
}

// ---------------------------------------------------------------- motions

interface Mot {
  pos: number
  line: boolean
  incl: boolean
  goal?: number
  find?: string
}

function vertical(t: string, c: number, down: boolean, lines: number, goal: number, insert: boolean): Mot | null {
  const ls = lineStart(t, c)
  let s = ls
  let moved = 0
  if (down) {
    while (moved < lines) {
      const e = lineEnd(t, s)
      if (e >= t.length) break
      s = e + 1
      moved++
    }
  } else {
    while (moved < lines && s > 0) {
      s = lineStart(t, s - 1)
      moved++
    }
  }
  if (moved === 0) return null
  const g = goal >= 0 ? goal : c - ls
  const len = lineEnd(t, s) - s
  return { pos: s + Math.min(g, insert ? len : Math.max(len - 1, 0)), line: true, incl: false, goal: g }
}

function findMatch(t: string, from: number, pat: string, forward: boolean): { idx: number; wrapped: boolean } | null {
  if (forward) {
    const i = t.indexOf(pat, from + 1)
    if (i >= 0) return { idx: i, wrapped: false }
    const j = t.indexOf(pat)
    return j >= 0 ? { idx: j, wrapped: true } : null
  }
  const i = from > 0 ? t.lastIndexOf(pat, from - 1) : -1
  if (i >= 0) return { idx: i, wrapped: false }
  const j = t.lastIndexOf(pat)
  return j >= 0 ? { idx: j, wrapped: true } : null
}

function motion(w: Work, key: string, count: number | null, forOp: boolean): Mot | null {
  const t = w.text
  const c = w.cursor
  const n = count ?? 1
  const ls = lineStart(t, c)
  const le = lineEnd(t, c)
  switch (key) {
    case 'h':
      return { pos: Math.max(c - n, ls), line: false, incl: false }
    case 'l':
      return { pos: Math.min(c + n, forOp ? le : Math.max(le - 1, c)), line: false, incl: false }
    case 'j':
    case 'k':
      return vertical(t, c, key === 'j', n, w.goal, false)
    case HALF_DOWN:
    case HALF_UP:
      return vertical(t, c, key === HALF_DOWN, Math.max(1, Math.floor(w.height / 2)), w.goal, false)
    case PAGE_DOWN:
    case PAGE_UP:
      return vertical(t, c, key === PAGE_DOWN, Math.max(1, w.height), w.goal, false)
    case '0':
    case HOME:
      return { pos: ls, line: false, incl: false }
    case '^':
      return { pos: firstNonBlank(t, c), line: false, incl: false }
    case '$': {
      let s = ls
      for (let k = 1; k < n; k++) {
        const e = lineEnd(t, s)
        if (e >= t.length) break
        s = e + 1
      }
      const e = lineEnd(t, s)
      return { pos: e > s ? e - 1 : e, line: false, incl: true, goal: END_GOAL }
    }
    case 'w':
    case 'W':
    case 'e':
    case 'E':
    case 'b':
    case 'B': {
      const big = key === 'W' || key === 'E' || key === 'B'
      const step = key === 'w' || key === 'W' ? wordFwd : key === 'e' || key === 'E' ? wordEnd : wordBack
      let p = c
      for (let k = 0; k < n; k++) {
        const q = step(t, p, big)
        if (q === p) break
        p = q
      }
      return { pos: p, line: false, incl: key === 'e' || key === 'E' }
    }
    case 'G':
    case 'gg': {
      const s = count === null ? (key === 'G' ? lineStart(t, t.length) : 0) : lineStartAt(t, count - 1)
      return { pos: firstNonBlank(t, s), line: true, incl: false }
    }
    case '}':
      return { pos: paraFwd(t, c, n), line: false, incl: false }
    case '{':
      return { pos: paraBack(t, c, n), line: false, incl: false }
    case 'n':
    case 'N': {
      if (w.search === '') {
        w.message = 'no previous search pattern'
        return null
      }
      let pos = c
      for (let k = 0; k < n; k++) {
        const r = findMatch(t, pos, w.search, key === 'n')
        if (!r) {
          w.message = `pattern not found: ${w.search}`
          return null
        }
        pos = r.idx
        if (r.wrapped) w.message = key === 'n' ? 'search hit BOTTOM, continuing at TOP' : 'search hit TOP, continuing at BOTTOM'
      }
      return { pos, line: false, incl: false }
    }
    default:
      break
  }
  let find = key
  const repeat = key === ';' || key === ','
  if (repeat) {
    if (w.lastFind === undefined) return null
    find = key === ';' ? w.lastFind : (REVERSE_FIND[w.lastFind.charAt(0)] ?? '') + w.lastFind.slice(1)
  }
  const kind = find.charAt(0)
  const ch = find.slice(1)
  if (!has('fFtT', kind) || ch === '') return null
  const forward = kind === 'f' || kind === 't'
  let from = c
  if (repeat && kind === 't' && t.startsWith(ch, c + 1)) from = c + 1
  if (repeat && kind === 'T' && c - ch.length >= 0 && t.startsWith(ch, c - ch.length)) from = c - ch.length
  let j = from
  for (let k = 0; k < n; k++) {
    j = forward ? t.indexOf(ch, j + 1) : j > 0 ? t.lastIndexOf(ch, j - 1) : -1
    if (j < 0 || (forward ? j >= le : j < ls)) return null
  }
  const pos = kind === 't' ? j - 1 : kind === 'T' ? j + ch.length : j
  const m: Mot = { pos, line: false, incl: forward }
  if (!repeat) m.find = find
  return m
}

function motionRange(t: string, c: number, m: Mot): Rng {
  if (m.line) return { s: lineStart(t, Math.min(c, m.pos)), e: lineEnd(t, Math.max(c, m.pos)), line: true }
  const s = Math.min(c, m.pos)
  let e = Math.max(c, m.pos)
  if (m.incl) {
    if (e < t.length && t.charAt(e) !== '\n') e++
  } else if (e > s && t.charAt(e - 1) === '\n') {
    // exclusive motion ending in column 0 of a later line stops at the end of the previous line
    e--
  }
  return { s, e, line: false }
}

// ---------------------------------------------------------------- text objects

function wordObject(t: string, c: number, n: number, big: boolean, around: boolean): Rng | null {
  const ls = lineStart(t, c)
  const le = lineEnd(t, c)
  if (c >= le) return null
  let s = runStart(t, c, ls, big)
  let e = runEnd(t, c, le, big)
  if (!around) {
    for (let k = 1; k < n && e < le; k++) e = runEnd(t, e, le, big)
  } else if (cls(t.charAt(c), big) === 0) {
    if (e < le) e = runEnd(t, e, le, big)
    for (let k = 1; k < n && e < le; k++) {
      e = runEnd(t, e, le, big)
      if (e < le) e = runEnd(t, e, le, big)
    }
  } else {
    if (e < le && cls(t.charAt(e), big) === 0) e = runEnd(t, e, le, big)
    else if (s > ls && cls(t.charAt(s - 1), big) === 0) s = runStart(t, s - 1, ls, big)
    for (let k = 1; k < n && e < le; k++) {
      e = runEnd(t, e, le, big)
      if (e < le && cls(t.charAt(e), big) === 0) e = runEnd(t, e, le, big)
    }
  }
  return { s, e, line: false }
}

function paragraphObject(t: string, c: number, n: number, around: boolean): Rng {
  const starts: number[] = [0]
  const ends: number[] = []
  for (let s = 0; ; ) {
    const e = lineEnd(t, s)
    ends.push(e)
    if (e >= t.length) break
    s = e + 1
    starts.push(s)
  }
  const total = starts.length
  let cur = 0
  while (cur + 1 < total && (starts[cur + 1] ?? 0) <= c) cur++
  const blank = (i: number): boolean => (starts[i] ?? 0) === (ends[i] ?? 0)
  const blockEnd = (i: number): number => {
    let j = i
    while (j + 1 < total && blank(j + 1) === blank(i)) j++
    return j
  }
  const blockStart = (i: number): number => {
    let j = i
    while (j > 0 && blank(j - 1) === blank(i)) j--
    return j
  }
  let a = blockStart(cur)
  let b = blockEnd(cur)
  if (!around) {
    for (let k = 1; k < n && b + 1 < total; k++) b = blockEnd(b + 1)
  } else {
    const wasBlank = blank(cur)
    if (b + 1 < total) b = blockEnd(b + 1)
    else if (!wasBlank && a > 0) a = blockStart(a - 1)
    for (let k = 1; k < n && b + 1 < total; k++) {
      b = blockEnd(b + 1)
      if (b + 1 < total) b = blockEnd(b + 1)
    }
  }
  return { s: starts[a] ?? 0, e: ends[b] ?? t.length, line: true }
}

function quoteObject(t: string, c: number, q: string, around: boolean): Rng | null {
  const ls = lineStart(t, c)
  const le = lineEnd(t, c)
  const qs: number[] = []
  for (let k = ls; k < le; k++) if (t.charAt(k) === q && (k === ls || t.charAt(k - 1) !== '\\')) qs.push(k)
  for (let p = 0; p + 1 < qs.length; p += 2) {
    const q1 = qs[p] ?? 0
    const q2 = qs[p + 1] ?? 0
    if (q2 < c) continue
    if (!around) return { s: q1 + 1, e: q2, line: false }
    let s = q1
    let e = q2 + 1
    if (t.charAt(e) === ' ' || t.charAt(e) === '\t') {
      while (e < le && (t.charAt(e) === ' ' || t.charAt(e) === '\t')) e++
    } else {
      while (s > ls && (t.charAt(s - 1) === ' ' || t.charAt(s - 1) === '\t')) s--
    }
    return { s, e, line: false }
  }
  return null
}

function bracketObject(t: string, c: number, open: string, close: string, around: boolean): Rng | null {
  const ls = lineStart(t, c)
  const le = lineEnd(t, c)
  let o = -1
  if (t.charAt(c) === open) {
    o = c
  } else {
    let depth = 0
    for (let i = c - 1; i >= ls; i--) {
      const ch = t.charAt(i)
      if (ch === close) depth++
      else if (ch === open) {
        if (depth === 0) {
          o = i
          break
        }
        depth--
      }
    }
  }
  if (o < 0) return null
  let cl = -1
  let depth = 0
  for (let i = o + 1; i < le; i++) {
    const ch = t.charAt(i)
    if (ch === open) depth++
    else if (ch === close) {
      if (depth === 0) {
        cl = i
        break
      }
      depth--
    }
  }
  if (cl < 0) return null
  return around ? { s: o, e: cl + 1, line: false } : { s: o + 1, e: cl, line: false }
}

function textObject(t: string, c: number, key: string, n: number): Rng | null {
  const around = key.charAt(0) === 'a'
  const obj = key.charAt(1)
  if (obj === 'w' || obj === 'W') return wordObject(t, c, n, obj === 'W', around)
  if (obj === 'p') return paragraphObject(t, c, n, around)
  if (obj === '"' || obj === "'" || obj === '`') return quoteObject(t, c, obj, around)
  if (Object.hasOwn(PAIRS, obj)) {
    const pair = PAIRS[obj]
    return pair ? bracketObject(t, c, pair[0], pair[1], around) : null
  }
  return null
}

// ---------------------------------------------------------------- list continuation

/** Prefix (indent + list marker) a new line after `line` should start with. `col` = cursor column; a cursor inside the marker only copies indentation. */
function continuation(line: string, col: number, increment: boolean): string {
  const m = LIST_RE.exec(line)
  if (m) {
    const indent = m[1] ?? ''
    const bullet = m[2]
    const num = m[3] ?? ''
    const gap = m[4] ?? ''
    const rest = m[5] ?? ''
    const head = indent.length + (bullet !== undefined ? 1 : num.length + 1) + gap.length
    if (rest.trim() !== '' && col >= head) {
      return indent + (bullet ?? `${increment ? Number(num) + 1 : num}.`) + gap
    }
  }
  const indent = /^[ \t]*/.exec(line)?.[0] ?? ''
  return indent.slice(0, col)
}

function openLine(w: Work, below: boolean): void {
  const t = w.text
  const ls = lineStart(t, w.cursor)
  const le = lineEnd(t, w.cursor)
  const prefix = continuation(t.slice(ls, le), le - ls, below)
  if (below) {
    splice(w, le, 0, `\n${prefix}`)
    w.cursor = le + 1 + prefix.length
  } else {
    splice(w, ls, 0, `${prefix}\n`)
    w.cursor = ls + prefix.length
  }
  w.mode = 'insert'
}

// ---------------------------------------------------------------- operators

function deleteLines(w: Work, s: number, e: number): void {
  const t = w.text
  w.register = { text: `${t.slice(s, e)}\n`, line: true }
  if (e < t.length) {
    splice(w, s, e + 1 - s, '')
    w.cursor = firstNonBlank(w.text, s)
  } else if (s > 0) {
    splice(w, s - 1, e - s + 1, '')
    w.cursor = firstNonBlank(w.text, lineStart(w.text, s - 1))
  } else {
    splice(w, 0, e, '')
    w.cursor = 0
  }
}

function applyOp(w: Work, op: string, r: Rng): void {
  const t = w.text
  const c = w.cursor
  const body = t.slice(r.s, r.e)
  if (op === 'y') {
    if (body === '' && !r.line) return
    const text = r.line ? `${body}\n` : body
    w.register = { text, line: r.line }
    w.effects.push({ kind: 'yank', text })
    const cs = lineStart(t, c)
    w.cursor = r.line && cs !== r.s ? Math.min(r.s + (c - cs), lineEnd(t, r.s)) : r.line ? c : r.s
    return
  }
  if (op === 'd' && r.line) {
    deleteLines(w, r.s, r.e)
    return
  }
  if (body !== '' || r.line) {
    w.register = { text: r.line ? `${body}\n` : body, line: r.line }
    splice(w, r.s, r.e - r.s, '')
  }
  w.cursor = r.s
  if (op === 'c') w.mode = 'insert'
}

function shiftLines(w: Work, s: number, e: number, dir: number, times: number): void {
  const starts: number[] = []
  for (let p = s; ; ) {
    starts.push(p)
    const le = lineEnd(w.text, p)
    if (le >= e) break
    p = le + 1
  }
  for (let k = starts.length - 1; k >= 0; k--) {
    const p = starts[k] ?? 0
    const le = lineEnd(w.text, p)
    if (dir > 0) {
      if (le > p) splice(w, p, 0, '  '.repeat(times))
      continue
    }
    let q = p
    let left = 2 * times
    while (left > 0 && q < le && (w.text.charAt(q) === ' ' || w.text.charAt(q) === '\t')) {
      left -= w.text.charAt(q) === '\t' ? left : 1
      q++
    }
    splice(w, p, q - p, '')
  }
  w.cursor = firstNonBlank(w.text, s)
}

function runOperator(w: Work, op: string, key: string, count: number | null): void {
  const t = w.text
  const c = w.cursor
  let range: Rng | null = null
  if (key === op) {
    let last = lineStart(t, c)
    for (let k = 1; k < (count ?? 1); k++) {
      const e = lineEnd(t, last)
      if (e >= t.length) break
      last = e + 1
    }
    range = { s: lineStart(t, c), e: lineEnd(t, last), line: true }
  } else if (key.charAt(0) === 'i' || key.charAt(0) === 'a') {
    range = textObject(t, c, key, count ?? 1)
  } else {
    let m: Mot | null
    if ((op === 'c' && (key === 'w' || key === 'W')) && cls(t.charAt(c), false) !== 0) {
      // cw behaves like ce, but a cursor already on the last char of a word changes just that word
      const big = key === 'W'
      const k0 = cls(t.charAt(c), big)
      let j = c
      while (j + 1 < t.length && cls(t.charAt(j + 1), big) === k0) j++
      for (let k = 1; k < (count ?? 1); k++) {
        const nj = wordEnd(t, j, big)
        if (nj === j) break
        j = nj
      }
      m = { pos: j, line: false, incl: true }
    } else {
      m = motion(w, key, count, true)
    }
    if (!m) return
    if (m.find !== undefined) w.lastFind = m.find
    range = motionRange(t, c, m)
  }
  if (!range) return
  if (op === '>' || op === '<') shiftLines(w, range.s, range.e, op === '>' ? 1 : -1, 1)
  else applyOp(w, op, range)
}

// ---------------------------------------------------------------- simple commands

function paste(w: Work, after: boolean, n: number): void {
  const reg = w.register
  if (reg.text === '') return
  const t = w.text
  const c = w.cursor
  const body = reg.text.repeat(n)
  if (reg.line) {
    const at = after ? lineEnd(t, c) : lineStart(t, c)
    if (after && at >= t.length) {
      splice(w, at, 0, `\n${body.slice(0, -1)}`)
      w.cursor = firstNonBlank(w.text, at + 1)
    } else {
      const pos = after ? at + 1 : at
      splice(w, pos, 0, body)
      w.cursor = firstNonBlank(w.text, pos)
    }
    return
  }
  const pos = after && c < lineEnd(t, c) ? c + 1 : c
  splice(w, pos, 0, body)
  w.cursor = body.includes('\n') ? pos : pos + body.length - 1
}

/** Join `n` lines starting at the line containing `at`; a no-op on the last line. */
function joinLines(w: Work, at: number, n: number): void {
  let cur = at
  let spot = -1
  for (let k = 1; k < n; k++) {
    const t = w.text
    const e = lineEnd(t, cur)
    if (e >= t.length) break
    let ws = 0
    while (t.charAt(e + 1 + ws) === ' ' || t.charAt(e + 1 + ws) === '\t') ws++
    const next = t.charAt(e + 1 + ws)
    const prev = t.charAt(e - 1)
    const space = next !== '' && next !== '\n' && next !== ')' && e > lineStart(t, e) && prev !== ' ' && prev !== '\t'
    splice(w, e, 1 + ws, space ? ' ' : '')
    spot = space ? e : Math.max(e - 1, lineStart(w.text, e))
    cur = e
  }
  if (spot >= 0) w.cursor = spot
}

function normalCommand(w: Work, key: string, count: number | null): void {
  const t = w.text
  const c = w.cursor
  const n = count ?? 1
  const le = lineEnd(t, c)
  switch (key.charAt(0)) {
    case 'x':
      runOperator(w, 'd', 'l', count)
      return
    case 'X':
      runOperator(w, 'd', 'h', count)
      return
    case 'D':
      runOperator(w, 'd', '$', count)
      return
    case 'C':
      runOperator(w, 'c', '$', count)
      return
    case 's':
      runOperator(w, 'c', 'l', count)
      return
    case 'S':
      runOperator(w, 'c', 'c', count)
      return
    case 'Y':
      runOperator(w, 'y', 'y', count)
      return
    case 'p':
      paste(w, true, n)
      return
    case 'P':
      paste(w, false, n)
      return
    case 'J':
      joinLines(w, c, Math.max(2, n))
      return
    case 'r': {
      const ch = key.slice(1)
      if (c + n > le) return
      splice(w, c, n, ch.repeat(n))
      w.cursor = c + n * ch.length - 1
      return
    }
    case '~': {
      const e = Math.min(c + n, le)
      if (e <= c) return
      splice(w, c, e - c, toggleCase(t.slice(c, e)))
      w.cursor = e
      return
    }
    case 'u':
      w.effects.push({ kind: 'undo' })
      return
    case REDO:
      w.effects.push({ kind: 'redo' })
      return
    case 'i':
      w.mode = 'insert'
      return
    case 'a':
      if (c < le) w.cursor = c + 1
      w.mode = 'insert'
      return
    case 'I':
      w.cursor = firstNonBlank(t, c)
      w.mode = 'insert'
      return
    case 'A':
      w.cursor = le
      w.mode = 'insert'
      return
    case 'o':
    case 'O':
      openLine(w, key === 'o')
      return
    case 'v':
    case 'V':
      w.anchor = c
      w.mode = key === 'v' ? 'visual' : 'vline'
      return
    case ':':
      w.mode = 'command'
      w.cmdline = ''
      return
    case '/':
      w.mode = 'search'
      w.cmdline = ''
      return
    case 'Z':
      w.effects.push({ kind: 'close' })
      return
    default:
      return
  }
}

function visualCommand(w: Work, key: string, count: number | null): void {
  const t = w.text
  const sel = selectionOf(w.mode, w.cursor, w.anchor, t)
  if (!sel) return
  const range: Rng = { s: sel.start, e: sel.end, line: sel.line }
  const rows: Rng = {
    s: lineStart(t, sel.start),
    e: lineEnd(t, sel.line ? sel.end : Math.max(sel.end - 1, sel.start)),
    line: true,
  }
  const top = Math.min(w.cursor, w.anchor)
  const first = key.charAt(0)
  if (first === 'i' || first === 'a') {
    const obj = textObject(t, w.cursor, key, count ?? 1)
    if (!obj) return
    w.anchor = obj.s
    w.cursor = obj.line ? lineStart(t, obj.e) : Math.max(obj.e - 1, obj.s)
    w.mode = obj.line ? 'vline' : 'visual'
    return
  }
  switch (first) {
    case 'o': {
      const a = w.anchor
      w.anchor = w.cursor
      w.cursor = a
      return
    }
    case 'v':
    case 'V': {
      const target = first === 'v' ? 'visual' : 'vline'
      w.mode = w.mode === target ? 'normal' : target
      return
    }
    case ':':
      w.mode = 'command'
      w.cmdline = "'<,'>"
      return
    case 'd':
    case 'x':
      w.mode = 'normal'
      applyOp(w, 'd', range)
      return
    case 'X':
    case 'D':
      w.mode = 'normal'
      applyOp(w, 'd', rows)
      return
    case 'y':
    case 'Y':
      w.mode = 'normal'
      applyOp(w, 'y', first === 'y' ? range : rows)
      w.cursor = top
      return
    case 'c':
    case 's':
      applyOp(w, 'c', range)
      return
    case 'C':
    case 'S':
      applyOp(w, 'c', rows)
      return
    case '>':
    case '<':
      w.mode = 'normal'
      shiftLines(w, rows.s, rows.e, first === '>' ? 1 : -1, count ?? 1)
      return
    case '~':
      w.mode = 'normal'
      splice(w, range.s, range.e - range.s, toggleCase(t.slice(range.s, range.e)))
      w.cursor = range.s
      return
    case 'J': {
      w.mode = 'normal'
      const lines = t.slice(rows.s, rows.e).split('\n').length
      joinLines(w, rows.s, Math.max(2, lines))
      return
    }
    default:
      return
  }
}

// ---------------------------------------------------------------- normal / visual key parsing

type Parsed =
  | { t: 'more' | 'char' | 'bad' }
  | { t: 'cmd'; op: string; key: string; count: number | null }

function motionKey(rest: string): 'ok' | 'more' | 'char' | 'bad' {
  const ch = rest.charAt(0)
  if (ch === 'g') return rest.length === 1 ? 'more' : rest === 'gg' ? 'ok' : 'bad'
  if (has('fFtT', ch)) {
    const args = [...rest.slice(1)].length
    return args === 0 ? 'char' : args === 1 ? 'ok' : 'bad'
  }
  return rest.length === 1 && has(MOTIONS, ch) ? 'ok' : 'bad'
}

function parseCmd(p: string, visual: boolean): Parsed {
  let i = 0
  if (p.charAt(0) === '"') {
    if (p.length < 2) return { t: 'char' }
    i = 2
  }
  let digits = ''
  while (isDigit(p.charAt(i)) && (p.charAt(i) !== '0' || digits !== '')) digits += p.charAt(i++)
  const count1 = digits === '' ? null : Math.min(Number(digits), MAX_COUNT)
  const c = p.charAt(i)
  if (!visual && has('dcy<>', c)) {
    i++
    let digits2 = ''
    while (isDigit(p.charAt(i)) && (p.charAt(i) !== '0' || digits2 !== '')) digits2 += p.charAt(i++)
    const count2 = digits2 === '' ? null : Math.min(Number(digits2), MAX_COUNT)
    const count = count1 === null ? count2 : count2 === null ? count1 : Math.min(count1 * count2, MAX_COUNT)
    const rest = p.slice(i)
    if (rest === '') return { t: 'more' }
    if (rest === c) return { t: 'cmd', op: c, key: c, count }
    if (c === '<' || c === '>') return { t: 'bad' }
    const ch = rest.charAt(0)
    if (ch === 'i' || ch === 'a') {
      if (rest.length === 1) return { t: 'char' }
      return rest.length === 2 ? { t: 'cmd', op: c, key: rest, count } : { t: 'bad' }
    }
    const mk = motionKey(rest)
    return mk === 'ok' ? { t: 'cmd', op: c, key: rest, count } : { t: mk }
  }
  const rest = p.slice(i)
  if (rest === '') return { t: 'more' }
  const ch = rest.charAt(0)
  if (visual && (ch === 'i' || ch === 'a')) {
    if (rest.length === 1) return { t: 'char' }
    return rest.length === 2 ? { t: 'cmd', op: '', key: rest, count: count1 } : { t: 'bad' }
  }
  if (!visual && ch === 'r') {
    const args = [...rest.slice(1)].length
    if (args === 0) return { t: 'char' }
    return args === 1 ? { t: 'cmd', op: '', key: rest, count: count1 } : { t: 'bad' }
  }
  if (!visual && ch === 'Z') {
    if (rest.length === 1) return { t: 'more' }
    return rest === 'ZZ' ? { t: 'cmd', op: '', key: rest, count: count1 } : { t: 'bad' }
  }
  if (ch === 'g' || has('fFtT', ch)) {
    const mk = motionKey(rest)
    return mk === 'ok' ? { t: 'cmd', op: '', key: rest, count: count1 } : { t: mk }
  }
  if (rest.length === 1 && (has(MOTIONS, ch) || has(visual ? VISUAL_CMDS : NORMAL_CMDS, ch))) {
    return { t: 'cmd', op: '', key: rest, count: count1 }
  }
  return { t: 'bad' }
}

function normalKey(w: Work, key: KeyInput): void {
  const visual = w.mode === 'visual' || w.mode === 'vline'
  if (visual && (key.named === 'backspace' || key.named === 'delete')) {
    w.pending = ''
    return visualCommand(w, 'd', null)
  }
  const printable = !key.named && !key.ctrl && key.input !== ''
  let token = ''
  if (key.named) token = Object.hasOwn(NAMED_TOKENS, key.named) ? (NAMED_TOKENS[key.named] ?? '') : ''
  else if (key.ctrl) token = Object.hasOwn(CTRL_TOKENS, key.input) ? (CTRL_TOKENS[key.input] ?? '') : ''
  else token = key.input
  const prev = w.pending === '' ? null : parseCmd(w.pending, visual)
  if (token === '' || (!printable && prev?.t === 'char')) {
    w.pending = ''
    return
  }
  const p = w.pending + token
  const r = parseCmd(p, visual)
  if (r.t !== 'cmd') {
    w.pending = r.t === 'bad' ? '' : p
    return
  }
  w.pending = ''
  if (r.op) {
    runOperator(w, r.op, r.key, r.count)
    w.goal = -1
    return
  }
  if (has('gfFtT', r.key.charAt(0)) || (r.key.length === 1 && has(MOTIONS, r.key))) {
    const m = motion(w, r.key, r.count, false)
    if (!m) return
    if (m.find !== undefined) w.lastFind = m.find
    w.cursor = norm(w.text, m.pos)
    w.goal = m.goal ?? -1
    return
  }
  if (visual) visualCommand(w, r.key, r.count)
  else normalCommand(w, r.key, r.count)
  w.goal = -1
}

// ---------------------------------------------------------------- insert mode

function enterKey(w: Work): void {
  const t = w.text
  const c = w.cursor
  const ls = lineStart(t, c)
  const le = lineEnd(t, c)
  const line = t.slice(ls, le)
  const m = LIST_RE.exec(line)
  if (m && (m[5] ?? '').trim() === '') {
    const head = (m[1] ?? '').length + (m[2] !== undefined ? 1 : (m[3] ?? '').length + 1) + (m[4] ?? '').length
    if (c - ls >= head) {
      splice(w, ls, le - ls, '')
      w.cursor = ls
      return
    }
  }
  const prefix = continuation(line, c - ls, true)
  splice(w, c, 0, `\n${prefix}`)
  w.cursor = c + 1 + prefix.length
}

function insertKey(w: Work, key: KeyInput): void {
  const t = w.text
  const c = w.cursor
  const ls = lineStart(t, c)
  const le = lineEnd(t, c)
  if (key.named) {
    let goal = -1
    switch (key.named) {
      case 'return':
        enterKey(w)
        break
      case 'backspace':
        if (c > 0) {
          splice(w, c - 1, 1, '')
          w.cursor = c - 1
        }
        break
      case 'delete':
        if (c < t.length) splice(w, c, 1, '')
        break
      case 'left':
        if (c > ls) w.cursor = c - 1
        break
      case 'right':
        if (c < le) w.cursor = c + 1
        break
      case 'home':
        w.cursor = ls
        break
      case 'end':
        w.cursor = le
        break
      case 'up':
      case 'down':
      case 'pageUp':
      case 'pageDown': {
        const lines = key.named === 'up' || key.named === 'down' ? 1 : Math.max(1, w.height)
        const m = vertical(t, c, key.named === 'down' || key.named === 'pageDown', lines, w.goal, true)
        if (m) {
          w.cursor = m.pos
          goal = m.goal ?? -1
        } else {
          goal = w.goal
        }
        break
      }
      case 'tab':
        splice(w, c, 0, '  ')
        w.cursor = c + 2
        break
      default:
        break
    }
    w.goal = goal
    return
  }
  w.goal = -1
  if (key.ctrl) {
    if (key.input === 'w') {
      let i = c
      if (i === ls) {
        if (i > 0) i--
      } else {
        while (i > ls && cls(t.charAt(i - 1), false) === 0) i--
        const k = cls(t.charAt(i - 1), false)
        while (i > ls && cls(t.charAt(i - 1), false) === k) i--
      }
      splice(w, i, c - i, '')
      w.cursor = i
    } else if (key.input === 'u' && c > ls) {
      splice(w, ls, c - ls, '')
      w.cursor = ls
    }
    return
  }
  if (key.input !== '') {
    splice(w, c, 0, key.input)
    w.cursor = c + key.input.length
  }
}

// ---------------------------------------------------------------- command and search mode

function exCommand(w: Work, raw: string): void {
  let cmd = raw.trim()
  let rows: { s: number; e: number } | null = null
  if (cmd.startsWith("'<,'>")) {
    const lo = Math.min(w.cursor, w.anchor)
    const hi = Math.max(w.cursor, w.anchor)
    rows = { s: lineStart(w.text, lo), e: lineEnd(w.text, hi) }
    cmd = cmd.slice(5).trim()
  } else if (cmd.startsWith('%')) {
    rows = { s: 0, e: w.text.length }
    cmd = cmd.slice(1).trim()
  }
  if (cmd === '') return
  if (Object.hasOwn(EX_SIMPLE, cmd)) {
    const kind = EX_SIMPLE[cmd]
    if (kind === 'save') {
      w.effects.push({ kind: 'save' })
      w.message = 'saved (changes sync automatically)'
    } else if (kind) {
      w.effects.push({ kind })
    }
    return
  }
  if (rows === null && /^\d+$/.test(cmd)) {
    w.cursor = firstNonBlank(w.text, lineStartAt(w.text, Math.max(Number(cmd), 1) - 1))
    return
  }
  const rename = /^rename(?:\s+(\S[\s\S]*))?$/.exec(cmd)
  if (rename) {
    if (rename[1] === undefined) w.message = 'rename needs a name'
    else w.effects.push({ kind: 'rename', name: rename[1].trim() })
    return
  }
  if (cmd.charAt(0) === 's' && cmd.length >= 2 && !/[A-Za-z0-9\s"|\\]/.test(cmd.charAt(1))) {
    substitute(w, cmd, rows ?? { s: lineStart(w.text, w.cursor), e: lineEnd(w.text, w.cursor) })
    return
  }
  w.message = `not a command: ${raw.trim()}`
}

function substitute(w: Work, cmd: string, rows: { s: number; e: number }): void {
  const d = cmd.charAt(1)
  let i = 2
  let pat = ''
  while (i < cmd.length && cmd.charAt(i) !== d) {
    if (cmd.charAt(i) === '\\' && i + 1 < cmd.length) {
      pat += cmd.slice(i, i + 2)
      i += 2
    } else {
      pat += cmd.charAt(i++)
    }
  }
  i++
  let rep = ''
  while (i < cmd.length && cmd.charAt(i) !== d) {
    if (cmd.charAt(i) === '\\' && cmd.charAt(i + 1) === d) {
      rep += d
      i += 2
    } else {
      rep += cmd.charAt(i++)
    }
  }
  i++
  const flags = cmd.slice(i).trim()
  if (!/^[gi]*$/.test(flags)) {
    w.message = `not a command: ${cmd}`
    return
  }
  const global = flags.includes('g')
  const ci = flags.includes('i') ? 'i' : ''
  let first: RegExp
  let all: RegExp
  try {
    if (pat === '') throw new SyntaxError('empty')
    first = new RegExp(pat, ci)
    all = new RegExp(pat, `g${ci}`)
  } catch {
    w.message = 'bad pattern'
    return
  }
  const lines = w.text.slice(rows.s, rows.e).split('\n')
  let total = 0
  let lastChanged = -1
  const out = lines.map((line, idx) => {
    const hits = global ? (line.match(all)?.length ?? 0) : first.test(line) ? 1 : 0
    if (hits === 0) return line
    total += hits
    lastChanged = idx
    return line.replace(global ? all : first, rep)
  })
  const block = out.join('\n')
  splice(w, rows.s, rows.e - rows.s, block)
  if (lastChanged >= 0) {
    let off = rows.s
    for (let k = 0; k < lastChanged; k++) off += (out[k] ?? '').length + 1
    w.cursor = firstNonBlank(w.text, off)
  }
  w.message = `${total} substitutions`
}

function searchExec(w: Work, pat: string): void {
  const p = pat === '' ? w.search : pat
  if (p === '') return
  w.search = p
  const r = findMatch(w.text, w.cursor, p, true)
  if (!r) {
    w.message = `pattern not found: ${p}`
    return
  }
  w.cursor = r.idx
  if (r.wrapped) w.message = 'search hit BOTTOM, continuing at TOP'
}

function cmdKey(w: Work, key: KeyInput): void {
  if (key.named === 'return') {
    const line = w.cmdline
    const searching = w.mode === 'search'
    w.mode = 'normal'
    w.cmdline = ''
    if (searching) searchExec(w, line)
    else exCommand(w, line)
    return
  }
  if (key.named === 'backspace') {
    if (w.cmdline === '') w.mode = 'normal'
    else w.cmdline = w.cmdline.slice(0, -1)
    return
  }
  if (key.named) return
  if (key.ctrl) {
    if (key.input === 'u') w.cmdline = ''
    return
  }
  w.cmdline += key.input
}

// ---------------------------------------------------------------- entry point

function step(w: Work, key: KeyInput): void {
  w.message = ''
  if (key.ctrl === true && key.input === 'a' && w.mode !== 'command' && w.mode !== 'search') {
    w.mode = 'visual'
    w.anchor = 0
    w.cursor = norm(w.text, w.text.length)
    w.pending = ''
    w.goal = -1
    finalize(w)
    return
  }
  if (key.named === 'escape') {
    if (w.mode === 'insert') {
      if (w.cursor > lineStart(w.text, w.cursor)) w.cursor--
    } else if (w.mode === 'command' || w.mode === 'search') {
      w.cmdline = ''
    }
    w.mode = 'normal'
    w.pending = ''
  } else if (w.mode === 'insert') {
    insertKey(w, key)
  } else if (w.mode === 'command' || w.mode === 'search') {
    cmdKey(w, key)
  } else {
    normalKey(w, key)
  }
  finalize(w)
}

export function handleKey(state: VimState, key: KeyInput, ctx: VimContext): VimResult {
  const w: Work = {
    mode: state.mode,
    cursor: state.cursor,
    anchor: state.anchor,
    goal: state.goal,
    pending: state.pending,
    cmdline: state.cmdline,
    register: state.register,
    search: state.search,
    message: '',
    lastFind: state.lastFind,
    text: ctx.text,
    height: ctx.height,
    edits: [],
    effects: [],
  }
  finalize(w)
  const typed = !key.named && !key.ctrl && key.input.length > 1
  if (typed && (w.mode === 'normal' || w.mode === 'visual' || w.mode === 'vline')) {
    for (const ch of key.input) step(w, { input: ch })
  } else {
    step(w, key)
  }
  return { state: toState(w), edits: w.edits, effects: w.effects }
}
