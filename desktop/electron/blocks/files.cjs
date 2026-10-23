'use strict'
// Main-process handler of the Files block. The renderer never touches the disk: every read, write, listing,
// git query and media URL goes through `methods`, and every path is checked against the roots the user granted
// (the pane's cwd, a path given to `pager open`, or an absolute path typed into quick open).
const fs = require('node:fs')
const fsp = fs.promises
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

const WIN = process.platform === 'win32'
const TEXT_LIMIT = 16 * 1024 * 1024
const BINARY_LIMIT = 96 * 1024 * 1024
const GIT_TIMEOUT = 20000
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'apng'])
const AUDIO_EXT = new Set(['mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'aac', 'opus', 'weba'])
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv'])
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml', avif: 'image/avif', apng: 'image/apng', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  oga: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm', mp4: 'video/mp4', m4v: 'video/mp4',
  webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', ogv: 'video/ogg', pdf: 'application/pdf',
}
const WALK_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'target'])
const WATCH_SKIP = /(^|[\\/])(node_modules|\.hg|\.svn|__pycache__|target)([\\/]|$)/

// ---------- paths ----------

/** Lexical containment: is `target` equal to or inside `root` (case-insensitive on Windows)? */
function isWithin(root, target) {
  const r = path.resolve(root)
  const t = path.resolve(target)
  const rel = path.relative(WIN ? r.toLowerCase() : r, WIN ? t.toLowerCase() : t)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith('..' + path.sep)
}

const grants = []

function grantRoot(p) {
  const abs = path.resolve(p)
  if (!grants.some((g) => isWithin(g, abs))) {
    for (let i = grants.length - 1; i >= 0; i--) if (isWithin(abs, grants[i])) grants.splice(i, 1)
    grants.push(abs)
  }
  return abs
}

function allowed(abs, list = grants) {
  return list.some((g) => isWithin(g, abs))
}

/** Resolve `p` (absolute, or relative to `root`) and refuse it unless a granted root contains it. */
function resolveAllowed(p, root, list = grants) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) throw new Error('Invalid path')
  const abs = expandHome(p)
  const full = path.isAbsolute(abs) ? path.resolve(abs) : path.resolve(root || process.cwd(), abs)
  if (!allowed(full, list)) throw new Error('Outside the folders you opened: ' + full)
  return full
}

function expandHome(p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/')
}

function extOf(p) {
  const e = path.extname(p).slice(1).toLowerCase()
  return e
}

function kindByExt(p) {
  const e = extOf(p)
  if (IMAGE_EXT.has(e)) return 'image'
  if (e === 'pdf') return 'pdf'
  if (AUDIO_EXT.has(e)) return 'audio'
  if (VIDEO_EXT.has(e)) return 'video'
  return null
}

// ---------- text decoding ----------

function looksBinary(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
// Windows-1252 maps 0x80-0x9F to punctuation; derive both directions from the platform decoder so they always agree.
const CP1252 = new TextDecoder('windows-1252')
const CP1252_REV = new Map()
for (let b = 0x80; b < 0xa0; b++) {
  const ch = CP1252.decode(Uint8Array.of(b))
  if (ch !== '\ufffd' && ch.charCodeAt(0) !== b) CP1252_REV.set(ch, b)
}

function swap16(buf) {
  const b = Buffer.from(buf)
  b.swap16()
  return b
}

/** Decode a file's bytes. `want` forces an encoding ('utf8' | 'utf16le' | 'utf16be' | 'latin1' = Windows-1252); otherwise it is sniffed from the BOM. */
function decodeText(buf, want) {
  let enc = want || 'utf8'
  let bom = false
  let start = 0
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { bom = true; start = 3; if (!want) enc = 'utf8' }
  else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) { bom = true; start = 2; if (!want) enc = 'utf16le' }
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { bom = true; start = 2; if (!want) enc = 'utf16be' }
  const body = buf.subarray(start)
  let text
  if (enc === 'utf16le') text = body.toString('utf16le')
  else if (enc === 'utf16be') text = swap16(body.subarray(0, body.length & ~1)).toString('utf16le')
  else if (enc === 'latin1') text = CP1252.decode(body)
  else {
    // Valid UTF-8 stays UTF-8. Without a BOM or an explicit choice, bytes that are not valid UTF-8 mean a legacy 8-bit file: Windows-1252.
    try {
      text = UTF8_STRICT.decode(body)
    } catch {
      if (!want && !bom) return { text: CP1252.decode(body), encoding: 'latin1', bom: false, sniffed: true }
      return { text: body.toString('utf8'), encoding: enc, bom, lossy: true }
    }
  }
  return { text, encoding: enc, bom }
}

function encodeText(text, { encoding = 'utf8', bom = false, eol = 'lf' } = {}) {
  const body = eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n')
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    let b = Buffer.from(body, 'utf16le')
    if (encoding === 'utf16be') b = swap16(b)
    return bom ? Buffer.concat([Buffer.from(encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]), b]) : b
  }
  if (encoding === 'latin1') {
    const out = Buffer.alloc(body.length)
    for (let i = 0; i < body.length; i++) {
      const c = body.charCodeAt(i)
      out[i] = CP1252_REV.get(body[i]) ?? (c < 256 ? c : 0x3f)
    }
    return out
  }
  const b = Buffer.from(body, 'utf8')
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]) : b
}

/** 'crlf' when most line breaks are \r\n. */
function detectEol(text) {
  let crlf = 0
  let lf = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++
    else lf++
  }
  return crlf > lf ? 'crlf' : 'lf'
}

// ---------- git ----------

function git(args, cwd, input) {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile('git', ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args], {
        cwd, windowsHide: true, timeout: GIT_TIMEOUT, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        resolve({ code, stdout: stdout || '', stderr: stderr || '' })
      })
    } catch {
      resolve({ code: -1, stdout: '', stderr: 'git unavailable' })
      return
    }
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

const repoCache = new Map()

async function repoOf(dir) {
  const hit = repoCache.get(dir)
  if (hit && Date.now() - hit.t < 8000) return hit.root
  const r = await git(['rev-parse', '--show-toplevel'], dir)
  const root = r.code === 0 ? path.resolve(r.stdout.trim()) : null
  repoCache.set(dir, { t: Date.now(), root })
  return root
}

/** Parse `git diff -U0` output into hunks. A header omits a count of 1. */
function parseHunks(diff) {
  const out = []
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
  for (let m = re.exec(diff); m; m = re.exec(diff)) {
    out.push({
      oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2],
      newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4],
    })
  }
  return out
}

/** Gutter marks, 1-based lines of the new text: added/modified ranges, and `removed` = lines deleted after line N (0 = before line 1). */
function hunksToMarks(hunks) {
  return hunks.map((h) => {
    if (h.newCount === 0) return { kind: 'removed', line: h.newStart }
    const end = h.newStart + h.newCount - 1
    return { kind: h.oldCount === 0 ? 'added' : 'modified', start: h.newStart, end }
  })
}

async function indexText(repo, abs) {
  const r = await git(['show', ':' + rel(repo, abs)], repo)
  return r.code === 0 ? r.stdout.replace(/\r\n/g, '\n') : null
}

async function gutter({ path: p, root, text }) {
  const abs = resolveAllowed(p, root)
  const dir = path.dirname(abs)
  const repo = await repoOf(dir)
  if (!repo) return { repo: false, tracked: false, marks: [], count: 0 }
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  const base = await indexText(repo, abs)
  if (base === null) {
    const marks = lines ? [{ kind: 'added', start: 1, end: lines }] : []
    return { repo: true, tracked: false, marks, count: marks.length }
  }
  const baseFile = path.join(scratchDir(), crypto.createHash('sha1').update(abs).digest('hex') + '.base')
  await fsp.writeFile(baseFile, base)
  const r = await git(['diff', '--no-index', '--no-color', '--no-ext-diff', '-U0', '--ignore-cr-at-eol', '--', baseFile, '-'], dir, text.replace(/\r\n/g, '\n'))
  if (r.code !== 0 && r.code !== 1) return { repo: true, tracked: true, marks: [], count: 0, error: r.stderr.trim() }
  const marks = hunksToMarks(parseHunks(r.stdout))
  return { repo: true, tracked: true, marks, count: marks.length }
}

let scratch = null
function scratchDir() {
  if (!scratch) {
    scratch = path.join(os.tmpdir(), 'pager-files-' + process.pid)
    fs.mkdirSync(scratch, { recursive: true })
  }
  return scratch
}

/** Parse `git status --porcelain=v2 --branch -z`. */
function parseStatusV2(out) {
  const res = { branch: null, ahead: 0, behind: 0, entries: [] }
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]
    if (!s) continue
    if (s.startsWith('# branch.head ')) res.branch = s.slice(14)
    else if (s.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(s)
      if (m) { res.ahead = +m[1]; res.behind = +m[2] }
    } else if (s[0] === '1') {
      const f = s.split(' ')
      res.entries.push({ path: f.slice(8).join(' '), xy: f[1] })
    } else if (s[0] === '2') {
      const f = s.split(' ')
      res.entries.push({ path: f.slice(9).join(' '), xy: f[1] })
      i++
    } else if (s[0] === 'u') {
      const f = s.split(' ')
      res.entries.push({ path: f.slice(10).join(' '), xy: 'UU' })
    } else if (s[0] === '?') res.entries.push({ path: s.slice(2), xy: '??' })
  }
  return res
}

function statusLetter(xy) {
  if (xy === '??') return '?'
  if (xy[0] === 'U' || xy[1] === 'U' || xy === 'AA' || xy === 'DD') return 'U'
  if (xy.includes('D')) return 'D'
  if (xy[0] === 'A') return 'A'
  if (xy.includes('R')) return 'R'
  return 'M'
}

async function status({ root }) {
  const abs = resolveAllowed(root, root)
  const repo = await repoOf(abs)
  if (!repo) return { repo: false }
  const [st, ig] = await Promise.all([
    git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], abs),
    git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], abs),
  ])
  const p = parseStatusV2(st.stdout)
  const files = {}
  let changed = 0
  let untracked = 0
  let staged = 0
  for (const e of p.entries) {
    const letter = statusLetter(e.xy)
    if (letter === '?') untracked++
    else {
      changed++
      if (e.xy[0] !== '.' && e.xy[0] !== '?') staged++
    }
    const full = path.join(repo, e.path.replace(/\/$/, ''))
    if (!isWithin(abs, full)) continue
    files[rel(abs, full) + (e.path.endsWith('/') ? '/' : '')] = letter
  }
  const ignored = ig.stdout.split('\0').filter(Boolean)
  return { repo: true, root: repo, branch: p.branch, ahead: p.ahead, behind: p.behind, changed, untracked, staged, files, ignored }
}

// ---------- listing, search ----------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

async function list({ dir, root, compact }) {
  const abs = resolveAllowed(dir, root)
  let ents
  try {
    ents = await fsp.readdir(abs, { withFileTypes: true })
  } catch (e) {
    return { entries: [], error: e.code || String(e.message) }
  }
  const rows = []
  for (const d of ents) {
    if (d.name === '.git') continue
    let isDir = d.isDirectory()
    if (d.isSymbolicLink()) {
      try { isDir = (await fsp.stat(path.join(abs, d.name))).isDirectory() } catch { /* dangling link */ }
    }
    rows.push({ name: d.name, dir: isDir, link: d.isSymbolicLink() || undefined })
  }
  rows.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1))
  if (compact && rows.length <= 400) {
    await Promise.all(rows.map(async (r) => {
      if (!r.dir || r.link || WALK_SKIP.has(r.name)) return
      let cur = path.join(abs, r.name)
      const names = [r.name]
      for (let depth = 0; depth < 8; depth++) {
        let kids
        try { kids = await fsp.readdir(cur, { withFileTypes: true }) } catch { break }
        if (kids.length !== 1 || !kids[0].isDirectory() || kids[0].isSymbolicLink() || kids[0].name === '.git') break
        names.push(kids[0].name)
        cur = path.join(cur, kids[0].name)
      }
      if (names.length > 1) { r.label = names.join(' / '); r.target = names.join('/') }
    }))
  }
  return { entries: rows }
}

/** Subsequence match with bonuses for runs, word starts and the basename. Returns null when `q` isn't a subsequence. */
function fuzzyScore(q, text) {
  if (!q) return { score: 0, idx: [] }
  const ql = q.toLowerCase()
  const tl = text.toLowerCase()
  const base = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1
  const idx = []
  let score = 0
  let ti = 0
  let prev = -2
  for (let qi = 0; qi < ql.length; qi++) {
    const ch = ql[qi]
    let at = tl.indexOf(ch, ti)
    if (at === -1) return null
    // Prefer a word-start or basename hit when one is near.
    const alt = tl.indexOf(ch, at + 1)
    if (alt !== -1 && alt - at <= 3 && isBoundary(text, alt) && !isBoundary(text, at)) at = alt
    idx.push(at)
    let s = 1
    if (at === prev + 1) s += 5
    if (isBoundary(text, at)) s += 4
    if (at >= base) s += 2
    if (at === base) s += 4
    score += s
    prev = at
    ti = at + 1
  }
  const exact = tl.indexOf(ql, base)
  if (exact !== -1) score += 12 + (exact === base ? 10 : 0)
  score -= Math.min(10, (text.length - base) * 0.05) + text.length * 0.01
  return { score, idx }
}

function isBoundary(text, i) {
  if (i === 0) return true
  const c = text[i - 1]
  return c === '/' || c === '\\' || c === '.' || c === '_' || c === '-' || c === ' ' || (c >= 'a' && c <= 'z' && text[i] >= 'A' && text[i] <= 'Z')
}

const indexCache = new Map()

async function buildIndex(abs) {
  const repo = await repoOf(abs)
  if (repo) {
    const r = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], abs)
    if (r.code === 0) return r.stdout.split('\0').filter(Boolean)
  }
  const out = []
  const queue = [['', 0]]
  while (queue.length && out.length < 60000) {
    const [relDir, depth] = queue.shift()
    let ents
    try { ents = await fsp.readdir(path.join(abs, relDir), { withFileTypes: true }) } catch { continue }
    for (const d of ents) {
      if (d.isDirectory()) {
        if (!WALK_SKIP.has(d.name) && depth < 12) queue.push([relDir ? relDir + '/' + d.name : d.name, depth + 1])
      } else out.push(relDir ? relDir + '/' + d.name : d.name)
    }
  }
  return out
}

async function find({ root, query, limit = 50 }) {
  const abs = resolveAllowed(root, root)
  let ent = indexCache.get(abs)
  if (!ent || Date.now() - ent.t > 15000) {
    const prev = ent
    const fresh = { t: Date.now(), files: prev ? prev.files : null, loading: null }
    fresh.loading = buildIndex(abs).then((f) => { fresh.files = f; fresh.loading = null; return f })
    indexCache.set(abs, fresh)
    ent = fresh
    if (!fresh.files) await fresh.loading
  }
  const files = ent.files || []
  const q = (query || '').trim()
  if (!q) return { total: files.length, results: files.slice(0, limit).map((p) => ({ path: p, idx: [] })) }
  const scored = []
  for (const p of files) {
    const m = fuzzyScore(q, p)
    if (m) scored.push({ path: p, score: m.score, idx: m.idx })
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return { total: scored.length, results: scored.slice(0, limit) }
}

async function complete({ prefix }) {
  const raw = expandHome(String(prefix || ''))
  if (!path.isAbsolute(raw)) return { entries: [] }
  const endsSep = /[\\/]$/.test(raw)
  const dir = endsSep ? raw : path.dirname(raw)
  const part = endsSep ? '' : path.basename(raw).toLowerCase()
  let ents
  try { ents = await fsp.readdir(dir, { withFileTypes: true }) } catch { return { entries: [] } }
  const entries = ents
    .filter((d) => d.name.toLowerCase().startsWith(part) && d.name !== '.git')
    .map((d) => ({ path: path.join(dir, d.name), dir: d.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? collator.compare(a.path, b.path) : a.dir ? -1 : 1))
    .slice(0, 60)
  return { entries }
}

// ---------- reading and writing ----------

async function info({ path: p, root }) {
  const abs = resolveAllowed(p, root)
  const st = await fsp.stat(abs)
  const repo = await repoOf(st.isDirectory() ? abs : path.dirname(abs))
  return { path: abs, dir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs, kind: st.isDirectory() ? 'dir' : kindByExt(abs) || 'text', repo }
}

// ---------- .editorconfig ----------

/** editorconfig glob -> RegExp matching a path relative to the directory of the .editorconfig (forward slashes). */
function ecGlob(glob) {
  const anchored = glob.includes('/')
  const g = glob.replace(/^\//, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++ } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const j = g.indexOf(']', i + 1)
      if (j === -1) re += '\\['
      else {
        let body = g.slice(i + 1, j)
        if (body[0] === '!') body = '^' + body.slice(1)
        re += '[' + body.replace(/\\/g, '\\\\') + ']'
        i = j
      }
    } else if (c === '{') {
      const j = g.indexOf('}', i + 1)
      const body = j === -1 ? null : g.slice(i + 1, j)
      const range = body && /^(-?\d+)\.\.(-?\d+)$/.exec(body)
      if (range) {
        const lo = Math.min(+range[1], +range[2])
        const hi = Math.max(+range[1], +range[2])
        const alts = []
        for (let n = lo; n <= hi && alts.length < 256; n++) alts.push(String(n))
        re += '(?:' + alts.join('|') + ')'
        i = j
      } else if (body !== null && body.includes(',')) {
        re += '(?:' + body.split(',').map((a) => a.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('|') + ')'
        i = j
      } else re += '\\{'
    } else if (c === '}') re += '\\}'
    else if ('.+^$()|\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + (anchored ? '' : '(?:.*/)?') + re + '$', WIN ? 'i' : '')
}

function parseEditorConfig(text) {
  const sections = []
  let root = false
  let cur = null
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line[0] === '#' || line[0] === ';') continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) { cur = { glob: sec[1], props: {} }; sections.push(cur); continue }
    const kv = /^([^=:]+?)\s*[=:]\s*(.*?)\s*$/.exec(line)
    if (!kv) continue
    const k = kv[1].toLowerCase()
    const v = kv[2].toLowerCase()
    if (cur) cur.props[k] = v
    else if (k === 'root') root = v === 'true'
  }
  return { root, sections }
}

/** Resolved .editorconfig properties for a file, nearest file wins; `indent_size = tab` and a missing size fall back to tab_width. */
async function editorconfig({ path: p, root }) {
  const abs = resolveAllowed(p, root)
  const props = {}
  const chain = []
  for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
    let text = null
    try { text = await fsp.readFile(path.join(dir, '.editorconfig'), 'utf8') } catch { /* none here */ }
    if (text !== null) {
      const ec = parseEditorConfig(text)
      chain.unshift({ dir, ec })
      if (ec.root) break
    }
    if (path.dirname(dir) === dir) break
  }
  for (const { dir, ec } of chain) {
    const relp = path.relative(dir, abs).split(path.sep).join('/')
    for (const s of ec.sections) {
      let re
      try { re = ecGlob(s.glob) } catch { continue }
      if (re.test(relp)) Object.assign(props, s.props)
    }
  }
  const out = {}
  if (props.indent_style === 'tab' || props.indent_style === 'space') out.indentStyle = props.indent_style
  const tw = parseInt(props.tab_width, 10)
  const size = props.indent_size === 'tab' ? tw : parseInt(props.indent_size, 10)
  if (size > 0) out.indentSize = Math.min(size, 16)
  if (tw > 0) out.tabWidth = Math.min(tw, 16)
  if (props.end_of_line === 'lf' || props.end_of_line === 'crlf') out.eol = props.end_of_line
  if (props.charset === 'utf-8' || props.charset === 'utf-8-bom') { out.encoding = 'utf8'; out.bom = props.charset === 'utf-8-bom' }
  else if (props.charset === 'utf-16le') { out.encoding = 'utf16le'; out.bom = true } else if (props.charset === 'utf-16be') { out.encoding = 'utf16be'; out.bom = true } else if (props.charset === 'latin1') out.encoding = 'latin1'
  if (props.trim_trailing_whitespace === 'true') out.trimTrailing = true
  if (props.insert_final_newline === 'true') out.finalNewline = true
  return out
}

async function read({ path: p, root, encoding, as }) {
  const abs = resolveAllowed(p, root)
  const st = await fsp.stat(abs)
  if (st.isDirectory()) return { kind: 'dir', path: abs }
  const base = { path: abs, name: path.basename(abs), size: st.size, mtimeMs: st.mtimeMs }
  const byExt = kindByExt(abs)
  if (byExt && !as) {
    if (byExt === 'pdf') return { ...base, kind: 'pdf' }
    return { ...base, kind: byExt, url: await mediaUrl(abs) }
  }
  if (as === 'hex') return { ...base, kind: 'binary' }
  const fh = await fsp.open(abs, 'r')
  try {
    const head = Buffer.alloc(Math.min(8192, st.size))
    if (head.length) await fh.read(head, 0, head.length, 0)
    if (as !== 'text' && looksBinary(head)) return { ...base, kind: 'binary' }
    if (st.size > TEXT_LIMIT && as !== 'text') return { ...base, kind: 'large' }
    if (st.size > TEXT_LIMIT * 4) return { ...base, kind: 'large' }
    const buf = await fh.readFile()
    const d = decodeText(buf, encoding)
    const eol = detectEol(d.text)
    return { ...base, kind: 'text', content: d.text.replace(/\r\n/g, '\n'), eol, encoding: d.encoding, bom: d.bom, lossy: d.lossy || undefined, sniffed: d.sniffed || undefined }
  } finally {
    await fh.close()
  }
}

async function readBinary({ path: p, root, maxBytes = BINARY_LIMIT }) {
  const abs = resolveAllowed(p, root)
  const st = await fsp.stat(abs)
  if (st.size > maxBytes) throw new Error('File too large to preview (' + st.size + ' bytes)')
  const buf = await fsp.readFile(abs)
  return { b64: buf.toString('base64'), size: st.size, mtimeMs: st.mtimeMs }
}

async function hex({ path: p, root, offset = 0, length = 4096 }) {
  const abs = resolveAllowed(p, root)
  const fh = await fsp.open(abs, 'r')
  try {
    const st = await fh.stat()
    const n = Math.max(0, Math.min(length, 1 << 20, st.size - offset))
    const buf = Buffer.alloc(n)
    if (n) await fh.read(buf, 0, n, offset)
    return { b64: buf.toString('base64'), offset, size: st.size }
  } finally {
    await fh.close()
  }
}

async function write({ path: p, root, content, eol, encoding, bom, expectMtimeMs, force }) {
  const abs = resolveAllowed(p, root)
  if (typeof content !== 'string') throw new Error('No content')
  let st = null
  try { st = await fsp.stat(abs) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!force && typeof expectMtimeMs === 'number') {
    if (!st) return { conflict: true, deleted: true }
    if (Math.abs(st.mtimeMs - expectMtimeMs) > 0.5) return { conflict: true, mtimeMs: st.mtimeMs, size: st.size }
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  const bytes = encodeText(content, { encoding, bom, eol })
  const tmp = abs + '.pager-' + crypto.randomBytes(4).toString('hex') + '.tmp'
  try {
    await fsp.writeFile(tmp, bytes)
    if (st) await fsp.chmod(tmp, st.mode & 0o7777).catch(() => {})
    await fsp.rename(tmp, abs)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    if (!st) throw e
    await fsp.writeFile(abs, bytes) // read-only parents, hard links and locked renames: write in place
  }
  const after = await fsp.stat(abs)
  return { ok: true, mtimeMs: after.mtimeMs, size: after.size }
}

async function create({ path: p, root, kind }) {
  const abs = resolveAllowed(p, root)
  if (kind === 'dir') await fsp.mkdir(abs, { recursive: false })
  else {
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, '', { flag: 'wx' })
  }
  return { path: abs }
}

async function rename({ from, to, root }) {
  const a = resolveAllowed(from, root)
  const b = resolveAllowed(to, root)
  try { await fsp.access(b); throw new Error('Already exists: ' + path.basename(b)) } catch (e) { if (e.code !== 'ENOENT') throw e }
  await fsp.rename(a, b)
  return { path: b }
}

// ---------- electron-only operations (absent under plain node) ----------

function electron() {
  try {
    const e = require('electron')
    return e && typeof e === 'object' && e.shell ? e : null
  } catch { return null }
}

async function remove({ path: p, root }) {
  const abs = resolveAllowed(p, root)
  const e = electron()
  if (!e) throw new Error('The recycle bin is not available here')
  await e.shell.trashItem(abs)
  return { ok: true }
}

async function reveal({ path: p, root }) {
  const abs = resolveAllowed(p, root)
  const e = electron()
  if (!e) throw new Error('Not available outside the desktop app')
  e.shell.showItemInFolder(abs)
  return { ok: true }
}

async function openDefault({ path: p, root }) {
  const abs = resolveAllowed(p, root)
  const e = electron()
  if (!e) throw new Error('Not available outside the desktop app')
  const err = await e.shell.openPath(abs)
  if (err) throw new Error(err)
  return { ok: true }
}

async function pickSave({ defaultPath, root }) {
  const e = electron()
  if (!e) throw new Error('Not available outside the desktop app')
  const r = await e.dialog.showSaveDialog({ defaultPath: defaultPath ? resolveAllowed(defaultPath, root) : undefined })
  if (r.canceled || !r.filePath) return { path: null }
  return { path: grantRoot(r.filePath) }
}

async function pickFolder({ defaultPath }) {
  const e = electron()
  if (!e) throw new Error('Not available outside the desktop app')
  const r = await e.dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath: defaultPath ? expandHome(defaultPath) : undefined })
  if (r.canceled || !r.filePaths[0]) return { path: null }
  return { path: grantRoot(r.filePaths[0]) }
}

// ---------- media server: range-capable loopback HTTP for <img>, <audio>, <video> ----------

let server = null
let serverReady = null
let serverPort = 0
const token = crypto.randomBytes(12).toString('hex')
const served = new Map()

/** Parse a single `Range: bytes=a-b` header against a size. Returns null (whole file), 'bad' (416) or {start,end}. */
function parseRange(header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'bad'
  let start
  let end
  if (m[1] === '') {
    const n = +m[2]
    if (n === 0) return 'bad'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = +m[1]
    end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1)
  }
  if (start >= size || start > end) return 'bad'
  return { start, end }
}

function serveFile(req, res) {
  const host = req.headers.host || ''
  const m = /^\/f\/([0-9a-f]+)\/([0-9a-f]+)(?:\/|$)/.exec(req.url || '')
  if (!m || m[1] !== token || host !== '127.0.0.1:' + serverPort || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404).end()
    return
  }
  const file = served.get(m[2])
  if (!file) { res.writeHead(404).end(); return }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end(); return }
    const range = parseRange(req.headers.range, st.size)
    const headers = {
      'Content-Type': MIME[extOf(file)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    }
    if (range === 'bad') { res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + st.size }).end(); return }
    const part = range || { start: 0, end: Math.max(0, st.size - 1) }
    headers['Content-Length'] = st.size === 0 ? 0 : part.end - part.start + 1
    if (range) headers['Content-Range'] = `bytes ${part.start}-${part.end}/${st.size}`
    res.writeHead(range ? 206 : 200, headers)
    if (req.method === 'HEAD' || st.size === 0) { res.end(); return }
    const stream = fs.createReadStream(file, { start: part.start, end: part.end })
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  })
}

function ensureServer() {
  if (!serverReady) {
    serverReady = new Promise((resolve, reject) => {
      server = http.createServer(serveFile)
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => { serverPort = server.address().port; resolve() })
    })
  }
  return serverReady
}

async function mediaUrl(abs) {
  await ensureServer()
  let id = null
  for (const [k, v] of served) if (v === abs) { id = k; break }
  if (!id) {
    id = crypto.randomBytes(6).toString('hex')
    served.set(id, abs)
    if (served.size > 400) served.delete(served.keys().next().value)
  }
  return `http://127.0.0.1:${serverPort}/f/${token}/${id}/${encodeURIComponent(path.basename(abs))}`
}

async function media({ path: p, root }) {
  return { url: await mediaUrl(resolveAllowed(p, root)) }
}

// ---------- watching ----------

const watchers = new Map()

function debounced(fn, ms) {
  let t = null
  return (...a) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}

function watch({ path: p, root, id }, ctx) {
  const abs = resolveAllowed(p, root)
  unwatch({ id })
  const emit = ctx && typeof ctx.emit === 'function' ? ctx.emit.bind(ctx) : () => {}
  const fire = debounced(() => emit('changed', { id, path: abs }), 150)
  const w = fs.watch(abs, { persistent: false }, fire)
  w.on('error', () => {})
  watchers.set(id, w)
  return { ok: true }
}

function watchTree({ root, id }, ctx) {
  const abs = resolveAllowed(root, root)
  unwatch({ id })
  const emit = ctx && typeof ctx.emit === 'function' ? ctx.emit.bind(ctx) : () => {}
  const fire = debounced(() => emit('tree', { id, root: abs }), 350)
  let w
  try {
    w = fs.watch(abs, { persistent: false, recursive: true }, (_ev, name) => {
      if (!name) return fire()
      const n = String(name)
      if (n === '.git' || n.startsWith('.git' + path.sep)) {
        if (/^\.git[\\/](index|HEAD)$/.test(n) || /^\.git[\\/]refs/.test(n)) fire()
        return
      }
      if (!WATCH_SKIP.test(n)) fire()
    })
  } catch {
    return { ok: false }
  }
  w.on('error', () => {})
  watchers.set(id, w)
  return { ok: true }
}

function unwatch({ id }) {
  const w = watchers.get(id)
  if (w) { try { w.close() } catch { /* already closed */ } watchers.delete(id) }
  return { ok: true }
}

// ---------- registration ----------

async function grant({ path: p }) {
  const abs = path.resolve(expandHome(String(p || '')))
  const st = await fsp.stat(abs)
  const root = st.isDirectory() ? abs : path.dirname(abs)
  grantRoot(root)
  return { path: abs, root, dir: st.isDirectory(), kind: st.isDirectory() ? 'dir' : kindByExt(abs) || 'text', home: os.homedir() }
}

const methods = {
  grant: async (a) => grant(a),
  info: async (a) => info(a),
  editorconfig: async (a) => editorconfig(a),
  list: async (a) => list(a),
  read: async (a) => read(a),
  readBinary: async (a) => readBinary(a),
  hex: async (a) => hex(a),
  write: async (a) => write(a),
  create: async (a) => create(a),
  rename: async (a) => rename(a),
  remove: async (a) => remove(a),
  reveal: async (a) => reveal(a),
  openDefault: async (a) => openDefault(a),
  pickSave: async (a) => pickSave(a),
  pickFolder: async (a) => pickFolder(a),
  gutter: async (a) => gutter(a),
  status: async (a) => status(a),
  find: async (a) => find(a),
  complete: async (a) => complete(a),
  media: async (a) => media(a),
  watch: async (a, ctx) => watch(a, ctx),
  watchTree: async (a, ctx) => watchTree(a, ctx),
  unwatch: async (a) => unwatch(a),
}

function dispose() {
  for (const id of [...watchers.keys()]) unwatch({ id })
  if (server) { server.close(); server.closeAllConnections?.(); server = null; serverReady = null }
  served.clear()
  indexCache.clear()
  repoCache.clear()
  if (scratch) { fs.rmSync(scratch, { recursive: true, force: true }); scratch = null }
}

module.exports = {
  methods,
  dispose,
  _t: {
    isWithin, allowed, resolveAllowed, grantRoot, grants, parseHunks, hunksToMarks, parseStatusV2, statusLetter, fuzzyScore, decodeText,
    encodeText, detectEol, parseRange, looksBinary, kindByExt, gutter, write, read, list, find, complete, ecGlob, parseEditorConfig, editorconfig,
  },
}
