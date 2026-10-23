'use strict'
// Main-process handler of the Task manager block: processes, CPU, memory, GPU; Stop / Force Quit with guards.
//
// Sampling is pull-based and free while nobody looks: the renderer calls `sample` on its own timer and stops
// calling when the pane is hidden. Nothing here runs on a timer except the idle reaper, which ends the helper
// process 30 s after the last sample, so a hidden Task manager costs nothing at all.
//
// Windows only (the sampler reads NtQuerySystemInformation and the "GPU Engine" counters through a small C#
// helper, tasks-helper.cjs, compiled once by Windows PowerShell and cached next to the user's data).
const os = require('node:os')
const core = require('./tasks-core.cjs')
const { SOURCE } = require('./tasks-helper.cjs')
const { Helper, bootScript } = require('./ps-helper.cjs')

const IDLE_MS = 30000
const MIN_AGE_MS = 700 // two panes asking at once share one sample

// ---------------------------------------------------------------- state

const helper = new Helper({ name: 'tasks', source: SOURCE, type: 'PagerProc' })
const procs = new Map() // pid -> { ppid, name, cmd, create }
const cpuBase = new Map()
let prevCpus = null
let last = null // last snapshot
let lastAt = 0
let inflight = null
let idleTimer = null
const NCPU = Math.max(1, os.cpus().length)

const stats = { samples: 0, roundTripMs: 0, mainMs: 0, helperCpuPct: 0, helperCpuSamples: 0, bytes: 0, since: Date.now() }
let statsPid = null

function ownPids() {
  const s = new Set([process.pid])
  try {
    const electron = require('electron')
    if (electron && electron.app && typeof electron.app.getAppMetrics === 'function') for (const m of electron.app.getAppMetrics()) s.add(m.pid)
  } catch {
    /* plain node (tests) */
  }
  const hp = helper.pid
  if (hp) s.add(hp)
  return s
}

function armIdle() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => helper.stop(), IDLE_MS)
  idleTimer.unref()
}

async function takeSample(wantGpu) {
  if (process.platform !== 'win32') throw new Error('The task manager reads Windows process counters; it is not available on this platform yet.')
  const t0 = process.hrtime.bigint()
  const { j, raw } = await helper.request(wantGpu ? 's g' : 's')
  const t1 = process.hrtime.bigint()
  const sample = core.parseSample(j)
  // process table: new entries and replaced pids come with names; vanished pids go
  const alive = new Set()
  for (const [pid] of sample.p) alive.add(pid)
  for (const pid of procs.keys()) if (!alive.has(pid)) procs.delete(pid)
  for (const n of sample.n) procs.set(n.pid, { ppid: n.ppid, name: n.name, cmd: n.cmd, create: n.create })
  const cpu = core.cpuPercents(cpuBase, sample, NCPU)
  const cpus = os.cpus()
  const sysCpu = core.systemCpu(prevCpus, cpus)
  prevCpus = cpus
  const own = ownPids()
  const kinds = core.classify(procs, own, [])
  const g = sample.g && typeof sample.g === 'object' ? sample.g : null
  const rows = []
  for (const [pid, threads, mem] of sample.p) {
    const info = procs.get(pid)
    if (!info) continue
    rows.push({
      pid,
      ppid: info.ppid,
      name: info.name || (pid === 4 ? 'System' : `pid ${pid}`),
      cmd: info.cmd || '',
      create: info.create,
      threads,
      mem,
      cpu: Math.round((cpu.get(pid) || 0) * 10) / 10,
      gpu: g && g.p[pid] !== undefined ? g.p[pid] : 0,
      kind: kinds.get(pid) || null,
      critical: core.isCritical(info.name, pid),
    })
  }
  const total = os.totalmem()
  const hp = helper.pid
  const hrow = hp ? rows.find((r) => r.pid === hp) : null
  // the first sample of a helper process (compile/JIT, every command line) is not what steady sampling costs
  const warm = helper.pid !== statsPid
  statsPid = helper.pid
  if (!warm) {
    stats.samples++
    stats.roundTripMs += Number(t1 - t0) / 1e6
    stats.bytes += raw.length
    if (hrow) {
      stats.helperCpuPct += hrow.cpu
      stats.helperCpuSamples++
    }
  }
  const snap = {
    at: Date.now(),
    ncpu: NCPU,
    cpu: Math.round(sysCpu * 10) / 10,
    mem: { used: total - os.freemem(), total },
    gpu: sample.g === false ? false : g ? g.total : null,
    procs: rows,
    cost: null,
  }
  if (!warm) stats.mainMs += Number(process.hrtime.bigint() - t1) / 1e6
  snap.cost = costOf()
  return snap
}

function costOf() {
  const n = Math.max(1, stats.samples)
  return {
    samples: stats.samples,
    roundTripMs: Math.round((stats.roundTripMs / n) * 10) / 10,
    mainMs: Math.round((stats.mainMs / n) * 10) / 10,
    helperCpuPct: stats.helperCpuSamples ? Math.round((stats.helperCpuPct / stats.helperCpuSamples) * 100) / 100 : null,
    kbPerSample: Math.round(stats.bytes / n / 102.4) / 10,
  }
}

const methods = {
  /** One snapshot (shared by concurrent callers). `gpu:false` skips the GPU counters. */
  async sample({ gpu = true } = {}) {
    armIdle()
    if (last && Date.now() - lastAt < MIN_AGE_MS) return last
    if (!inflight) {
      inflight = takeSample(!!gpu)
        .then((s) => {
          last = s
          lastAt = Date.now()
          return s
        })
        .finally(() => {
          inflight = null
        })
    }
    return inflight
  },

  /** Owner, executable path and suspended state of one process (an extra helper call, only for the selection). */
  async detail({ pid }) {
    pid = int(pid)
    const info = procs.get(pid)
    if (!info) throw new Error('That process has already ended.')
    armIdle()
    const { j } = await helper.request(`d ${pid}`)
    if (j.error) throw new Error(j.error)
    const parent = procs.get(info.ppid)
    const kids = [...procs.values()].filter((p) => p.ppid === pid).length
    return { pid, ppid: info.ppid, parent: parent ? parent.name : null, children: kids, user: j.user, path: j.path, suspended: !!j.suspended, cmd: info.cmd || '', name: info.name }
  },

  /** Ask a process to close: WM_CLOSE to its top-level windows. Windows has no SIGTERM; Force Quit is the other half. */
  async stop(a) {
    const pids = prepare(a)
    let closed = 0
    for (const pid of pids.slice().reverse()) {
      const { j } = await helper.request(`x ${pid}`)
      if (j.error) throw new Error(j.error)
      closed += j.closed || 0
    }
    return { closed, pids }
  },

  /** TerminateProcess on the pid (and its tree, deepest first when `tree`). */
  async kill(a) {
    const pids = prepare(a)
    const { j } = await helper.request(`k ${pids.join(',')}`)
    if (j.error) throw new Error(j.error)
    const failed = Object.entries(j.results || {}).filter(([, code]) => code !== 0).map(([pid, code]) => ({ pid: Number(pid), code }))
    last = null
    return { pids, failed }
  },

  async suspend(a) {
    return pauseOrResume(a, false)
  },

  async resume(a) {
    return pauseOrResume(a, true)
  },

  /** What sampling costs, measured since the block started (also on every snapshot as `cost`). */
  stats() {
    return { ...costOf(), helperRunning: !!helper.pid, since: stats.since }
  },
}

const int = (v) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid process id')
  return n
}

/** Validate an action request: explicit confirmation, a fresh table, and the guards. Returns pids, deepest first. */
function prepare({ pid, create, tree, confirm }) {
  if (confirm !== true) throw new Error('Not confirmed.')
  pid = int(pid)
  const own = ownPids()
  const kinds = core.classify(procs, own, [])
  return core.guardTargets(procs, kinds, pid, { create: create === undefined ? null : create, tree: !!tree, protect: own })
}

async function pauseOrResume({ pid, create, confirm }, resume) {
  if (confirm !== true) throw new Error('Not confirmed.')
  pid = int(pid)
  const own = ownPids()
  const kinds = core.classify(procs, own, [])
  core.guardTargets(procs, kinds, pid, { create: create === undefined ? null : create, tree: false, protect: own })
  armIdle()
  const { j } = await helper.request(`${resume ? 'r' : 'z'} ${pid}`)
  if (j.error || j.code !== 0) throw new Error(j.error || `Windows refused (code ${j.code}).`)
  last = null
  return { ok: true }
}

function dispose() {
  clearTimeout(idleTimer)
  helper.stop()
}

module.exports = { methods, dispose, _t: { helper, procs, prepare, ownPids, takeSample, costOf, stats } }
