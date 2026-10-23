'use strict'
// Pure parts of the task manager: helper output parsing, diff-based CPU, GPU, process classification.
// No electron, no child processes: everything here is unit-testable (tasks-core.test.cjs).

const FILETIME_EPOCH_MS = 11644473600000

/** Windows FILETIME (100 ns since 1601) -> unix milliseconds. */
function fileTimeToMs(ft) {
  return Math.round(Number(ft) / 10000 - FILETIME_EPOCH_MS)
}

/**
 * One line of helper output ({ts, p:[[pid,threads,mem,cpu]], n:[[pid,ppid,create,name,cmd]], g}).
 * Throws on a malformed line; the helper reports its own failures as {error}.
 */
function parseSample(line) {
  const j = typeof line === 'string' ? JSON.parse(line) : line
  if (j.error) throw new Error(String(j.error))
  if (!Array.isArray(j.p) || !Array.isArray(j.n) || typeof j.ts !== 'number') throw new Error('malformed process sample')
  return {
    ts: j.ts,
    p: j.p,
    n: j.n.map(([pid, ppid, create, name, cmd]) => ({ pid, ppid, create, name: name || '', cmd: cmd == null ? null : cmd })),
    // false = unavailable on this machine, null = still warming up, object = { total, p:{pid:%} }
    g: j.g === false ? false : j.g && typeof j.g === 'object' ? j.g : null,
  }
}

/**
 * Per-process CPU% (share of the whole machine, like Task Manager) from two cumulative samples.
 * prev: Map pid -> { cpu, ts } (updated in place to the new baseline).
 * Returns Map pid -> percent (0..100). A process seen for the first time reports 0.
 */
function cpuPercents(prev, sample, ncpu) {
  const out = new Map()
  const alive = new Set()
  for (const [pid, , , cpu] of sample.p) {
    alive.add(pid)
    const before = prev.get(pid)
    let pct = 0
    if (before && sample.ts > before.ts && cpu >= before.cpu) {
      pct = ((cpu - before.cpu) / (sample.ts - before.ts) / ncpu) * 100
      if (pct > 100) pct = 100
    }
    out.set(pid, pct)
    prev.set(pid, { cpu, ts: sample.ts })
  }
  for (const pid of prev.keys()) if (!alive.has(pid)) prev.delete(pid)
  return out
}

/** Whole-machine CPU% from two os.cpus() snapshots. */
function systemCpu(prev, cur) {
  if (!prev || prev.length !== cur.length) return 0
  let busy = 0
  let total = 0
  for (let i = 0; i < cur.length; i++) {
    const a = prev[i].times
    const b = cur[i].times
    const idle = b.idle - a.idle
    const all = b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + idle
    total += all
    busy += all - idle
  }
  return total > 0 ? Math.max(0, Math.min(100, (busy / total) * 100)) : 0
}

// Terminating these brings Windows down (bugcheck) or logs the user out; never offered, whoever asks.
const CRITICAL_NAMES = new Set([
  'system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe',
  'lsm.exe', 'secure system', 'memory compression', 'system interrupts', 'system idle process',
])

function isCritical(name, pid) {
  return pid === 0 || pid === 4 || CRITICAL_NAMES.has(String(name).toLowerCase())
}

const NODE_LIKE = /^(node|pager|electron|bun)(\.exe)?$/i

/**
 * Which processes belong to Pager. Returns Map pid -> 'self' | 'daemon' | 'child'.
 *  self   - this app's own processes (main, renderers, GPU/utility helpers)
 *  daemon - the session daemon (owns every terminal and agent)
 *  child  - anything started under self/daemon: terminals, agents, bots
 * `info`: Map pid -> { ppid, name, cmd }. `ownPids`: pids that are certainly this app. `daemonPids`: pids that are certainly the daemon.
 */
function classify(info, ownPids, daemonPids) {
  const out = new Map()
  for (const pid of ownPids) if (info.has(pid)) out.set(pid, 'self')
  for (const pid of daemonPids) if (info.has(pid)) out.set(pid, 'daemon')
  for (const [pid, p] of info) {
    if (out.has(pid)) continue
    if (NODE_LIKE.test(p.name || '') && p.cmd && /\bdaemon\b/i.test(p.cmd) && /pager/i.test(p.cmd)) out.set(pid, 'daemon')
  }
  // descendants
  const kind = (pid) => {
    let cur = info.get(pid)
    for (let hop = 0; cur && hop < 64; hop++) {
      const parent = cur.ppid
      if (!info.has(parent) || parent === pid) return null
      const k = out.get(parent)
      if (k) return 'child'
      cur = info.get(parent)
    }
    return null
  }
  for (const pid of info.keys()) if (!out.has(pid)) {
    const k = kind(pid)
    if (k) out.set(pid, k)
  }
  return out
}

/** pid plus every descendant, deepest first (so killing in order never orphans mid-way). */
function descendants(info, root) {
  const kids = new Map()
  for (const [pid, p] of info) {
    if (pid === p.ppid) continue
    if (!kids.has(p.ppid)) kids.set(p.ppid, [])
    kids.get(p.ppid).push(pid)
  }
  const order = []
  const seen = new Set([root])
  const walk = (pid) => {
    for (const k of kids.get(pid) || []) if (!seen.has(k)) {
      seen.add(k)
      walk(k)
    }
    order.push(pid)
  }
  walk(root)
  return order
}

/**
 * The pids an action may touch, or an Error saying why not. Authoritative (the renderer's confirmation dialog is
 * only the user's half): refuses the OS's critical processes, Pager's own processes (`kinds` 'self'/'daemon', the
 * `protect` set) and any tree that contains one, and a pid whose process was replaced since the list was drawn.
 * info: Map pid -> { ppid, name, create }; kinds: Map pid -> 'self'|'daemon'|'child'.
 */
function guardTargets(info, kinds, pid, { create = null, tree = false, protect = new Set() } = {}) {
  const p = info.get(pid)
  if (!p) throw new Error('That process has already ended.')
  if (create !== null && create !== undefined && p.create !== create) throw new Error('That pid now belongs to a different process; refresh the list.')
  const list = tree ? descendants(info, pid) : [pid]
  for (const q of list) {
    const qi = info.get(q)
    const name = qi ? qi.name : String(q)
    if (isCritical(name, q)) throw new Error(`${name || q} is a critical system process; ending it would crash or log out Windows.`)
    const kind = kinds.get(q)
    if (kind === 'self' || kind === 'daemon' || protect.has(q))
      throw new Error(`${name || q} is part of Pager${kind === 'daemon' ? ' (the session daemon owns your terminals)' : ''}. Quit Pager${kind === 'daemon' ? ' or run "pager daemon stop"' : ''} instead.`)
  }
  return list
}

module.exports = { fileTimeToMs, parseSample, cpuPercents, systemCpu, isCritical, classify, descendants, guardTargets, CRITICAL_NAMES }
