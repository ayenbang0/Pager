'use strict'
// Main-process handler of the Database block. One child process of the bundled node (ctx.node) per block session (`sid`,
// chosen by the renderer) runs database-engine.mjs through database-worker.mjs; this file only routes requests, owns the
// file dialogs and finds database files for the empty state. See database.test.mjs.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const WORKER = path.join(__dirname, 'database-worker.mjs')
const FILTERS = [
  { name: 'SQLite database files', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
  { name: 'All files', extensions: ['*'] },
]
const DB_EXT = /\.(db|sqlite|sqlite3|db3)$/i
const FORWARD = ['status', 'setMode', 'commit', 'revert', 'schema', 'browse', 'cell', 'update', 'insert', 'deleteRows', 'execute', 'pragmas', 'setPragma', 'check']

/** @type {Map<string, Session>} */
const sessions = new Map()

class Session {
  constructor(sid, ctx) {
    this.sid = sid
    this.ctx = ctx
    this.seq = 0
    this.pending = new Map()
    this.stderr = ''
    this.dead = false
    const node = (ctx && ctx.node) || process.env.PAGER_NODE || process.execPath
    this.child = spawn(node, [WORKER], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
    })
    this.ready = new Promise((resolve, reject) => {
      this.onReady = resolve
      this.onFail = reject
    })
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000) })
    this.child.on('message', (m) => this.message(m))
    this.child.on('error', (e) => this.exit(`Could not start the database engine: ${e.message}`))
    this.child.on('exit', (code) => this.exit(`The database engine stopped${code ? ` (exit ${code})` : ''}.${this.stderr ? ' ' + this.stderr.trim().split('\n').pop() : ''}`))
  }

  message(m) {
    if (m && m.ready) return this.onReady()
    const p = m && this.pending.get(m.id)
    if (!p) return
    this.pending.delete(m.id)
    if (m.ok) p.resolve(m.result)
    else p.reject(Object.assign(new Error(m.error.message), { code: m.error.code, errcode: m.error.errcode }))
  }

  exit(reason) {
    if (this.dead) return
    this.dead = true
    if (sessions.get(this.sid) === this) sessions.delete(this.sid)
    const err = Object.assign(new Error(reason), { code: 'WORKER_EXIT' })
    this.onFail(err)
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
    try { this.ctx.emit('closed', { sid: this.sid, reason }) } catch { /* the window is gone */ }
  }

  async call(method, args) {
    await this.ready
    if (this.dead) throw Object.assign(new Error('The database engine is not running.'), { code: 'WORKER_EXIT' })
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.send({ id, method, args }, (e) => {
        if (e) {
          this.pending.delete(id)
          reject(e)
        }
      })
    })
  }

  kill() {
    this.dead = true
    if (sessions.get(this.sid) === this) sessions.delete(this.sid)
    const err = Object.assign(new Error('Stopped.'), { code: 'INTERRUPTED' })
    this.onFail(err)
    this.ready.catch(() => {})
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
    try { this.child.kill() } catch { /* already gone */ }
  }
}

function need(a) {
  if (!a || typeof a.sid !== 'string' || !a.sid) throw new Error('A block session id (sid) is required.')
  return a.sid
}

function session(a, ctx, create) {
  const sid = need(a)
  let s = sessions.get(sid)
  if (!s) {
    if (!create) throw Object.assign(new Error('No database is open.'), { code: 'NOT_OPEN' })
    s = new Session(sid, ctx || {})
    sessions.set(sid, s)
  }
  return s
}

function electron() {
  try {
    const e = require('electron')
    return e && typeof e === 'object' && e.dialog ? e : null
  } catch { return null }
}

function dialogs(ctx) {
  if (ctx && ctx.dialog) return { dialog: ctx.dialog, window: undefined }
  const e = electron()
  if (!e) throw new Error('Not available outside the desktop app')
  return { dialog: e.dialog, window: e.BrowserWindow ? e.BrowserWindow.getFocusedWindow() || undefined : undefined }
}

const expandHome = (p) => (p === '~' ? os.homedir() : p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

async function show(ctx, kind, options) {
  const { dialog, window } = dialogs(ctx)
  const r = await (window ? dialog[kind](window, options) : dialog[kind](options))
  return r
}

function csvName(name, format) {
  return String(name || 'results').replace(/[\\/:*?"<>|]+/g, '_') + '.' + format
}

const methods = {
  /** Open (or create) a database file in this session's worker. Read-only unless readOnly:false. */
  async open(a, ctx) {
    const s = session(a, ctx, true)
    return s.call('open', { path: a.path, readOnly: a.readOnly !== false, create: !!a.create })
  },

  async close(a) {
    const s = sessions.get(need(a))
    if (!s) return { open: false }
    try { await s.call('close', {}) } catch { /* the worker is going away anyway */ }
    s.kill()
    return { open: false }
  },

  /** Stop a long statement: the worker is killed (a pending transaction rolls back); the renderer reopens the file. */
  async interrupt(a) {
    const s = sessions.get(need(a))
    if (s) s.kill()
    return { stopped: !!s }
  },

  async pickOpen(a, ctx) {
    const r = await show(ctx, 'showOpenDialog', {
      title: 'Open SQLite database',
      defaultPath: a && a.defaultPath ? expandHome(a.defaultPath) : undefined,
      properties: ['openFile'],
      filters: FILTERS,
    })
    return { path: r.canceled || !r.filePaths[0] ? null : r.filePaths[0] }
  },

  async pickNew(a, ctx) {
    const r = await show(ctx, 'showSaveDialog', {
      title: 'New SQLite database',
      defaultPath: a && a.defaultPath ? expandHome(a.defaultPath) : undefined,
      filters: FILTERS,
    })
    return { path: r.canceled || !r.filePath ? null : r.filePath }
  },

  /** Save the rows of a statement or a browsed table as CSV or JSON (streamed from SQLite, not from the grid). */
  async exportResults(a, ctx) {
    const s = session(a, ctx, false)
    const format = a.format === 'json' ? 'json' : 'csv'
    const r = await show(ctx, 'showSaveDialog', {
      title: `Save results as ${format.toUpperCase()}`,
      defaultPath: csvName(a.name, format),
      filters: [format === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'JSON', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }],
    })
    if (r.canceled || !r.filePath) return { path: null }
    if (a.table) return s.call('exportTable', { table: a.table, filters: a.filters, sort: a.sort, path: r.filePath, format })
    return s.call('exportQuery', { query: a.query, path: r.filePath, format })
  },

  /** Database files in `dir` and one level below (header-checked), newest first, for the empty state. */
  async scan(a) {
    const root = expandHome((a && a.dir) || os.homedir())
    const found = []
    const sniff = (file) => {
      let fd
      try {
        fd = fs.openSync(file, 'r')
        const b = Buffer.alloc(16)
        return fs.readSync(fd, b, 0, 16, 0) === 16 && b.toString('latin1') === 'SQLite format 3\0'
      } catch { return false } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch { /* ignore */ } }
    }
    const walk = (dir, depth) => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (found.length >= 60) return
        const full = path.join(dir, e.name)
        if (e.isFile() && DB_EXT.test(e.name) && sniff(full)) {
          try { const st = fs.statSync(full); found.push({ path: full, name: e.name, size: st.size, mtime: st.mtimeMs }) } catch { /* ignore */ }
        } else if (e.isDirectory() && depth < 1 && !e.name.startsWith('.') && e.name !== 'node_modules') walk(full, depth + 1)
      }
    }
    walk(root, 0)
    found.sort((x, y) => y.mtime - x.mtime)
    return { dir: root, files: found }
  },
}

for (const m of FORWARD) methods[m] = async (a, ctx) => session(a, ctx, false).call(m, a)

async function dispose() {
  for (const s of Array.from(sessions.values())) s.kill()
}

module.exports = { methods, dispose, _t: { sessions } }
