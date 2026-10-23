'use strict'
// Main-process handler of the notebook block: .ipynb (nbformat 4) read/write that keeps every field it does not
// understand, Python discovery, and one `pager_kernel` child per block. The kernel speaks newline-delimited JSON over
// its stdin/stdout pipes (see tern_kernel/pager_kernel/protocol.py): no sockets, no listener, no IPython/ipykernel.
const { execFile, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')

const MAX_NOTEBOOK_BYTES = 256 << 20
const MIN_PYTHON = [3, 8]
const START_TIMEOUT = 25_000
const PROBE_TIMEOUT = 8_000
const FIND_TTL = 30_000
const STDERR_TAIL = 6000

const KERNEL_DIR = (() => {
  const dir = path.join(__dirname, 'tern_kernel')
  // Python cannot read inside an asar archive: the packer unpacks the kernel next to it.
  if (dir.includes('app.asar')) {
    const unpacked = dir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    if (fs.existsSync(unpacked)) return unpacked
  }
  return dir
})()

// ---------------------------------------------------------------------------------------------------------------
// nbformat 4

class NotebookFormatError extends Error {}

const TEXT_MIME = (mime) => mime.startsWith('text/') || mime === 'image/svg+xml' || mime === 'application/javascript'

function newCellId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8)
}

function newNotebook(version) {
  const info = { name: 'python' }
  if (version) info.version = version
  return {
    cells: [{ cell_type: 'code', execution_count: null, id: newCellId(), metadata: {}, outputs: [], source: [] }],
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: info },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

function isSortedKeys(obj) {
  const keys = Object.keys(obj)
  for (let i = 1; i < keys.length; i++) if (keys[i - 1] > keys[i]) return false
  return true
}

/** Parse .ipynb text -> { nb, format } where format remembers indent / key order / newline so a save changes only what was edited. */
function parseNotebook(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let nb
  try {
    nb = JSON.parse(text)
  } catch (err) {
    throw new NotebookFormatError(`not a valid notebook: ${err.message}`)
  }
  if (!nb || typeof nb !== 'object' || Array.isArray(nb)) throw new NotebookFormatError('not a notebook: the top level is not an object')
  if (typeof nb.nbformat !== 'number') throw new NotebookFormatError('not a notebook: nbformat is missing')
  if (nb.nbformat !== 4)
    throw new NotebookFormatError(`nbformat ${nb.nbformat} is not supported (this block reads nbformat 4; upgrade it with \`jupyter nbconvert --to notebook\`)`)
  if (!Array.isArray(nb.cells)) throw new NotebookFormatError('not a notebook: cells is missing')
  if (nb.cells.some((c) => !c || typeof c !== 'object' || typeof c.cell_type !== 'string')) throw new NotebookFormatError('a cell has no cell_type')
  const indentMatch = /^\{\r?\n([ \t]+)"/.exec(text)
  const format = {
    indent: indentMatch ? indentMatch[1] : ' ',
    sortKeys: isSortedKeys(nb) && nb.cells.every(isSortedKeys),
    eol: /\r\n/.test(text.slice(0, 4096)) ? '\r\n' : '\n',
    finalNewline: /\n$/.test(text),
  }
  return { nb, format }
}

function joinText(v) {
  return Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : ''
}

function splitLines(text) {
  if (!text) return []
  const lines = text.match(/[^\n]*\n|[^\n]+$/g)
  return lines || []
}

function lineList(v) {
  return Array.isArray(v) ? v : splitLines(typeof v === 'string' ? v : '')
}

function normalizeOutput(out) {
  if (!out || typeof out !== 'object') return out
  const next = { ...out }
  if (out.output_type === 'stream') next.text = lineList(out.text)
  if (out.data && typeof out.data === 'object') {
    next.data = { ...out.data }
    for (const mime of Object.keys(next.data)) if (TEXT_MIME(mime) && typeof next.data[mime] === 'string') next.data[mime] = splitLines(next.data[mime])
  }
  if (out.output_type === 'error' && !Array.isArray(out.traceback)) next.traceback = lineList(out.traceback)
  return next
}

/** The notebook as it is written: required cell fields present, text as line lists, ids on nbformat >= 4.5. Unknown fields untouched. */
function prepareForSave(nb) {
  const minor = typeof nb.nbformat_minor === 'number' ? nb.nbformat_minor : 0
  const seen = new Set()
  for (const c of nb.cells) if (typeof c.id === 'string') seen.add(c.id)
  const cells = nb.cells.map((cell) => {
    const next = { ...cell, source: lineList(cell.source), metadata: cell.metadata && typeof cell.metadata === 'object' ? cell.metadata : {} }
    if (cell.cell_type === 'code') {
      next.outputs = Array.isArray(cell.outputs) ? cell.outputs.map(normalizeOutput) : []
      if (!('execution_count' in next)) next.execution_count = null
    }
    if (minor >= 5 && typeof next.id !== 'string') {
      let id = newCellId()
      while (seen.has(id)) id = newCellId()
      seen.add(id)
      next.id = id
    }
    return next
  })
  return { ...nb, cells }
}

function stringify(value, fmt, depth) {
  if (value === undefined || value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  const pad = fmt.indent.repeat(depth + 1)
  const end = fmt.indent.repeat(depth)
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    return '[\n' + value.map((v) => pad + stringify(v, fmt, depth + 1)).join(',\n') + '\n' + end + ']'
  }
  let keys = Object.keys(value).filter((k) => value[k] !== undefined)
  if (!keys.length) return '{}'
  if (fmt.sortKeys) keys = keys.sort()
  return '{\n' + keys.map((k) => pad + JSON.stringify(k) + ': ' + stringify(value[k], fmt, depth + 1)).join(',\n') + '\n' + end + '}'
}

/** Jupyter's own on-disk shape: indent 1, sorted keys, UTF-8, newline at the end (unless the file we read said otherwise). */
function serializeNotebook(nb, format) {
  const fmt = { indent: ' ', sortKeys: true, eol: '\n', finalNewline: true, ...(format || {}) }
  let text = stringify(prepareForSave(nb), fmt, 0)
  if (fmt.finalNewline) text += '\n'
  return fmt.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

// ---------------------------------------------------------------------------------------------------------------
// Python discovery

const PROBE_CODE =
  'import sys,platform,json;print(json.dumps({"exe":sys.executable,"version":platform.python_version(),"info":list(sys.version_info[:3]),' +
  '"venv":sys.prefix!=getattr(sys,"base_prefix",sys.prefix),"prefix":sys.prefix,"impl":platform.python_implementation()}))'

function childEnv(extra) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...extra }
  delete env.PYTHONSTARTUP
  return env
}

/** Run `cmd args -c PROBE`; resolves the parsed info or null (not found, not Python, Microsoft Store stub, too old). */
function probe(cmd, args = [], timeout = PROBE_TIMEOUT) {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(cmd, [...args, '-c', PROBE_CODE], { timeout, windowsHide: true, encoding: 'utf8', env: childEnv() }, (err, stdout) => {
        if (err) return resolve(null)
        const line = String(stdout).trim().split(/\r?\n/).pop()
        try {
          const info = JSON.parse(line)
          if (!info || !Array.isArray(info.info) || !info.exe) return resolve(null)
          if (info.info[0] < MIN_PYTHON[0] || (info.info[0] === MIN_PYTHON[0] && info.info[1] < MIN_PYTHON[1])) return resolve(null)
          resolve(info)
        } catch {
          resolve(null)
        }
      })
    } catch {
      return resolve(null)
    }
    child.stdin && child.stdin.end()
  })
}

function venvPythons(cwd) {
  const out = []
  const exe = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  const add = (dir, source) => {
    const p = path.join(dir, ...exe)
    if (fs.existsSync(p)) out.push({ cmd: p, args: [], source })
  }
  let dir = cwd ? path.resolve(cwd) : ''
  for (let i = 0; dir && i < 8; i++) {
    for (const name of ['.venv', 'venv', 'env', '.env']) add(path.join(dir, name), 'virtual environment')
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  if (process.env.VIRTUAL_ENV) add(process.env.VIRTUAL_ENV, 'VIRTUAL_ENV')
  if (process.env.CONDA_PREFIX) {
    const p = process.platform === 'win32' ? path.join(process.env.CONDA_PREFIX, 'python.exe') : path.join(process.env.CONDA_PREFIX, 'bin', 'python')
    if (fs.existsSync(p)) out.push({ cmd: p, args: [], source: 'conda' })
  }
  return out
}

function defaultCommands(cwd) {
  const list = venvPythons(cwd)
  if (process.platform === 'win32') list.push({ cmd: 'py', args: ['-3'], source: 'py -3' }, { cmd: 'python', args: [], source: 'python' }, { cmd: 'python3', args: [], source: 'python3' })
  else list.push({ cmd: 'python3', args: [], source: 'python3' }, { cmd: 'python', args: [], source: 'python' })
  return list
}

function describe(info, source) {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  let detail = info.exe
  if (home && detail.toLowerCase().startsWith(home.toLowerCase())) detail = '~' + detail.slice(home.length)
  const env = info.venv ? ` · ${path.basename(info.prefix)}` : ''
  return { id: info.exe, exe: info.exe, version: info.version, impl: info.impl, venv: !!info.venv, label: `Python ${info.version}${env}`, detail, source }
}

const findCache = new Map()

/** Usable Pythons, best first: explicit path, the folder's virtual environment, py -3, python, python3. Deduplicated by executable. */
async function findPythons({ cwd, python, refresh, commands } = {}) {
  const key = `${cwd || ''}|${python || ''}`
  const hit = findCache.get(key)
  if (!commands && !refresh && hit && Date.now() - hit.at < FIND_TTL) return hit.list
  const cmds = commands || [...(python ? [{ cmd: python, args: [], source: 'settings' }] : []), ...defaultCommands(cwd)]
  const infos = await Promise.all(cmds.map((c) => probe(c.cmd, c.args)))
  const seen = new Set()
  const list = []
  infos.forEach((info, i) => {
    if (!info) return
    const id = process.platform === 'win32' ? info.exe.toLowerCase() : info.exe
    if (seen.has(id)) return
    seen.add(id)
    list.push(describe(info, cmds[i].source))
  })
  if (!commands) findCache.set(key, { at: Date.now(), list })
  return list
}

function noPythonMessage(wanted) {
  if (wanted) return `Python not found at "${wanted}", or it is older than ${MIN_PYTHON.join('.')}. Pick another interpreter in the kernel menu or Settings > Notebooks.`
  const how =
    process.platform === 'win32'
      ? 'Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH") or run `winget install Python.Python.3.13`. The Microsoft Store stub does not count.'
      : process.platform === 'darwin'
        ? 'Install it with `brew install python` or from https://www.python.org/downloads/.'
        : 'Install python3 with your package manager (for example `sudo apt install python3`).'
  return `No Python ${MIN_PYTHON.join('.')} or newer was found (tried the folder's virtual environment, py -3, python and python3). ${how} Then run the cell again, or set a path in Settings > Notebooks.`
}

// ---------------------------------------------------------------------------------------------------------------
// Kernel process

/** Splits a byte stream into complete lines; keeps a partial tail and decodes UTF-8 across chunk boundaries. */
class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine
    this.decoder = new StringDecoder('utf8')
    this.rest = ''
  }

  push(chunk) {
    this.rest += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let at
    while ((at = this.rest.indexOf('\n')) >= 0) {
      const line = this.rest.slice(0, at)
      this.rest = this.rest.slice(at + 1)
      if (line.trim()) this.onLine(line)
    }
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    try {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } catch {
      /* gone already */
    }
  }
  try {
    child.kill()
  } catch {
    /* gone already */
  }
}

class Kernel {
  constructor({ key, python, cwd, figureFormat, onEvent, spawnFn = spawn }) {
    this.key = key
    this.python = python
    this.cwd = cwd
    this.figureFormat = figureFormat || 'retina'
    this.onEvent = onEvent
    this.spawnFn = spawnFn
    this.alive = false
    this.expected = false
    this.info = null
    this.running = new Set()
    this.pending = new Map()
    this.seq = 0
    this.stderr = ''
    this.child = null
  }

  start() {
    return new Promise((resolve, reject) => {
      let ready = false
      const fail = (msg) => {
        if (ready) return
        ready = true
        clearTimeout(timer)
        killTree(this.child)
        reject(Object.assign(new Error(msg), { code: 'KERNEL_START' }))
      }
      const env = childEnv({
        PYTHONPATH: [KERNEL_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUNBUFFERED: '1',
        PAGER_KERNEL_CWD: this.cwd || '',
        PAGER_FIGURE_FORMAT: this.figureFormat,
      })
      delete env.MPLBACKEND
      let child
      try {
        child = this.spawnFn(this.python, ['-u', '-m', 'pager_kernel'], { cwd: this.cwd || undefined, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      } catch (err) {
        return reject(Object.assign(new Error(`cannot start ${this.python}: ${err.message}`), { code: 'KERNEL_START' }))
      }
      this.child = child
      const timer = setTimeout(() => fail('the kernel did not start within 25 seconds'), START_TIMEOUT)
      const lines = new LineSplitter((line) => {
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          this.noteStderr(line + '\n')
          return
        }
        if (!msg || typeof msg !== 'object') return
        if (msg.type === 'ready' && !ready) {
          ready = true
          clearTimeout(timer)
          this.alive = true
          this.info = msg.info
          resolve(msg.info)
          return
        }
        this.dispatch(msg)
      })
      child.stdout.on('data', (c) => lines.push(c))
      child.stderr.on('data', (c) => this.noteStderr(c.toString('utf8')))
      child.stdin.on('error', () => {})
      child.on('error', (err) => {
        this.noteStderr(String(err.message))
        fail(`cannot start ${this.python}: ${err.message}`)
      })
      child.on('exit', (code, signal) => {
        const was = this.alive
        this.alive = false
        for (const p of this.pending.values()) p.resolve(null)
        this.pending.clear()
        this.running.clear()
        if (!was) return fail(`the kernel exited before it was ready (${code === null ? signal : 'code ' + code})${this.stderrText()}`)
        this.onEvent({ type: 'exit', code, signal, expected: this.expected, stderr: this.expected ? '' : this.stderr.trim() })
      })
    })
  }

  noteStderr(text) {
    this.stderr = (this.stderr + text).slice(-STDERR_TAIL)
  }

  stderrText() {
    const t = this.stderr.trim()
    return t ? `:\n${t}` : ''
  }

  dispatch(msg) {
    if (msg.type === 'started' && msg.id !== undefined) this.running.add(msg.id)
    else if (msg.type === 'done') this.running.delete(msg.id)
    if (msg.id !== undefined && (msg.type === 'completions' || msg.type === 'inspection' || msg.type === 'variables' || msg.type === 'pong')) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        p.resolve(msg)
        return
      }
    }
    this.onEvent(msg)
  }

  sendRaw(text) {
    if (!this.child || !this.child.stdin.writable) return false
    this.child.stdin.write(text)
    return true
  }

  send(msg) {
    if (!this.child || !this.child.stdin.writable) return false
    this.child.stdin.write(JSON.stringify(msg) + '\n')
    return true
  }

  request(msg, timeout = 8000) {
    const id = `r${++this.seq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, timeout)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
      })
      if (!this.send({ ...msg, id })) {
        this.pending.delete(id)
        clearTimeout(timer)
        resolve(null)
      }
    })
  }

  /** The kernel raises KeyboardInterrupt in its main thread itself (a signal on every platform, so time.sleep wakes too). */
  interrupt() {
    this.send({ type: 'interrupt' })
  }

  stop() {
    this.expected = true
    if (!this.child) return
    this.send({ type: 'shutdown' })
    const child = this.child
    try {
      child.stdin.end()
    } catch {
      /* closed */
    }
    setTimeout(() => killTree(child), 400).unref()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Block methods

/** key -> { kernel, starting, ctx } */
const kernels = new Map()

function emitter(ctx) {
  return ctx && typeof ctx.emit === 'function' ? ctx.emit.bind(ctx) : () => {}
}

function need(key) {
  const entry = kernels.get(key)
  if (!entry || !entry.kernel || !entry.kernel.alive) return null
  return entry.kernel
}

async function pickPython({ cwd, python }) {
  if (python) {
    const found = await findPythons({ cwd, python })
    const hit = found.find((p) => p.exe === python) || (found.length && found[0].source === 'settings' ? found[0] : null)
    if (hit) return hit
    return { error: 'BAD_PYTHON', message: noPythonMessage(python) }
  }
  const list = await findPythons({ cwd })
  if (!list.length) return { error: 'NO_PYTHON', message: noPythonMessage() }
  return list[0]
}

async function startKernel({ key, cwd, python, figureFormat }, ctx, opts = {}) {
  if (typeof key !== 'string' || !key) throw new Error('kernel key required')
  const emit = emitter(ctx)
  const have = kernels.get(key)
  if (have && have.starting) return have.starting
  if (have && have.kernel && have.kernel.alive) return { ok: true, info: have.kernel.info, python: have.python }
  const entry = { kernel: null, starting: null, ctx, python: null }
  kernels.set(key, entry)
  entry.starting = (async () => {
    try {
      const picked = await pickPython({ cwd, python })
      if (picked.error) return { ok: false, code: picked.error, message: picked.message }
      const kernel = new Kernel({
        key,
        python: picked.exe,
        cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
        figureFormat,
        spawnFn: opts.spawnFn,
        onEvent: (ev) => {
          if (entry.kernel !== kernel) return
          try {
            emit('kernel', { key, ev })
          } catch {
            /* the window is gone */
          }
        },
      })
      entry.kernel = kernel
      entry.python = picked
      const info = await kernel.start()
      return { ok: true, info, python: picked }
    } catch (err) {
      entry.kernel = null
      return { ok: false, code: err.code || 'KERNEL_START', message: err.message }
    } finally {
      entry.starting = null
    }
  })()
  const res = await entry.starting
  if (!res.ok && kernels.get(key) === entry) kernels.delete(key)
  return res
}

function stopKernel(key) {
  const entry = kernels.get(key)
  if (!entry) return false
  kernels.delete(key)
  const kernel = entry.kernel
  entry.kernel = null // events of the stopped kernel (its exit included) are dropped: the caller knows
  if (kernel) kernel.stop()
  return true
}

const methods = {
  /** Usable Pythons for this folder (cached 30 s). */
  async interpreters({ cwd, python, refresh } = {}) {
    return { list: await findPythons({ cwd, python, refresh }), kernelDir: KERNEL_DIR }
  },

  /** Read a notebook. A missing file opens as a fresh in-memory notebook (created on the first save). */
  async open({ path: file, cwd } = {}) {
    if (!file) return { path: null, name: 'Untitled.ipynb', nb: newNotebook(), format: { indent: ' ', sortKeys: true, eol: '\n', finalNewline: true }, mtimeMs: null, missing: true }
    const abs = path.resolve(cwd || process.cwd(), file)
    let stat
    try {
      stat = fs.statSync(abs)
    } catch (err) {
      if (err.code !== 'ENOENT') return { ok: false, error: err.message, path: abs }
      return { path: abs, name: path.basename(abs), nb: newNotebook(), format: { indent: ' ', sortKeys: true, eol: '\n', finalNewline: true }, mtimeMs: null, missing: true }
    }
    if (!stat.isFile()) return { ok: false, error: `${abs} is not a file`, path: abs }
    if (stat.size > MAX_NOTEBOOK_BYTES) return { ok: false, error: `${path.basename(abs)} is ${(stat.size / 1048576).toFixed(0)} MB; notebooks over 256 MB are not opened`, path: abs }
    let parsed
    try {
      if (stat.size === 0) parsed = { nb: newNotebook(), format: { indent: ' ', sortKeys: true, eol: '\n', finalNewline: true } }
      else parsed = parseNotebook(fs.readFileSync(abs, 'utf8'))
    } catch (err) {
      return { ok: false, error: err.message, path: abs }
    }
    return { path: abs, name: path.basename(abs), nb: parsed.nb, format: parsed.format, mtimeMs: stat.mtimeMs, missing: false }
  },

  /** Write atomically. `expectMtimeMs` guards against overwriting someone else's edit; `create` refuses an existing file. */
  async save({ path: file, cwd, nb, format, expectMtimeMs, create, force } = {}) {
    if (!file) throw new Error('path required')
    if (!nb || !Array.isArray(nb.cells)) throw new Error('notebook required')
    const abs = path.resolve(cwd || process.cwd(), file)
    let stat = null
    try {
      stat = fs.statSync(abs)
    } catch {
      /* new file */
    }
    if (!force && stat) {
      if (create) return { ok: false, conflict: 'exists', mtimeMs: stat.mtimeMs }
      if (typeof expectMtimeMs === 'number' && Math.abs(stat.mtimeMs - expectMtimeMs) > 1) return { ok: false, conflict: 'changed', mtimeMs: stat.mtimeMs }
    }
    const text = serializeNotebook(nb, format)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`
    try {
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, abs)
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* nothing */
      }
      fs.writeFileSync(abs, text, 'utf8') // a locked target (antivirus, sync client): write in place
    }
    return { ok: true, path: abs, name: path.basename(abs), mtimeMs: fs.statSync(abs).mtimeMs, bytes: Buffer.byteLength(text) }
  },

  async kernelStart(args, ctx) {
    return startKernel(args || {}, ctx)
  },

  /**
   * Queue cells: `{ id, code }` or `{ cells: [{ id, code }, ...] }` (written to the kernel in one go, so a failing cell aborts
   * the rest of the batch). The kernel runs requests in order and aborts the queue after an error when stopOnError is set.
   */
  async execute({ key, id, code, cells, stopOnError = true, allowStdin = true, silent = false, storeHistory = true } = {}, ctx) {
    let kernel = need(key)
    if (!kernel) {
      const res = await startKernel(arguments[0], ctx)
      if (!res.ok) return res
      kernel = need(key)
      if (!kernel) return { ok: false, code: 'KERNEL_START', message: 'the kernel is not running' }
    }
    const batch = Array.isArray(cells) ? cells : [{ id, code }]
    const lines = batch.map((c) =>
      JSON.stringify({ type: 'execute', id: c.id, code: String(c.code ?? ''), silent, store_history: storeHistory && !silent, allow_stdin: allowStdin, stop_on_error: stopOnError }),
    )
    kernel.sendRaw(lines.join('\n') + '\n')
    return { ok: true }
  },

  async interrupt({ key } = {}) {
    const kernel = need(key)
    if (kernel) kernel.interrupt()
    return { ok: !!kernel }
  },

  async inputReply({ key, value } = {}) {
    const kernel = need(key)
    return { ok: !!kernel && kernel.send({ type: 'input_reply', value: String(value ?? '') }) }
  },

  async restart(args = {}, ctx) {
    stopKernel(args.key)
    return startKernel(args, ctx)
  },

  async shutdown({ key } = {}) {
    return { ok: stopKernel(key) }
  },

  async configure({ key, figureFormat, closeFigures } = {}) {
    const kernel = need(key)
    if (!kernel) return { ok: false }
    const msg = { type: 'configure' }
    if (figureFormat) msg.figure_format = figureFormat
    if (typeof closeFigures === 'boolean') msg.close_figures = closeFigures
    return { ok: kernel.send(msg) }
  },

  async complete({ key, code, cursor } = {}) {
    const kernel = need(key)
    if (!kernel) return { matches: [], cursor_start: cursor, cursor_end: cursor }
    return (await kernel.request({ type: 'complete', code, cursor })) || { matches: [], cursor_start: cursor, cursor_end: cursor }
  },

  async inspect({ key, code, cursor, detail = 0 } = {}) {
    const kernel = need(key)
    if (!kernel) return { found: false, data: {} }
    return (await kernel.request({ type: 'inspect', code, cursor, detail })) || { found: false, data: {} }
  },

  async variables({ key } = {}) {
    const kernel = need(key)
    if (!kernel) return { vars: [] }
    return (await kernel.request({ type: 'variables' })) || { vars: [] }
  },

  async status({ key } = {}) {
    const entry = kernels.get(key)
    const kernel = entry && entry.kernel
    return { alive: !!(kernel && kernel.alive), starting: !!(entry && entry.starting), info: kernel ? kernel.info : null, running: kernel ? [...kernel.running] : [] }
  },
}

function dispose() {
  for (const key of [...kernels.keys()]) stopKernel(key)
}

module.exports = {
  methods,
  dispose,
  // exported for tests
  _internals: { parseNotebook, serializeNotebook, prepareForSave, newNotebook, splitLines, joinText, findPythons, probe, Kernel, LineSplitter, startKernel, stopKernel, noPythonMessage, KERNEL_DIR },
}
