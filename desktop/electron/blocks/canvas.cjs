'use strict'
// Main-process handler of the Canvas block (a native whiteboard). It owns the document of record for every open canvas:
//   - persistence: `<dataDir>/canvases/<id>.canvas.json` (atomic temp file + rename, debounced 400 ms, flushed on dispose)
//     with images content-addressed under `<id>.blobs/<hash>.<ext>`; `ephemeral` mode keeps everything in memory (tests)
//   - conflicts: every document has a `seq`; a save based on an older seq is refused with the current document and the window
//     three-way merges; an edit made to the file behind our back (mtime changed) is merged in the same way
//   - agent hooks: read / shot / edit / history (contract in CANVAS.md). Edits are validated field by field and size-capped.
// The document model, validation and merge live in renderer/blocks/canvas-model.js (one copy, shared with the window).
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const MODEL_FILE = path.join(__dirname, '..', '..', 'renderer', 'blocks', 'canvas-model.js')
const MAX_FILE = 64 * 1024 * 1024
const MAX_BLOB = 25 * 1024 * 1024
const MAX_SHOT = 14 * 1024 * 1024
const SAVE_DELAY = 400
const SHOT_TIMEOUT = Number(process.env.PAGER_CANVAS_SHOT_TIMEOUT) || 10000
const EDIT_LOG = 200
const EDIT_LOG_FILE = 50
const EDIT_IDS = 200
const READ_BYTES = 2 * 1024 * 1024

// ---------------------------------------------------------------- the shared model (an ES module, loaded from source)

let modelP = null
/** Import the model with its relative imports inlined as data URLs: works from an asar, needs no package "type". */
function dataModule(file, seen = new Set()) {
  if (seen.has(file)) throw new Error(`import cycle at ${file}`)
  seen.add(file)
  let src = fs.readFileSync(file, 'utf8')
  src = src.replace(/(from\s+)'(\.\/[A-Za-z0-9_.-]+\.js)'/g, (_m, pre, spec) => `${pre}'${dataModule(path.join(path.dirname(file), spec), new Set(seen))}'`)
  return 'data:text/javascript;base64,' + Buffer.from(src).toString('base64')
}
const loadModel = () => (modelP ||= import(dataModule(MODEL_FILE)))

// ---------------------------------------------------------------- errors and args

class CanvasHandlerError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'CanvasError'
    this.code = code
  }
}
const fail = (message, code = 'BAD_ARGS') => {
  throw new CanvasHandlerError(message, code)
}
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

// ---------------------------------------------------------------- state

/** key -> entry. An entry is one open canvas. */
const docs = new Map()
let lastOpened = null
const shots = new Map() // request id -> { resolve, reject, timer }
let shotSeq = 0
let ctxRef = null

function envFlag(name) {
  const v = process.env[name]
  return v === '1' || v === 'true'
}

function baseDir(ctx) {
  const dataDir = (ctx && ctx.dataDir) || process.env.PAGER_HOME || path.join(os.homedir(), '.pager')
  return (ctx && ctx.canvasDir) || process.env.PAGER_CANVAS_DIR || path.join(dataDir, 'canvases')
}

const emitter = (ctx) => (ctx && typeof ctx.emit === 'function' ? ctx.emit.bind(ctx) : () => {})

// ---------------------------------------------------------------- disk

const FILE_SUFFIX = '.canvas.json'

function atomicWriteSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, data)
  let err
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (e) {
      err = e
      // Windows: a virus scanner or indexer may hold the target for a moment
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break
      const until = Date.now() + 15 * (i + 1)
      while (Date.now() < until) { /* brief spin: this is the sync path used by dispose */ }
    }
  }
  try { fs.unlinkSync(tmp) } catch { /* already gone */ }
  throw err
}

/** One shape per line keeps the file diffable and cheap to patch by hand. */
function serialize(e, M) {
  const d = e.doc
  const head = {
    v: M.VERSION, id: e.ref, name: d.name, seq: d.seq, updated: new Date().toISOString(), view: d.view, settings: d.settings,
    edits: e.edits.slice(-EDIT_LOG_FILE),
  }
  const h = JSON.stringify(head)
  return `${h.slice(0, -1)},"shapes":[\n${d.shapes.map((s) => JSON.stringify(s)).join(',\n')}\n]}\n`
}

function readDisk(e, M) {
  let st
  try {
    st = fs.statSync(e.file)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  if (st.size > MAX_FILE) fail(`${path.basename(e.file)} is larger than ${MAX_FILE >> 20} MiB`, 'TOO_BIG')
  const text = fs.readFileSync(e.file, 'utf8')
  const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  const doc = M.normalizeDoc(raw, { id: e.name })
  return { doc, edits: Array.isArray(raw.edits) ? raw.edits.filter((x) => x && typeof x === 'object').slice(-EDIT_LOG) : [], mtime: st.mtimeMs }
}

function writeNow(e, M) {
  clearTimeout(e.timer)
  e.timer = null
  if (e.ephemeral) {
    e.dirty = false
    return
  }
  syncFromDisk(e, M) // merge in anything written behind our back first
  atomicWriteSync(e.file, serialize(e, M))
  e.mtime = fs.statSync(e.file).mtimeMs
  e.base = e.doc.shapes
  e.dirty = false
}

function schedule(e) {
  e.dirty = true
  if (e.ephemeral) return
  clearTimeout(e.timer)
  e.timer = setTimeout(() => {
    e.timer = null
    loadModel().then((M) => {
      try {
        writeNow(e, M)
      } catch (err) {
        e.lastError = String((err && err.message) || err)
        emitter(ctxRef)('error', { id: e.ref, message: `Could not save ${path.basename(e.file)}: ${e.lastError}` })
      }
    })
  }, SAVE_DELAY)
  if (e.timer.unref) e.timer.unref()
}

/** If the file changed on disk since we last wrote/read it, fold the change into the document. */
function syncFromDisk(e, M) {
  if (e.ephemeral) return false
  let st
  try {
    st = fs.statSync(e.file)
  } catch {
    return false
  }
  if (e.mtime && Math.abs(st.mtimeMs - e.mtime) < 1) return false
  let disk
  try {
    disk = readDisk(e, M)
  } catch (err) {
    e.mtime = st.mtimeMs // unreadable (half-written by someone else): wait for the next change
    e.lastError = String((err && err.message) || err)
    return false
  }
  if (!disk) return false
  e.mtime = disk.mtime
  const merged = e.dirty ? M.mergeShapes(e.base, e.doc.shapes, disk.doc.shapes) : disk.doc.shapes
  const diff = M.diffIds(e.doc.shapes, merged)
  e.base = disk.doc.shapes
  const nameChanged = disk.doc.name !== e.doc.name && !e.dirty
  if (!diff.added.length && !diff.changed.length && !diff.removed.length && !nameChanged) return false
  e.doc = { ...e.doc, name: nameChanged ? disk.doc.name : e.doc.name, shapes: merged, seq: Math.max(e.doc.seq, disk.doc.seq) + 1 }
  logEdit(e, 'disk', 'File changed on disk', diff.added, diff.changed, diff.removed)
  if (merged !== disk.doc.shapes) e.dirty = true
  emitChanged(e, 'disk', 'File changed on disk', diff)
  return true
}

// ---------------------------------------------------------------- entries

const capIds = (ids) => (ids.length > EDIT_IDS ? ids.slice(0, EDIT_IDS) : ids)

function logEdit(e, source, label, created, changed, removed) {
  e.editN++
  e.edits.push({
    n: e.editN, seq: e.doc.seq, ts: new Date().toISOString(), source, label: String(label || '').slice(0, 120),
    created: capIds(created), changed: capIds(changed), removed: capIds(removed),
    ...(created.length > EDIT_IDS || changed.length > EDIT_IDS || removed.length > EDIT_IDS ? { truncated: true } : {}),
  })
  if (e.edits.length > EDIT_LOG) e.edits.splice(0, e.edits.length - EDIT_LOG)
}

/** Tell the windows the document changed. Big documents are announced without the shapes (windows fetch them with `open`). */
function emitChanged(e, source, label, diff) {
  let pts = 0
  for (const s of e.doc.shapes) if (s.pts) pts += s.pts.length
  const lean = e.doc.shapes.length > 800 || pts > 20000
  emitter(ctxRef)('changed', {
    id: e.ref, source, label, seq: e.doc.seq, name: e.doc.name,
    ids: { created: capIds(diff.added || diff.created || []), changed: capIds(diff.changed || []), removed: capIds(diff.removed || []) },
    ...(lean ? {} : { doc: { shapes: e.doc.shapes, name: e.doc.name, seq: e.doc.seq } }),
  })
}

function slug(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  return s || 'canvas'
}

function refForPath(p) {
  return 'p_' + crypto.createHash('sha1').update(process.platform === 'win32' ? p.toLowerCase() : p).digest('hex').slice(0, 12)
}

/** Which entry (key) do these args name? Does not load it. */
function locate(args, ctx, M) {
  const a = obj(args)
  if (typeof a.path === 'string' && a.path) {
    if (!path.isAbsolute(a.path)) fail('path must be absolute')
    const file = path.resolve(a.path)
    if (!/\.json$/i.test(file)) fail('a canvas file must end in .json (conventionally .canvas.json)')
    const ref = refForPath(file)
    return { ref, file, name: path.basename(file).replace(/\.canvas\.json$|\.json$/i, '') || 'canvas', blobDir: file.replace(/\.canvas\.json$|\.json$/i, '') + '.blobs', custom: true }
  }
  let id = a.id
  if (id === undefined || id === null || id === '') id = lastOpened || 'main'
  if (!M.isId(id)) fail('id must match [A-Za-z0-9_-]{1,40}')
  if (docs.has(id)) return { ref: id }
  const dir = baseDir(ctx)
  return { ref: id, file: path.join(dir, id + FILE_SUFFIX), name: id, blobDir: path.join(dir, id + '.blobs') }
}

/** Load (or return the already open) canvas. */
function load(args, ctx, M) {
  const loc = locate(args, ctx, M)
  let e = docs.get(loc.ref)
  if (e) {
    syncFromDisk(e, M)
    return e
  }
  const a = obj(args)
  const ephemeral = !!(a.ephemeral || (ctx && ctx.ephemeral) || envFlag('PAGER_CANVAS_EPHEMERAL'))
  e = {
    ref: loc.ref, file: loc.file, name: loc.name, blobDir: loc.blobDir, ephemeral, timer: null, dirty: false, mtime: 0,
    doc: null, base: [], edits: [], editN: 0, blobs: new Map(), recovered: false, lastError: null,
  }
  if (!ephemeral) {
    try {
      const disk = readDisk(e, M)
      if (disk) {
        e.doc = { ...disk.doc, id: loc.ref }
        e.base = disk.doc.shapes
        e.mtime = disk.mtime
        e.edits = disk.edits
        e.editN = disk.edits.reduce((n, x) => Math.max(n, Number(x.n) || 0), 0)
      }
    } catch (err) {
      if (err instanceof CanvasHandlerError) throw err
      // unreadable or corrupt: keep the bad file aside and start over, never overwrite it
      try {
        fs.renameSync(e.file, `${e.file}.corrupt-${Date.now()}`)
        e.recovered = true
      } catch { /* leave it */ }
    }
  }
  if (!e.doc) {
    e.doc = M.emptyDoc(loc.ref, typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, M.LIMITS.name) : loc.custom ? loc.name : 'Untitled canvas')
  } else if (typeof a.name === 'string' && a.name.trim() && !e.doc.shapes.length && e.doc.seq === 0) e.doc = { ...e.doc, name: a.name.trim().slice(0, M.LIMITS.name) }
  docs.set(e.ref, e)
  return e
}

const snapshot = (e, M) => ({
  id: e.ref,
  name: e.doc.name,
  seq: e.doc.seq,
  file: e.ephemeral ? null : e.file,
  ephemeral: e.ephemeral,
  recovered: e.recovered,
  doc: { v: M.VERSION, id: e.ref, name: e.doc.name, seq: e.doc.seq, view: e.doc.view, settings: e.doc.settings, shapes: e.doc.shapes, ...(e.doc.dropped ? { dropped: e.doc.dropped } : {}) },
})

// ---------------------------------------------------------------- blobs

const MAGIC = {
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8',
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
}
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const MIME_OF = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

function blobPath(e, hash, ext) {
  return path.join(e.blobDir, `${hash}.${ext}`)
}

function hasBlob(e, hash) {
  if (e.blobs.has(hash)) return true
  if (e.ephemeral) return false
  return Object.keys(MIME_OF).some((ext) => fs.existsSync(blobPath(e, hash, ext)))
}

// ---------------------------------------------------------------- summaries

function summarise(res) {
  const parts = []
  if (res.created.length) parts.push(`+${res.created.length}`)
  if (res.changed.length) parts.push(`~${res.changed.length}`)
  if (res.removed.length) parts.push(`-${res.removed.length}`)
  return parts.join(' ') || 'no change'
}

function bounds(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of shapes) {
    x0 = Math.min(x0, s.x)
    y0 = Math.min(y0, s.y)
    x1 = Math.max(x1, s.x + s.w)
    y1 = Math.max(y1, s.y + s.h)
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// ---------------------------------------------------------------- methods

const methods = {
  /** Open (creating when absent) a canvas: { id?, path?, name?, ephemeral? } -> { id, name, seq, doc, file, ephemeral }. */
  async open(args, ctx) {
    ctxRef = ctx || ctxRef
    const M = await loadModel()
    const e = load(args, ctx, M)
    lastOpened = e.ref
    return snapshot(e, M)
  },

  /**
   * The window's save: { id, baseSeq, doc: { shapes, view?, settings?, name? }, label? }.
   * -> { ok:true, seq } or, when someone else saved since baseSeq, { ok:false, conflict:true, seq, doc } to merge.
   */
  async save(args, ctx) {
    ctxRef = ctx || ctxRef
    const M = await loadModel()
    const a = obj(args)
    const e = load(a, ctx, M)
    if (!Number.isInteger(a.baseSeq) || a.baseSeq < 0) fail('baseSeq (integer) is required')
    const raw = obj(a.doc)
    if (!Array.isArray(raw.shapes)) fail('doc.shapes must be an array')
    if (raw.shapes.length > M.LIMITS.shapes) fail(`a canvas holds at most ${M.LIMITS.shapes} shapes`, 'TOO_BIG')
    if (a.baseSeq !== e.doc.seq) return { ok: false, conflict: true, ...snapshot(e, M) }
    const next = M.normalizeDoc({ ...raw, id: e.ref, seq: e.doc.seq }, { id: e.ref })
    if (M.countPts(next.shapes) > M.LIMITS.totalPts) fail(`a canvas holds at most ${M.LIMITS.totalPts} points`, 'TOO_BIG')
    const diff = M.diffIds(e.doc.shapes, next.shapes)
    const changed = diff.added.length || diff.changed.length || diff.removed.length
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, M.LIMITS.name) : e.doc.name
    e.doc = {
      ...e.doc, name, shapes: changed ? next.shapes : e.doc.shapes, view: next.view, settings: next.settings,
      seq: e.doc.seq + (changed ? 1 : 0),
    }
    if (changed) {
      const label = typeof a.label === 'string' && a.label ? a.label.slice(0, 120) : 'Edit'
      logEdit(e, 'user', label, diff.added, diff.changed, diff.removed)
      emitChanged(e, 'user', label, diff)
    }
    schedule(e)
    lastOpened = e.ref
    return { ok: true, seq: e.doc.seq, dropped: next.dropped || 0 }
  },

  /** Cheap: remember the pan/zoom and settings without touching the shapes. { id, view?, settings?, name? } */
  async saveView(args, ctx) {
    const M = await loadModel()
    const a = obj(args)
    const e = load(a, ctx, M)
    const probe = M.normalizeDoc({ view: a.view ?? e.doc.view, settings: a.settings ?? e.doc.settings, shapes: [] })
    e.doc = {
      ...e.doc, view: a.view ? probe.view : e.doc.view, settings: a.settings ? probe.settings : e.doc.settings,
      name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, M.LIMITS.name) : e.doc.name,
    }
    schedule(e)
    return { ok: true, seq: e.doc.seq }
  },

  /** Write pending changes now. { id? } (all open canvases when omitted) */
  async flush(args, ctx) {
    const M = await loadModel()
    const a = obj(args)
    const list = a.id || a.path ? [load(a, ctx, M)] : [...docs.values()]
    for (const e of list) if (e.dirty || e.timer) writeNow(e, M)
    return { ok: true }
  },

  /** Flush and forget a canvas (the pane closed). */
  async close(args, ctx) {
    const M = await loadModel()
    const loc = locate(args, ctx, M)
    const e = docs.get(loc.ref)
    if (!e) return { ok: true }
    if (e.dirty || e.timer) writeNow(e, M)
    clearTimeout(e.timer)
    if (!e.ephemeral) docs.delete(e.ref)
    return { ok: true }
  },

  /** The canvases on disk and open ones: [{ id, name, file, updated, bytes, open }] */
  async list(args, ctx) {
    const M = await loadModel()
    const dir = baseDir(ctx)
    const out = new Map()
    try {
      for (const f of await fsp.readdir(dir)) {
        if (!f.endsWith(FILE_SUFFIX)) continue
        const id = f.slice(0, -FILE_SUFFIX.length)
        if (!M.isId(id)) continue
        const file = path.join(dir, f)
        const st = await fsp.stat(file)
        let name = id
        const fd = await fsp.open(file, 'r')
        try {
          const buf = Buffer.alloc(1024)
          const { bytesRead } = await fd.read(buf, 0, 1024, 0)
          const m = /"name":("(?:[^"\\]|\\.)*")/.exec(buf.toString('utf8', 0, bytesRead))
          if (m) name = String(JSON.parse(m[1])) || id
        } catch { /* name stays the id */ } finally {
          await fd.close()
        }
        out.set(id, { id, name, file, updated: st.mtime.toISOString(), bytes: st.size, open: false })
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    for (const e of docs.values()) {
      const prev = out.get(e.ref)
      out.set(e.ref, { id: e.ref, name: e.doc.name, file: e.ephemeral ? null : e.file, updated: prev ? prev.updated : new Date().toISOString(), bytes: prev ? prev.bytes : 0, open: true })
    }
    return { dir, canvases: [...out.values()].sort((x, y) => (x.updated < y.updated ? 1 : -1)) }
  },

  /** New empty canvas: { name?, ephemeral? } -> like open. */
  async create(args, ctx) {
    ctxRef = ctx || ctxRef
    const M = await loadModel()
    const a = obj(args)
    const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, M.LIMITS.name) : 'Untitled canvas'
    let id
    do id = `${slug(name)}-${crypto.randomBytes(3).toString('hex')}`
    while (docs.has(id) || (!a.ephemeral && fs.existsSync(path.join(baseDir(ctx), id + FILE_SUFFIX))))
    const e = load({ id, name, ephemeral: a.ephemeral }, ctx, M)
    if (!e.ephemeral) writeNow(e, M)
    lastOpened = e.ref
    return snapshot(e, M)
  },

  async rename(args, ctx) {
    const M = await loadModel()
    const a = obj(args)
    if (typeof a.name !== 'string' || !a.name.trim()) fail('name is required')
    const e = load(a, ctx, M)
    e.doc = { ...e.doc, name: a.name.trim().slice(0, M.LIMITS.name) }
    schedule(e)
    return { ok: true, name: e.doc.name }
  },

  /** Move a canvas file to `.trash` next to it (never destroys data). */
  async remove(args, ctx) {
    const M = await loadModel()
    const loc = locate(args, ctx, M)
    const e = docs.get(loc.ref)
    if (e) {
      clearTimeout(e.timer)
      docs.delete(e.ref)
    }
    const file = (e && e.file) || loc.file
    if (file && !(e && e.ephemeral)) {
      const trash = path.join(path.dirname(file), '.trash')
      await fsp.mkdir(trash, { recursive: true })
      try {
        await fsp.rename(file, path.join(trash, `${path.basename(file)}.${Date.now()}`))
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
    if (lastOpened === loc.ref) lastOpened = null
    return { ok: true }
  },

  // ---- agent hooks (canvas_read / canvas_shot / canvas_edit / canvas_history)

  /**
   * canvas_read: the model JSON. { id?, ids?: [shape ids], pts?: boolean }
   * -> { id, name, seq, view, settings, count, bounds, shapes, truncated? }. Ink points are dropped (kept as a count) when the
   * reply would exceed ~2 MiB or when pts:false.
   */
  async read(args, ctx) {
    ctxRef = ctx || ctxRef
    const M = await loadModel()
    const a = obj(args)
    const e = load(a, ctx, M)
    if (e.dirty || e.timer) writeNow(e, M)
    let shapes = e.doc.shapes
    if (a.ids !== undefined) {
      if (!Array.isArray(a.ids) || a.ids.length > M.LIMITS.ids || !a.ids.every(M.isId)) fail('ids must be an array of shape ids')
      const want = new Set(a.ids)
      shapes = shapes.filter((s) => want.has(s.id))
    }
    const strip = (list) => list.map((s) => (s.type === 'ink' ? { ...s, pts: undefined, ptCount: s.pts.length } : s))
    let truncated = false
    if (a.pts === false) (shapes = strip(shapes)), (truncated = true)
    else if (JSON.stringify(shapes).length > READ_BYTES) (shapes = strip(shapes)), (truncated = true)
    return {
      id: e.ref, name: e.doc.name, seq: e.doc.seq, view: e.doc.view, settings: e.doc.settings, count: e.doc.shapes.length,
      bounds: bounds(e.doc.shapes), shapes, ...(truncated ? { truncated: true } : {}),
    }
  },

  /**
   * canvas_edit: { id?, ops: [...], label?, expectSeq? } (operations are documented in CANVAS.md).
   * Atomic: -> { ok:true, seq, created, changed, removed, results } or { ok:false, errors:[{index,error}], seq }.
   */
  async edit(args, ctx) {
    ctxRef = ctx || ctxRef
    const M = await loadModel()
    const a = obj(args)
    const e = load(a, ctx, M)
    if (a.expectSeq !== undefined && a.expectSeq !== e.doc.seq) {
      return { ok: false, conflict: true, seq: e.doc.seq, errors: [{ index: -1, error: `the canvas is at seq ${e.doc.seq}, not ${a.expectSeq}; read it again` }] }
    }
    const res = M.applyOps(e.doc.shapes, a.ops)
    if (!res.ok) return { ok: false, seq: e.doc.seq, errors: res.errors, results: res.results }
    for (const s of res.shapes) {
      if (s.type === 'image' && !hasBlob(e, s.hash)) {
        return { ok: false, seq: e.doc.seq, errors: [{ index: -1, error: `image ${s.id}: no stored image with hash ${s.hash}; upload it with putBlob first` }], results: res.results }
      }
    }
    const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 120) : `Agent: ${summarise(res)}`
    const diff = { added: res.created, changed: res.changed, removed: res.removed }
    if (res.created.length || res.changed.length || res.removed.length) {
      e.doc = { ...e.doc, shapes: res.shapes, seq: e.doc.seq + 1 }
      logEdit(e, 'agent', label, res.created, res.changed, res.removed)
      schedule(e)
      emitChanged(e, 'agent', label, diff)
    }
    lastOpened = e.ref
    return { ok: true, seq: e.doc.seq, created: res.created, changed: res.changed, removed: res.removed, results: res.results, count: e.doc.shapes.length }
  },

  /** canvas_history: { id?, limit? (1..200, default 20) } -> { id, seq, edits:[{n,seq,ts,source,label,created,changed,removed}] } oldest first. */
  async history(args, ctx) {
    const M = await loadModel()
    const a = obj(args)
    const e = load(a, ctx, M)
    let limit = 20
    if (a.limit !== undefined) {
      if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > EDIT_LOG) fail(`limit must be an integer 1..${EDIT_LOG}`)
      limit = a.limit
    }
    return { id: e.ref, seq: e.doc.seq, edits: e.edits.slice(-limit) }
  },

  /**
   * canvas_shot: a PNG of the canvas as the window shows it (the window renders it on request).
   * { id?, fit?: 'view'|'content', width?, height?, scale? } -> { id, mime, dataUrl, width, height }
   */
  async shot(args, ctx) {
    ctxRef = ctx || ctxRef
    const M = await loadModel()
    const a = obj(args)
    const e = load(a, ctx, M)
    const fit = a.fit === undefined ? 'view' : a.fit
    if (fit !== 'view' && fit !== 'content') fail("fit must be 'view' or 'content'")
    const dim = (v, name, lo, hi) => {
      if (v === undefined) return undefined
      if (!Number.isInteger(v) || v < lo || v > hi) fail(`${name} must be an integer ${lo}..${hi}`)
      return v
    }
    const width = dim(a.width, 'width', 64, 4096)
    const height = dim(a.height, 'height', 64, 4096)
    let scale = 1
    if (a.scale !== undefined) {
      if (typeof a.scale !== 'number' || !(a.scale >= 0.25 && a.scale <= 3)) fail('scale must be a number 0.25..3')
      scale = a.scale
    }
    if (e.dirty || e.timer) writeNow(e, M)
    const req = `shot${++shotSeq}`
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        shots.delete(req)
        reject(new CanvasHandlerError('the canvas is not open in a window (no reply to the screenshot request)', 'NOT_OPEN'))
      }, SHOT_TIMEOUT)
      if (timer.unref) timer.unref()
      shots.set(req, { resolve, reject, timer })
      emitter(ctx)('shot', { req, id: e.ref, fit, width, height, scale })
    })
    return { id: e.ref, ...reply }
  },

  /** The window's answer to a `shot` event: { req, dataUrl, width, height } or { req, error }. */
  async shotReply(args) {
    const a = obj(args)
    const p = shots.get(a.req)
    if (!p) return { ok: false }
    shots.delete(a.req)
    clearTimeout(p.timer)
    if (a.error) p.reject(new CanvasHandlerError(String(a.error).slice(0, 300), 'SHOT_FAILED'))
    else if (typeof a.dataUrl !== 'string' || !a.dataUrl.startsWith('data:image/png;base64,')) p.reject(new CanvasHandlerError('bad screenshot reply', 'SHOT_FAILED'))
    else if (a.dataUrl.length > MAX_SHOT) p.reject(new CanvasHandlerError('the screenshot is too large; ask for a smaller width/height/scale', 'TOO_BIG'))
    else p.resolve({ mime: 'image/png', dataUrl: a.dataUrl, width: Number(a.width) || 0, height: Number(a.height) || 0 })
    return { ok: true }
  },

  // ---- images

  /** Store an image by content hash: { id?, mime, data: base64 } -> { hash, mime, bytes }. Idempotent. */
  async putBlob(args, ctx) {
    const M = await loadModel()
    const a = obj(args)
    const e = load(a, ctx, M)
    if (!MAGIC[a.mime]) fail(`mime must be one of ${Object.keys(MAGIC).join(', ')}`)
    if (typeof a.data !== 'string' || a.data.length > Math.ceil((MAX_BLOB * 4) / 3) + 8) fail(`images are limited to ${MAX_BLOB >> 20} MiB`, 'TOO_BIG')
    const buf = Buffer.from(a.data, 'base64')
    if (!buf.length || buf.length > MAX_BLOB) fail(`images are limited to ${MAX_BLOB >> 20} MiB`, 'TOO_BIG')
    if (!MAGIC[a.mime](buf)) fail(`the data is not a ${a.mime} image`)
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)
    if (e.ephemeral) e.blobs.set(hash, { mime: a.mime, buf })
    else {
      const file = blobPath(e, hash, EXT[a.mime])
      if (!fs.existsSync(file)) atomicWriteSync(file, buf)
    }
    return { hash, mime: a.mime, bytes: buf.length }
  },

  /** { id?, hash } -> { mime, data: base64 } */
  async getBlob(args, ctx) {
    const M = await loadModel()
    const a = obj(args)
    const e = load(a, ctx, M)
    if (!M.isHash(a.hash)) fail('hash must be 32 hex digits')
    const mem = e.blobs.get(a.hash)
    if (mem) return { mime: mem.mime, data: mem.buf.toString('base64') }
    if (!e.ephemeral) {
      for (const ext of Object.keys(MIME_OF)) {
        try {
          const buf = await fsp.readFile(blobPath(e, a.hash, ext))
          return { mime: MIME_OF[ext], data: buf.toString('base64') }
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
        }
      }
    }
    fail(`no stored image ${a.hash}`, 'NOT_FOUND')
  },

  async status(_args, ctx) {
    return { dir: baseDir(ctx), open: [...docs.values()].map((e) => ({ id: e.ref, name: e.doc.name, seq: e.doc.seq, dirty: e.dirty, ephemeral: e.ephemeral, lastError: e.lastError })) }
  },
}

/** The window closed: flush everything synchronously, drop pending screenshot requests. */
function dispose() {
  for (const e of docs.values()) {
    clearTimeout(e.timer)
    e.timer = null
  }
  for (const p of shots.values()) {
    clearTimeout(p.timer)
    p.reject(new CanvasHandlerError('the window closed', 'NOT_OPEN'))
  }
  shots.clear()
  if (!modelP) return
  // `modelP` has resolved by now whenever there are open canvases; settle synchronously from the cache
  const M = loaded
  if (!M) return
  for (const e of docs.values()) {
    if (!e.dirty || e.ephemeral) continue
    try {
      writeNow(e, M)
    } catch { /* nothing more to do at exit */ }
  }
}

let loaded = null
loadModel().then((m) => { loaded = m }).catch(() => {})

module.exports = {
  methods,
  dispose,
  _t: {
    docs, loadModel, dataModule, writeNow, serialize, readDisk, syncFromDisk, baseDir, MODEL_FILE,
    reset() {
      for (const e of docs.values()) clearTimeout(e.timer)
      docs.clear()
      lastOpened = null
    },
  },
}
