'use strict'
// Main-process handler of the git block. Every git command runs here via execFile with an argument array (no
// shell), always in a validated work tree root; output is size-capped and every call can be cancelled by opId.
const { execFile } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const CAP_TEXT = 8 << 20
const CAP_LOG = 24 << 20
const CAP_DIFF = 4 << 20
const TIMEOUT = 30_000
const TIMEOUT_NET = 180_000
const UNDO_DEPTH = 30
const GLOBAL_ARGS = ['--no-pager', '-c', 'color.ui=false', '-c', 'core.quotepath=off', '-c', 'core.editor=true']
const BASE_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_LITERAL_PATHSPECS: '1', GIT_EDITOR: 'true', LC_MESSAGES: 'C' }

/** opId -> running child, for cancel(). */
const running = new Map()
const cancelled = new Set()
/** Own commands in flight / last finish, so our own index writes do not echo back through the watcher. */
let busy = 0
let lastDone = 0

class GitError extends Error {
  constructor(message, extra) {
    super(message)
    this.name = 'GitError'
    Object.assign(this, extra)
  }
}

function errText(r, args) {
  const text = (r.stderr || r.stdout || '').trim().split('\n').slice(0, 8).join('\n')
  return text || `git ${args[0]} failed (exit ${r.code})`
}

/**
 * Runs git. Resolves `{ code, stdout, stderr, truncated }`; a non-zero exit is NOT an error here (see git()).
 * Rejects when git cannot start, on timeout, and when cancelled.
 */
function run(args, { cwd, input, cap = CAP_TEXT, timeout = TIMEOUT, opId, env } = {}) {
  return new Promise((resolve, reject) => {
    busy++
    const done = () => {
      busy--
      lastDone = Date.now()
      if (opId !== undefined) running.delete(opId)
    }
    const child = execFile(
      'git',
      [...GLOBAL_ARGS, ...args],
      { cwd, windowsHide: true, maxBuffer: cap, timeout, encoding: 'utf8', env: { ...process.env, ...BASE_ENV, ...env } },
      (err, stdout, stderr) => {
        const wasCancelled = opId !== undefined && cancelled.delete(opId)
        done()
        if (wasCancelled) return reject(new GitError('cancelled', { cancelled: true }))
        if (!err) return resolve({ code: 0, stdout, stderr, truncated: false })
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          return resolve({ code: 0, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), truncated: true })
        if (err.code === 'ENOENT') return reject(new GitError('git is not installed or not on PATH'))
        if (err.killed && err.signal) return reject(new GitError(`git ${args[0]} timed out after ${Math.round(timeout / 1000)}s`))
        if (typeof err.code === 'number') return resolve({ code: err.code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), truncated: false })
        reject(new GitError(err.message))
      },
    )
    if (opId !== undefined) running.set(opId, child)
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/** run() that throws on non-zero exit unless the code is listed in `ok`. */
async function git(cwd, args, opts = {}) {
  const { ok = [0], ...rest } = opts
  const r = await run(args, { cwd, ...rest })
  if (!ok.includes(r.code)) throw new GitError(errText(r, args), { exit: r.code })
  return r
}

// ---------------------------------------------------------------------------------------------- repository

/** Validated work-tree roots by the path they were resolved from. */
const rootCache = new Map()

/** Resolves any directory (or file) inside a work tree to `{ root, gitDir }`, or null when there is none. */
async function resolveRepo(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || !path.isAbsolute(p)) throw new GitError('a repository path must be absolute')
  let dir = p
  try {
    const st = fs.statSync(p)
    if (!st.isDirectory()) dir = path.dirname(p)
  } catch {
    throw new GitError(`${p} does not exist`)
  }
  const hit = rootCache.get(dir)
  if (hit && fs.existsSync(hit.root)) return hit
  const r = await run(['rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd: dir })
  if (r.code !== 0) return null
  const [top, gitDir] = r.stdout.split('\n').map((s) => s.trim())
  if (!top) return null
  const info = { root: path.normalize(top), gitDir: path.normalize(gitDir) }
  rootCache.set(dir, info)
  rootCache.set(info.root, info)
  return info
}

async function needRepo(args) {
  const info = await resolveRepo(args && (args.root ?? args.cwd))
  if (!info) throw new GitError('not a git repository')
  return info
}

const HEX = /^[0-9a-f]{4,64}$/i
function hex(h) {
  if (typeof h !== 'string' || !HEX.test(h)) throw new GitError('invalid commit id')
  return h
}
function refName(r) {
  if (typeof r !== 'string' || !r || r.startsWith('-') || /[\0-\x1f\x7f ~^:?*[\\]/.test(r) || r.includes('..')) throw new GitError(`invalid ref name: ${r}`)
  return r
}
function cleanPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new GitError('no paths given')
  return paths.map((p) => {
    if (typeof p !== 'string' || !p || p.includes('\0')) throw new GitError('invalid path')
    const n = path.posix.normalize(p.replace(/\\/g, '/'))
    if (n.startsWith('../') || n === '..' || path.posix.isAbsolute(n) || /^[a-z]:/i.test(n)) throw new GitError(`path is outside the repository: ${p}`)
    return n
  })
}
/** Runs `fn(chunk)` over path chunks so argv stays short. */
async function chunked(paths, fn) {
  for (let i = 0; i < paths.length; i += 100) await fn(paths.slice(i, i + 100))
}

// ---------------------------------------------------------------------------------------------- parsers

/** Parses `status --porcelain=v2 --branch -z`. */
function parseStatus(out) {
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 }
  const files = []
  const rec = out.split('\0')
  for (let i = 0; i < rec.length; i++) {
    const r = rec[i]
    if (!r) continue
    if (r.startsWith('# ')) {
      const [k, ...rest] = r.slice(2).split(' ')
      const v = rest.join(' ')
      if (k === 'branch.oid') branch.oid = v === '(initial)' ? null : v
      else if (k === 'branch.head') branch.head = v === '(detached)' ? null : v
      else if (k === 'branch.upstream') branch.upstream = v
      else if (k === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(v)
        if (m) {
          branch.ahead = +m[1]
          branch.behind = +m[2]
        }
      }
    } else if (r[0] === '1') {
      const f = r.split(' ')
      files.push({ path: f.slice(8).join(' '), index: f[1][0], worktree: f[1][1], kind: 'changed' })
    } else if (r[0] === '2') {
      const f = r.split(' ')
      const orig = rec[++i]
      files.push({ path: f.slice(9).join(' '), orig, index: f[1][0], worktree: f[1][1], kind: 'renamed' })
    } else if (r[0] === 'u') {
      const f = r.split(' ')
      files.push({ path: f.slice(10).join(' '), index: f[1][0], worktree: f[1][1], kind: 'unmerged' })
    } else if (r[0] === '?') {
      files.push({ path: r.slice(2), index: '.', worktree: '?', kind: 'untracked' })
    }
  }
  return { branch, files }
}

function countStatus(files) {
  let staged = 0
  let modified = 0
  let untracked = 0
  let conflicted = 0
  for (const f of files) {
    if (f.kind === 'unmerged') conflicted++
    else if (f.kind === 'untracked') untracked++
    else {
      if (f.index !== '.') staged++
      if (f.worktree !== '.') modified++
    }
  }
  return { staged, modified, untracked, conflicted }
}

/**
 * The multi-step operation a repository is in the middle of, from the marker files git leaves in its git dir.
 * `{ kind: 'merge'|'rebase'|'cherry-pick'|'revert', label, step?, total? }` or null.
 */
function operationState(gitDir) {
  const has = (n) => fs.existsSync(path.join(gitDir, n))
  const num = (f) => {
    try {
      const v = parseInt(fs.readFileSync(path.join(gitDir, f), 'utf8'), 10)
      return Number.isFinite(v) ? v : undefined
    } catch {
      return undefined
    }
  }
  if (has('rebase-merge') || has('rebase-apply')) {
    const dir = has('rebase-merge') ? 'rebase-merge' : 'rebase-apply'
    const step = num(dir === 'rebase-merge' ? 'rebase-merge/msgnum' : 'rebase-apply/next')
    const total = num(dir === 'rebase-merge' ? 'rebase-merge/end' : 'rebase-apply/last')
    return { kind: 'rebase', label: 'Rebase in progress', step, total }
  }
  if (has('MERGE_HEAD')) return { kind: 'merge', label: 'Merge in progress' }
  if (has('CHERRY_PICK_HEAD')) return { kind: 'cherry-pick', label: 'Cherry-pick in progress' }
  if (has('REVERT_HEAD')) return { kind: 'revert', label: 'Revert in progress' }
  return null
}

/** `diff-tree --name-status -z` -> [{ status, path, oldPath? }] */
function parseNameStatusZ(out) {
  const t = out.split('\0')
  const files = []
  for (let i = 0; i < t.length; ) {
    const s = t[i++]
    if (!s) break
    if (s[0] === 'R' || s[0] === 'C') {
      const oldPath = t[i++]
      files.push({ status: s[0], path: t[i++], oldPath })
    } else files.push({ status: s[0], path: t[i++] })
  }
  return files
}

/** `diff-tree --numstat -z` -> Map(path -> { add, del, binary }) */
function parseNumstatZ(out) {
  const t = out.split('\0')
  const map = new Map()
  for (let i = 0; i < t.length; ) {
    const s = t[i++]
    if (!s) break
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(s)
    if (!m) continue
    let p = m[3]
    if (p === '') {
      i++ // old path
      p = t[i++]
    }
    map.set(p, m[1] === '-' ? { add: 0, del: 0, binary: true } : { add: +m[1], del: +m[2], binary: false })
  }
  return map
}

function parseTrack(track) {
  let ahead = 0
  let behind = 0
  let gone = false
  if (track === 'gone') gone = true
  const a = /ahead (\d+)/.exec(track)
  const b = /behind (\d+)/.exec(track)
  if (a) ahead = +a[1]
  if (b) behind = +b[1]
  return { ahead, behind, gone }
}

// ---------------------------------------------------------------------------------------------- undo

/** root -> { undo: Entry[], redo: Entry[] } ; Entry = { label, before, after } with before/after = snap(). */
const stacks = new Map()
const stackOf = (root) => {
  let s = stacks.get(root)
  if (!s) stacks.set(root, (s = { undo: [], redo: [] }))
  return s
}

async function snap(root) {
  const [h, b, wt] = await Promise.all([
    git(root, ['rev-parse', '-q', '--verify', 'HEAD'], { ok: [0, 1] }),
    git(root, ['symbolic-ref', '-q', 'HEAD'], { ok: [0, 1] }),
    run(['write-tree'], { cwd: root }),
  ])
  return { head: h.stdout.trim() || null, branch: b.stdout.trim() || null, tree: wt.code === 0 ? wt.stdout.trim() : null }
}
const same = (a, b) => a.head === b.head && a.branch === b.branch && a.tree === b.tree

/** Runs a mutating action and records it on the undo stack when it changed HEAD or the index. */
async function mutate(root, label, fn) {
  const before = await snap(root)
  const result = await fn()
  const s = stackOf(root)
  const after = await snap(root)
  if (before.tree === null || after.tree === null) {
    s.undo.length = 0
    s.redo.length = 0
  } else if (!same(before, after)) {
    s.undo.push({ label, before, after })
    if (s.undo.length > UNDO_DEPTH) s.undo.shift()
    s.redo.length = 0
  }
  return result
}

/** Empties the undo/redo stacks (after an action the index/HEAD-only undo cannot reverse). */
function forgetUndo(root) {
  const s = stackOf(root)
  s.undo.length = 0
  s.redo.length = 0
}

async function restore(root, target) {
  const cur = await snap(root)
  if (cur.branch !== target.branch) throw new GitError('The checked-out branch changed; nothing was undone.')
  if (cur.head !== target.head) {
    if (target.head) await git(root, ['reset', '--soft', target.head])
    else await git(root, ['update-ref', '-d', 'HEAD'])
  }
  await git(root, ['read-tree', target.tree])
}

function undoState(root) {
  const s = stackOf(root)
  return { undo: s.undo.length ? s.undo[s.undo.length - 1].label : null, redo: s.redo.length ? s.redo[s.redo.length - 1].label : null }
}

async function step(root, from, to, field) {
  const s = stackOf(root)
  const entry = s[from].pop()
  if (!entry) throw new GitError(from === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.')
  const cur = await snap(root)
  const expect = from === 'undo' ? entry.after : entry.before
  if (cur.tree === null || !same(cur, expect)) {
    s.undo.length = 0
    s.redo.length = 0
    throw new GitError('The repository changed outside this block since that action, so it was not undone.')
  }
  await restore(root, field === 'before' ? entry.before : entry.after)
  s[to].push(entry)
  return { label: entry.label, ...undoState(root) }
}

// ---------------------------------------------------------------------------------------------- watching

/** root -> { watchers, timers, kinds, ctx } */
const watches = new Map()

function startWatch(root, gitDir, ctx) {
  const known = watches.get(root)
  if (known) {
    known.ctx = ctx
    known.refs++
    return
  }
  const w = { watchers: [], timers: new Map(), kinds: new Set(), ctx, refs: 1 }
  const fire = (kind, delay) => {
    // Events caused by our own commands are already followed by a refresh from the caller.
    if (busy > 0 || Date.now() - lastDone < 300) return
    w.kinds.add(kind)
    if (w.timers.has(kind)) return
    w.timers.set(
      kind,
      setTimeout(() => {
        w.timers.delete(kind)
        const kinds = [...w.kinds]
        w.kinds.clear()
        try {
          w.ctx.emit('changed', { root, kinds })
        } catch {
          stopWatch(root) // the window is gone
        }
      }, delay),
    )
  }
  const watch = (target, opts, onEvent) => {
    try {
      const fsw = fs.watch(target, { persistent: false, ...opts }, onEvent)
      fsw.on('error', () => fsw.close())
      w.watchers.push(fsw)
    } catch {
      /* unwatchable (removed, no permission): the block still refreshes on demand */
    }
  }
  const gitFiles = new Set(['HEAD', 'index', 'packed-refs', 'MERGE_HEAD', 'ORIG_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'])
  watch(gitDir, {}, (_e, name) => {
    const n = name ? String(name) : ''
    if (gitFiles.has(n)) fire(n === 'index' ? 'index' : 'refs', 150)
    else if (n === 'refs' || n === 'rebase-merge' || n === 'rebase-apply') fire('refs', 150)
  })
  watch(path.join(gitDir, 'refs'), { recursive: true }, (_e, name) => {
    if (name && String(name).endsWith('.lock')) return
    fire('refs', 150)
  })
  watch(root, { recursive: true }, (_e, name) => {
    if (!name) return fire('worktree', 400)
    const parts = String(name).split(/[\\/]/)
    if (parts[0] === '.git' || parts.includes('node_modules') || parts.includes('.git')) return
    fire('worktree', 400)
  })
  watches.set(root, w)
}

function stopWatch(root) {
  const w = watches.get(root)
  if (!w) return
  for (const t of w.timers.values()) clearTimeout(t)
  for (const x of w.watchers) x.close()
  watches.delete(root)
}

// ---------------------------------------------------------------------------------------------- pager agent

/** Asks the running Pager (control pipe) to write text. { kind: 'ok', text } | { kind: 'none' } | { kind: 'error', error } */
function askPager(prompt, purpose) {
  const dir = process.env.PAGER_HOME || path.join(os.homedir(), '.pager')
  let token
  try {
    token = fs.readFileSync(path.join(dir, 'control.token'), 'utf8').trim()
  } catch {
    return Promise.resolve({ kind: 'none' })
  }
  const h = crypto.createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16)
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\pager-${h}` : path.join(os.tmpdir(), `pager-${h}.sock`)
  return new Promise((resolve) => {
    const socket = net.createConnection(address)
    let buf = ''
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(r)
    }
    const timer = setTimeout(() => finish({ kind: 'error', error: 'Pager did not answer within 60 s' }), 60_000)
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, type: 'ask', purpose, prompt })}\n`))
    socket.on('data', (d) => {
      buf += d.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      try {
        const reply = JSON.parse(buf.slice(0, nl))
        if (reply.ok && typeof reply.text === 'string' && reply.text.trim()) finish({ kind: 'ok', text: reply.text })
        // A Pager build without the `ask` request answers "bad request": the same as no Pager for this purpose.
        else if (reply.error === 'bad request') finish({ kind: 'none' })
        else finish({ kind: 'error', error: reply.error ? `Pager: ${reply.error}` : 'Pager returned no text' })
      } catch {
        finish({ kind: 'error', error: 'Pager sent an unreadable reply' })
      }
    })
    socket.on('error', (e) => finish(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? { kind: 'none' } : { kind: 'error', error: e.message }))
    socket.on('close', () => finish({ kind: 'error', error: 'Pager closed the connection' }))
  })
}

function splitMessage(text) {
  let t = text.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim()
  t = t.replace(/^(commit message|message)\s*:\s*/i, '')
  const lines = t.split('\n')
  const summary = (lines.shift() ?? '').replace(/^["'`]|["'`]$/g, '').trim()
  return { summary: summary.slice(0, 200), body: lines.join('\n').trim() }
}

const VERB = { A: 'Add', D: 'Remove', R: 'Rename', M: 'Update', C: 'Copy', T: 'Change' }
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?: /

/** A message from the staged file list alone: used when no agent can write one. */
function heuristicMessage(files, recentSubjects) {
  const conventional = recentSubjects.length >= 3 && recentSubjects.filter((s) => CONVENTIONAL.test(s)).length >= Math.ceil(recentSubjects.length / 2)
  const base = (f) => f.path.split('/').pop()
  let kind = 'chore'
  const all = (re) => files.every((f) => re.test(f.path))
  if (all(/\.(md|mdx|txt|rst)$/i) || all(/^docs?\//i)) kind = 'docs'
  else if (all(/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i)) kind = 'test'
  else if (files.some((f) => f.status === 'A') && files.every((f) => f.status === 'A')) kind = 'feat'
  else if (files.some((f) => /\.(c|h|cc|cpp|cs|go|java|js|jsx|mjs|cjs|py|rb|rs|ts|tsx)$/i.test(f.path))) kind = 'fix'
  const statuses = new Set(files.map((f) => f.status))
  const verb = statuses.size === 1 ? VERB[[...statuses][0]] ?? 'Update' : 'Update'
  let subject
  if (files.length === 1) subject = `${verb} ${base(files[0])}`
  else if (files.length === 2) subject = `${verb} ${base(files[0])} and ${base(files[1])}`
  else subject = `${verb} ${base(files[0])} and ${files.length - 1} other files`
  const summary = conventional ? `${kind}: ${subject[0].toLowerCase()}${subject.slice(1)}` : subject
  const body = files.length > 1 ? files.slice(0, 20).map((f) => `- ${f.path}${f.add || f.del ? ` (+${f.add} -${f.del})` : ''}`).join('\n') + (files.length > 20 ? `\n- and ${files.length - 20} more` : '') : ''
  return { summary: summary.slice(0, 72), body }
}

// ---------------------------------------------------------------------------------------------- methods

const summaryCache = new Map()

function fileName(p) {
  return p.split(/[\\/]/).pop()
}

const methods = {
  /** Resolves the repository for a folder. Never throws for "not a repository". */
  async open(args) {
    const cwd = typeof (args && args.cwd) === 'string' ? args.cwd.trim() : ''
    if (!cwd) return { ok: false, error: 'not a git repository', cwd: args && args.cwd }
    const info = await resolveRepo(cwd)
    if (!info) return { ok: false, error: 'not a git repository', cwd: args.cwd }
    const st = await git(info.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], { opId: args.opId })
    const { branch } = parseStatus(st.stdout)
    return { ok: true, root: info.root, gitDir: info.gitDir, name: fileName(info.root), branch: branch.head, detached: branch.head === null && branch.oid !== null, empty: branch.oid === null, head: branch.oid, upstream: branch.upstream, ahead: branch.ahead, behind: branch.behind }
  },

  async init(args) {
    if (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd)) throw new GitError('a folder path is required')
    await git(args.cwd, ['init'])
    rootCache.delete(args.cwd)
    return methods.open({ cwd: args.cwd })
  },

  /** Cheap status for headers, the sidebar footer and prompt bars. null when `cwd` is not in a repository. */
  async summary(args) {
    let info
    try {
      info = await resolveRepo(args && args.cwd)
    } catch {
      return null
    }
    if (!info) return null
    const hit = summaryCache.get(info.root)
    if (hit && Date.now() - hit.at < 600) return hit.value
    const value = (async () => {
      const r = await run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], { cwd: info.root, cap: 2 << 20 })
      if (r.code !== 0) return null
      const { branch, files } = parseStatus(r.stdout)
      return { root: info.root, branch: branch.head, detached: branch.head === null && branch.oid !== null, head: branch.oid, upstream: branch.upstream, ahead: branch.ahead, behind: branch.behind, ...countStatus(files) }
    })()
    summaryCache.set(info.root, { at: Date.now(), value })
    value.catch(() => summaryCache.delete(info.root))
    return value
  },

  async status(args) {
    const { root, gitDir } = await needRepo(args)
    const r = await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { opId: args.opId, cap: CAP_TEXT })
    const { branch, files } = parseStatus(r.stdout)
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { root, branch, files, ...countStatus(files), truncated: r.truncated, undo: undoState(root), operation: operationState(gitDir) }
  },

  async refs(args) {
    const { root } = await needRepo(args)
    const fmt = ['%(refname)', '%(objectname)', '%(*objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(HEAD)', '%(creatordate:unix)'].join('%09')
    const [fe, rem] = await Promise.all([
      git(root, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags', 'refs/stash'], { opId: args.opId }),
      git(root, ['remote', '-v']),
    ])
    const branches = []
    const remotes = []
    const tags = []
    let hasStash = false
    for (const line of fe.stdout.split('\n')) {
      if (!line) continue
      const [ref, oid, peeled, upstream, track, headMark, date] = line.split('\t')
      if (ref === 'refs/stash') hasStash = true
      else if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice(11), hash: oid, upstream: upstream || null, ...parseTrack(track || ''), current: headMark === '*', date: +date || 0 })
      else if (ref.startsWith('refs/remotes/')) {
        const name = ref.slice(13)
        if (!name.endsWith('/HEAD')) remotes.push({ name, hash: oid, date: +date || 0 })
      } else if (ref.startsWith('refs/tags/')) tags.push({ name: ref.slice(10), hash: peeled || oid, annotated: !!peeled, date: +date || 0 })
    }
    let stashes = []
    if (hasStash) {
      const s = await git(root, ['stash', 'list', '--format=%gd%x1f%H%x1f%s%x1f%ct'])
      stashes = s.stdout.split('\n').filter(Boolean).map((l) => {
        const [ref, hash, message, date] = l.split('\x1f')
        return { ref, hash, message, date: +date || 0 }
      })
    }
    const remoteInfo = []
    for (const line of rem.stdout.split('\n')) {
      const m = /^(\S+)\t(.*) \((fetch|push)\)$/.exec(line)
      if (m && m[3] === 'fetch') remoteInfo.push({ name: m[1], url: m[2] })
    }
    return { branches, remotes, tags, stashes, remoteNames: remoteInfo.map((r) => r.name), remoteInfo }
  },

  async log(args) {
    const { root } = await needRepo(args)
    const limit = Math.min(Math.max(+args.limit || 300, 1), 20000)
    const skip = Math.max(+args.skip || 0, 0)
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f')
    const r = await run(['log', '--topo-order', '--exclude=refs/stash', '--all', '-z', `--format=${fmt}`, `--max-count=${limit}`, ...(skip ? [`--skip=${skip}`] : [])], { cwd: root, cap: CAP_LOG, opId: args.opId })
    if (r.code !== 0) {
      if (/does not have any commits|unknown revision|bad default revision/i.test(r.stderr)) return { commits: [], hasMore: false, empty: true }
      throw new GitError(errText(r, ['log']))
    }
    const commits = []
    for (const rec of r.stdout.split('\0')) {
      if (!rec) continue
      const f = rec.split('\x1f')
      if (f.length < 7) continue
      commits.push({ hash: f[0], parents: f[1] ? f[1].split(' ') : [], author: f[2], email: f[3], time: +f[4], refs: f[5], subject: f.slice(6).join('\x1f') })
    }
    return { commits, hasMore: commits.length === limit && !r.truncated, truncated: r.truncated }
  },

  /** Full message + changed files of one commit (against its first parent). */
  async commit(args) {
    const { root } = await needRepo(args)
    const hash = hex(args.hash)
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%B'].join('%x1f')
    const head = await git(root, ['show', '-s', `--format=${fmt}`, hash], { opId: args.opId })
    const f = head.stdout.replace(/\n$/, '').split('\x1f')
    const parents = f[1] ? f[1].split(' ') : []
    const base = parents.length ? [parents[0], hash] : ['--root', hash]
    const [ns, num] = await Promise.all([
      git(root, ['diff-tree', '-r', '-M', '-z', '--no-commit-id', '--name-status', ...base], { opId: args.opId, cap: CAP_TEXT }),
      git(root, ['diff-tree', '-r', '-M', '-z', '--no-commit-id', '--numstat', ...base], { opId: args.opId, cap: CAP_TEXT }),
    ])
    const stats = parseNumstatZ(num.stdout)
    const files = parseNameStatusZ(ns.stdout).map((x) => ({ ...x, ...(stats.get(x.path) ?? { add: 0, del: 0, binary: false }) }))
    return { hash: f[0], parents, author: f[2], email: f[3], time: +f[4], committer: f[5], committerEmail: f[6], committerTime: +f[7], refs: f[8], message: (f[9] ?? '').trim(), files, truncated: ns.truncated }
  },

  /**
   * One file's unified diff.
   *   working tree: { path, staged?: boolean, untracked?: boolean }
   *   commit:       { hash, parent?: string, path, oldPath? }
   */
  async diff(args) {
    const { root } = await needRepo(args)
    const ctxLines = Math.min(Math.max(Number.isInteger(args.context) ? args.context : 3, 0), 50)
    const ws = args.ignoreWhitespace ? ['-w'] : []
    const [p] = cleanPaths([args.path])
    let r
    if (args.hash) {
      const hash = hex(args.hash)
      const paths = args.oldPath ? cleanPaths([args.oldPath, args.path]) : [p]
      r = args.parent
        ? await git(root, ['diff', '-M', `-U${ctxLines}`, ...ws, hex(args.parent), hash, '--', ...paths], { cap: CAP_DIFF, opId: args.opId })
        : await git(root, ['diff-tree', '-p', '--root', '-M', `-U${ctxLines}`, ...ws, hash, '--', ...paths], { cap: CAP_DIFF, opId: args.opId })
    } else if (args.untracked) {
      let size = 0
      try {
        size = fs.statSync(path.join(root, p)).size
      } catch {
        throw new GitError(`${p} no longer exists`)
      }
      if (size > CAP_DIFF) return { text: '', truncated: true, tooLarge: true, size }
      r = await git(root, ['diff', '--no-index', `-U${ctxLines}`, ...ws, '--', '/dev/null', p], { ok: [0, 1], cap: CAP_DIFF, opId: args.opId })
    } else {
      r = await git(root, ['diff', ...(args.staged ? ['--cached'] : []), '--no-renames', `-U${ctxLines}`, ...ws, '--', p], { cap: CAP_DIFF, opId: args.opId })
    }
    return { text: r.stdout, truncated: r.truncated }
  },

  async stage(args) {
    const { root } = await needRepo(args)
    const paths = args.all ? null : cleanPaths(args.paths)
    await mutate(root, paths ? `Stage ${paths.length === 1 ? fileName(paths[0]) : `${paths.length} files`}` : 'Stage all', async () => {
      if (!paths) await git(root, ['add', '-A'])
      else await chunked(paths, (c) => git(root, ['add', '--', ...c]))
    })
    return { undo: undoState(root) }
  },

  async unstage(args) {
    const { root } = await needRepo(args)
    const paths = args.all ? null : cleanPaths(args.paths)
    const unborn = !(await git(root, ['rev-parse', '-q', '--verify', 'HEAD'], { ok: [0, 1] })).stdout.trim()
    await mutate(root, paths ? `Unstage ${paths.length === 1 ? fileName(paths[0]) : `${paths.length} files`}` : 'Unstage all', async () => {
      if (!paths) await git(root, unborn ? ['rm', '-r', '--cached', '-q', '--', '.'] : ['reset', '-q'])
      else await chunked(paths, (c) => git(root, unborn ? ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', ...c] : ['restore', '--staged', '--', ...c]))
    })
    return { undo: undoState(root) }
  },

  /** Throws away working-tree changes. `paths` are tracked files, `untracked` are files git does not know. */
  async discard(args) {
    const { root } = await needRepo(args)
    const tracked = args.paths && args.paths.length ? cleanPaths(args.paths) : []
    const untracked = args.untracked && args.untracked.length ? cleanPaths(args.untracked) : []
    if (!tracked.length && !untracked.length) throw new GitError('no paths given')
    if (tracked.length) await chunked(tracked, (c) => git(root, ['restore', '--', ...c]))
    if (untracked.length) await chunked(untracked, (c) => git(root, ['clean', '-f', '-q', '--', ...c]))
    return { undo: undoState(root) }
  },

  /** Applies a patch built by the renderer to the index: `git apply --cached --recount [-R]`. */
  async applyPatch(args) {
    const { root } = await needRepo(args)
    if (typeof args.patch !== 'string' || !args.patch.trim()) throw new GitError('the patch is empty')
    if (args.patch.length > CAP_DIFF) throw new GitError('the patch is too large')
    await mutate(root, typeof args.label === 'string' && args.label ? args.label : args.reverse ? 'Unstage lines' : 'Stage lines', () =>
      git(root, ['apply', '--cached', '--recount', '--whitespace=nowarn', ...(args.reverse ? ['-R'] : []), '-'], { input: args.patch }),
    )
    return { undo: undoState(root) }
  },

  async commitCreate(args) {
    const { root } = await needRepo(args)
    const summary = String(args.summary ?? '').trim()
    const body = String(args.body ?? '').trim()
    const amend = !!args.amend
    const sign = args.signoff ? ['--signoff'] : []
    if (!summary && !amend) throw new GitError('Write a summary for the commit.')
    const message = body ? `${summary}\n\n${body}` : summary
    await mutate(root, amend ? 'Amend commit' : 'Commit', async () => {
      if (amend && !summary) await git(root, ['commit', '--amend', '--no-edit', ...sign], { timeout: 120_000 })
      else await git(root, ['commit', '-F', '-', ...sign, ...(amend ? ['--amend'] : [])], { input: message + '\n', timeout: 120_000 })
    })
    const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
    return { hash: head, undo: undoState(root) }
  },

  async undoState(args) {
    const { root } = await needRepo(args)
    return undoState(root)
  },
  async undo(args) {
    const { root } = await needRepo(args)
    return step(root, 'undo', 'redo', 'before')
  },
  async redo(args) {
    const { root } = await needRepo(args)
    return step(root, 'redo', 'undo', 'after')
  },

  /** Staged diff + a message for it: from the running Pager's agent when it answers, else a heuristic summary. */
  async generateMessage(args) {
    const { root } = await needRepo(args)
    const [ns, num, diff, recent] = await Promise.all([
      git(root, ['diff', '--cached', '--no-renames', '-z', '--name-status']),
      git(root, ['diff', '--cached', '--no-renames', '-z', '--numstat']),
      git(root, ['diff', '--cached', '--no-renames', '-U2'], { cap: 2 << 20 }),
      run(['log', '-n', '12', '--format=%s'], { cwd: root }),
    ])
    const stats = parseNumstatZ(num.stdout)
    const files = parseNameStatusZ(ns.stdout).map((x) => ({ ...x, ...(stats.get(x.path) ?? { add: 0, del: 0 }) }))
    if (!files.length) throw new GitError('Nothing is staged, so there is nothing to describe.')
    const recentSubjects = recent.code === 0 ? recent.stdout.split('\n').filter(Boolean) : []
    let text = diff.stdout
    let clipped = diff.truncated
    if (text.length > 48_000) {
      text = text.slice(0, text.lastIndexOf('\n', 48_000))
      clipped = true
    }
    const prompt = [
      'Write a git commit message for the staged changes below.',
      'First line: an imperative summary of at most 72 characters. Then, only if useful, a blank line and a short body that says why.',
      'Match the style of the recent subjects. Reply with the message only: no quotes, no code fences, no preamble.',
      '',
      'Recent subjects:',
      ...recentSubjects.map((s) => `- ${s}`),
      '',
      `Staged files: ${files.map((f) => `${f.status} ${f.path}`).join(', ')}`,
      '',
      'Diff' + (clipped ? ' (truncated)' : '') + ':',
      text,
    ].join('\n')
    const asked = await askPager(prompt, 'commit-message')
    if (asked.kind === 'ok') {
      const m = splitMessage(asked.text)
      if (m.summary) return { ...m, diff: text, truncated: clipped, files, source: 'pager' }
    }
    const note =
      asked.kind === 'none'
        ? 'Pager is not running here, so the message comes from the file list.'
        : asked.kind === 'error'
          ? `${asked.error}; the message comes from the file list.`
          : 'Pager returned an empty message; the message comes from the file list.'
    return { ...heuristicMessage(files, recentSubjects), diff: text, truncated: clipped, files, source: 'heuristic', note }
  },

  async checkout(args) {
    const { root } = await needRepo(args)
    const ref = refName(args.ref)
    if (args.track) await git(root, ['checkout', '--track', ref], { timeout: 60_000 })
    else await git(root, ['checkout', ref, '--'], { timeout: 60_000 })
    return { ok: true }
  },
  async createBranch(args) {
    const { root } = await needRepo(args)
    const name = refName(args.name)
    await git(root, ['check-ref-format', '--branch', name])
    const from = args.from ? [refName(args.from)] : []
    // `checkout: false` only creates the branch (the branches panel); the default also switches to it.
    if (args.checkout === false) await git(root, ['branch', '--', name, ...from])
    else await git(root, ['checkout', '-b', name, ...from])
    return { ok: true }
  },
  async renameBranch(args) {
    const { root } = await needRepo(args)
    const to = refName(args.to)
    await git(root, ['check-ref-format', '--branch', to])
    await git(root, ['branch', '-m', '--', refName(args.name), to])
    return { ok: true }
  },
  /** Deletes a branch on its remote: `git push <remote> --delete <branch>`. */
  async deleteRemoteBranch(args) {
    const { root } = await needRepo(args)
    const full = refName(args.name)
    const remotes = (await git(root, ['remote'])).stdout.split('\n').filter(Boolean)
    const remote = remotes.find((r) => full.startsWith(`${r}/`))
    if (!remote) throw new GitError(`${full} does not belong to a known remote`)
    const r = await git(root, ['push', remote, '--delete', '--', full.slice(remote.length + 1)], { timeout: TIMEOUT_NET, opId: args.opId })
    return { output: (r.stderr || r.stdout).trim() }
  },
  async deleteBranch(args) {
    const { root } = await needRepo(args)
    await git(root, ['branch', args.force ? '-D' : '-d', '--', refName(args.name)])
    return { ok: true }
  },
  async createTag(args) {
    const { root } = await needRepo(args)
    await git(root, ['tag', '--', refName(args.name), ...(args.hash ? [hex(args.hash)] : [])])
    return { ok: true }
  },
  async deleteTag(args) {
    const { root } = await needRepo(args)
    await git(root, ['tag', '-d', '--', refName(args.name)])
    return { ok: true }
  },

  async fetch(args) {
    const { root } = await needRepo(args)
    const r = await git(root, ['fetch', '--all', '--prune'], { timeout: TIMEOUT_NET, opId: args.opId })
    return { output: (r.stderr || r.stdout).trim() }
  },
  async pull(args) {
    const { root } = await needRepo(args)
    const r = await git(root, ['pull', '--ff-only'], { timeout: TIMEOUT_NET, opId: args.opId })
    return { output: (r.stdout || r.stderr).trim() }
  },
  async push(args) {
    const { root } = await needRepo(args)
    const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { ok: [0, 128] })
    let cmd = ['push']
    if (up.code !== 0) {
      const branch = (await git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: [0, 1] })).stdout.trim()
      const remotes = (await git(root, ['remote'])).stdout.split('\n').filter(Boolean)
      if (!branch) throw new GitError('HEAD is detached; check out a branch to push.')
      if (!remotes.length) throw new GitError('This repository has no remote to push to.')
      cmd = ['push', '--set-upstream', remotes.includes('origin') ? 'origin' : remotes[0], branch]
    }
    const r = await git(root, cmd, { timeout: TIMEOUT_NET, opId: args.opId })
    return { output: (r.stderr || r.stdout).trim() }
  },
  async stashPush(args) {
    const { root } = await needRepo(args)
    // git stash drives other git commands with pathspecs of its own; literal-pathspec mode makes its clean step skip files.
    const r = await git(root, ['stash', 'push', '--include-untracked', ...(args.message ? ['-m', String(args.message)] : [])], { env: { GIT_LITERAL_PATHSPECS: '0' } })
    return { output: r.stdout.trim() }
  },
  async stashPop(args) {
    const { root } = await needRepo(args)
    const r = await git(root, ['stash', 'pop', ...(args.ref ? [refName(args.ref)] : [])], { env: { GIT_LITERAL_PATHSPECS: '0' } })
    return { output: r.stdout.trim() }
  },
  async stashApply(args) {
    const { root } = await needRepo(args)
    const r = await git(root, ['stash', 'apply', ...(args.ref ? [refName(args.ref)] : [])], { env: { GIT_LITERAL_PATHSPECS: '0' } })
    return { output: r.stdout.trim() }
  },
  async stashDrop(args) {
    const { root } = await needRepo(args)
    const r = await git(root, ['stash', 'drop', refName(args.ref)])
    return { output: r.stdout.trim() }
  },

  /** `git merge`. A merge that stops on conflicts is a result (`conflicts: true`), not an error. */
  async merge(args) {
    const { root, gitDir } = await needRepo(args)
    const ref = refName(args.ref)
    const mode = args.mode === 'noff' ? ['--no-ff', '--no-edit'] : args.mode === 'ffonly' ? ['--ff-only'] : args.mode === 'squash' ? ['--squash'] : ['--no-edit']
    const r = await run(['merge', ...mode, ref], { cwd: root, timeout: 120_000 })
    forgetUndo(root) // a merge moves the work tree too; the index/HEAD-only undo cannot reverse it
    const output = (r.stdout || r.stderr).trim()
    if (r.code === 0) return { output, conflicts: false }
    if (operationState(gitDir) || /CONFLICT/.test(r.stdout)) return { output, conflicts: true }
    throw new GitError(errText(r, ['merge']))
  },

  /** Continues, aborts or skips the merge/rebase/cherry-pick/revert the repository is in the middle of. */
  async operation(args) {
    const { root, gitDir } = await needRepo(args)
    const op = operationState(gitDir)
    if (!op) throw new GitError('Nothing is in progress.')
    const action = args.action
    if (action !== 'continue' && action !== 'abort' && action !== 'skip') throw new GitError('unknown action')
    if (op.kind === 'merge' && action === 'skip') throw new GitError('A merge cannot be skipped.')
    const cmd = op.kind === 'merge' ? (action === 'abort' ? ['merge', '--abort'] : ['commit', '--no-edit']) : [op.kind, `--${action}`]
    const r = await run(cmd, { cwd: root, timeout: 120_000 })
    forgetUndo(root)
    const output = (r.stdout || r.stderr).trim()
    if (r.code === 0) return { output, conflicts: false, operation: operationState(gitDir) }
    if (action !== 'abort' && /CONFLICT/.test(r.stdout)) return { output, conflicts: true, operation: operationState(gitDir) }
    throw new GitError(errText(r, cmd))
  },

  /** Settles a conflicted file with one side of the merge (`ours` = the current branch) and stages it. */
  async resolve(args) {
    const { root } = await needRepo(args)
    const [p] = cleanPaths([args.path])
    if (args.side !== 'ours' && args.side !== 'theirs') throw new GitError('choose ours or theirs')
    await git(root, ['checkout', `--${args.side}`, '--', p])
    await git(root, ['add', '--', p])
    return { ok: true }
  },

  /** `git clone <url>` into `<dir>/<name>`; the folder must not exist or be empty. */
  async clone(args) {
    const url = String(args.url ?? '').trim()
    if (!url || url.startsWith('-') || /[\0\r\n]/.test(url)) throw new GitError('Enter a repository URL.')
    if (typeof args.dir !== 'string' || !path.isAbsolute(args.dir)) throw new GitError('a parent folder is required')
    const base = url.replace(/[\\/]+$/, '').replace(/\.git$/i, '').split(/[\\/:]/).pop()
    const name = String(args.name || base || '').trim()
    if (!name || /[\\/\0]/.test(name) || name === '.' || name === '..') throw new GitError('Could not work out a folder name for the clone.')
    const target = path.join(args.dir, name)
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new GitError(`${target} already exists and is not empty.`)
    fs.mkdirSync(args.dir, { recursive: true })
    await git(args.dir, ['clone', '--', url, target], { timeout: TIMEOUT_NET * 4, opId: args.opId })
    return { path: target }
  },

  /** Native folder picker (desktop only). `{ path: null }` when cancelled. */
  async pickFolder(args, ctx) {
    let e
    try {
      e = require('electron')
    } catch {
      e = null
    }
    if (!e || !e.dialog) throw new GitError('Not available outside the desktop app')
    const win = (ctx && ctx.window) || (e.BrowserWindow && e.BrowserWindow.getFocusedWindow())
    const opts = { title: String(args.title || 'Open a folder'), properties: ['openDirectory', ...(args.create ? ['createDirectory'] : [])], defaultPath: typeof args.defaultPath === 'string' && args.defaultPath ? args.defaultPath : undefined }
    const r = win ? await e.dialog.showOpenDialog(win, opts) : await e.dialog.showOpenDialog(opts)
    return { path: r.canceled || !r.filePaths[0] ? null : r.filePaths[0] }
  },

  /** Starts pushing `changed` events ({ root, kinds }) for a repository. */
  async watch(args, ctx) {
    const info = await needRepo(args)
    startWatch(info.root, info.gitDir, ctx)
    return { ok: true, root: info.root }
  },
  async unwatch(args) {
    const info = await resolveRepo(args && (args.root ?? args.cwd))
    const w = info && watches.get(info.root)
    if (w && --w.refs <= 0) stopWatch(info.root)
    return { ok: true }
  },

  /** Cancels a running call by the opId it was started with. */
  async cancel(args) {
    const child = running.get(args && args.id)
    if (!child) return { ok: false }
    cancelled.add(args.id)
    child.kill()
    return { ok: true }
  },
}

function dispose() {
  for (const root of [...watches.keys()]) stopWatch(root)
  for (const [id, child] of running) {
    cancelled.add(id)
    child.kill()
  }
  rootCache.clear()
  summaryCache.clear()
  stacks.clear()
}

module.exports = {
  methods,
  dispose,
  // exported for the harness and tests
  _internals: { parseStatus, parseNameStatusZ, parseNumstatZ, parseTrack, heuristicMessage, splitMessage, cleanPaths },
}
