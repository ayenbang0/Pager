// Launch-time harness for the packed desktop app (release/Pager/Pager.exe).
//
//   node scripts/desktop/bench.mjs [--release DIR] [--runs 5] [--only cold|warm] [--out file.json] [--label text]
//
// Cold = no daemon running and an empty PAGER_HOME: the window has to start the daemon and the first pane.
// Warm = the daemon of an earlier launch is still running (its window was closed): reopen = connect + attach.
// Every run is a fresh Pager.exe process with its own --user-data-dir (so a Pager you are using is never touched or
// forwarded to) and its own PAGER_HOME (so the daemon pipe is another one: pager-<user>-<hash of the home>).
// Nothing is attached from outside: main.cjs, given PAGER_TRACE=<file>, appends its own marks (epoch ms) and, when the
// first terminal output has been written, the renderer's performance marks; with PAGER_TRACE_CLOSE it then closes the
// window by itself, like a user would. (No debugging port: it costs start-up time, and a daemon spawned by the app
// inherits the app's listening sockets, which made a port unreliable.)
// Only processes this script started are stopped: the app exits through its window close, the daemon through
// `pager daemon stop` against the bench home; a hard kill uses the PID spawned here, never a process name.
//
// Reported in ms since just before spawn():
//   mainStart      first line of main.cjs ran
//   appReady       app.whenReady resolved
//   daemonUp       daemon connected and state loaded (daemonStarted says whether this launch had to start it)
//   windowCreated  new BrowserWindow() returned
//   readyToShow    ready-to-show fired and the window was shown
//   firstPaint     renderer `first-paint`
//   shellPaint     renderer `shell-first-paint` (skeleton on screen, two frames)
//   shellReady     renderer `shell-ready` (chrome wired)
//   termOutput     renderer `pane-first-byte-any` (first daemon bytes written to a terminal)
//   closeMs        window close -> process exit (a reopen cannot start before it)
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const release = path.resolve(opt('release', path.join(root, 'release', 'Pager')))
const runs = Number(opt('runs', '5'))
const only = opt('only', '')
const outFile = opt('out', '')
const label = opt('label', '')
const exe = path.join(release, 'Pager.exe')
const nodeExe = path.join(release, 'resources', 'node', 'node.exe')
const cliJs = path.join(release, 'resources', 'app', 'pager', 'dist', 'cli.js')
const home = path.join(os.tmpdir(), 'pager-bench-home')
const userData = path.join(os.tmpdir(), 'pager-bench-userdata')
const trace = path.join(os.tmpdir(), 'pager-bench-trace.jsonl')

for (const f of [exe, nodeExe, cliJs]) if (!existsSync(f)) throw new Error(`missing ${f}: run node scripts/desktop/pack.mjs first (or pass --release)`)
for (const f of ['main.cjs', 'preload.cjs']) {
  const packed = path.join(release, 'resources', 'app', 'electron', f)
  if (!existsSync(packed) || !readFileSync(packed).equals(readFileSync(path.join(root, 'desktop', 'electron', f)))) console.error(`note: ${packed} differs from desktop/electron/${f} (stale pack?)`)
}

const env = () => {
  const e = { ...process.env, PAGER_HOME: home, PAGER_TRACE: trace, PAGER_TRACE_CLOSE: '1' }
  delete e.PAGER_DAEMON_SOCKET
  delete e.ELECTRON_RUN_AS_NODE
  return e
}

function daemon(action) {
  const r = spawnSync(nodeExe, [cliJs, 'daemon', action], { env: env(), encoding: 'utf8', timeout: 20_000, windowsHide: true })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

function stopDaemon() {
  const status = daemon('status')
  if (!/running/.test(status) || /not running/.test(status)) return
  daemon('stop')
  const pid = /pid (\d+)/.exec(status)?.[1]
  // `daemon stop` waits for the pipe to close; this only matters if it hung.
  if (pid !== undefined && /running/.test(daemon('status')) && !/not running/.test(daemon('status'))) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true })
}

function wipeHome() {
  stopDaemon()
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  mkdirSync(home, { recursive: true })
}

function readTrace() {
  const marks = {}
  if (!existsSync(trace)) return marks
  for (const line of readFileSync(trace, 'utf8').split('\n')) {
    if (line === '') continue
    try {
      const { m, ...rest } = JSON.parse(line)
      if (!(m in marks)) marks[m] = rest
    } catch {
      // a half-written last line
    }
  }
  return marks
}

/** One launch: spawn, wait for the renderer's report, let the window close itself, wait for the exit. */
async function launch() {
  rmSync(trace, { force: true })
  const t0 = Date.now()
  const child = spawn(exe, [`--user-data-dir=${userData}`], { env: env(), stdio: 'ignore' })
  let exitedAt = 0
  child.once('exit', () => {
    exitedAt = Date.now()
  })
  let m = {}
  while (Date.now() - t0 < 60_000 && !exitedAt) {
    m = readTrace()
    if (m.renderer) break
    await sleep(20)
  }
  for (let i = 0; i < 200 && !exitedAt; i++) await sleep(50)
  if (!exitedAt) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    exitedAt = Date.now()
  }
  m = readTrace()
  const rel = (t) => (t === undefined ? null : Math.round((t - t0) * 10) / 10)
  const r = m.renderer
  return {
    pid: child.pid,
    mainStart: rel(m['main-start']?.t),
    appReady: rel(m['app-ready']?.t),
    daemonUp: rel(m['daemon-up']?.t),
    daemonStarted: m['daemon-up']?.started ?? null,
    windowCreated: rel(m['window-created']?.t),
    readyToShow: rel(m['ready-to-show']?.t),
    firstPaint: rel(r?.paints['first-paint']),
    shellPaint: rel(r?.marks['shell-first-paint']),
    shellReady: rel(r?.marks['shell-ready']),
    termOutput: rel(r?.marks['pane-first-byte-any']),
    closeMs: m.closing ? exitedAt - m.closing.t : null,
  }
}

const KEYS = ['mainStart', 'appReady', 'daemonUp', 'windowCreated', 'readyToShow', 'firstPaint', 'shellPaint', 'shellReady', 'termOutput', 'closeMs']
const pct = (xs, q) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (s.length === 0) return null
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]
}
const summary = (rows) => Object.fromEntries(KEYS.map((k) => [k, { median: pct(rows.map((r) => r[k]), 0.5), p90: pct(rows.map((r) => r[k]), 0.9), n: rows.filter((r) => typeof r[k] === 'number').length }]))

async function series(name, prepare, n) {
  const rows = []
  for (let i = 0; i < n; i++) {
    await prepare(i)
    const r = await launch()
    rows.push(r)
    console.error(`${name} ${i + 1}/${n}: ${JSON.stringify(r)}`)
  }
  return rows
}

// --variants a.cjs,b.cjs [--rounds N]: A/B mode for a scratch copy of the release (--release must not be the repo's own release/Pager).
// Each variant is copied over resources/app/electron/main.cjs, and rounds alternate between the variants, so a drifting machine load
// (other builds, antivirus) hits all of them alike; every variant gets runs x rounds launches per scenario.
const variants = opt('variants', '').split(',').filter(Boolean).map((p) => path.resolve(p))
const rounds = variants.length > 0 ? Number(opt('rounds', '3')) : 1
if (variants.length > 0 && release === path.join(root, 'release', 'Pager')) throw new Error('--variants overwrites main.cjs of --release: pass a scratch copy of release/Pager')
const setVariant = (file) => file && copyFileSync(file, path.join(release, 'resources', 'app', 'electron', 'main.cjs'))

mkdirSync(userData, { recursive: true })
const result = { label, release, runs, rounds, when: new Date().toISOString(), electron: readFileSync(path.join(release, 'version'), 'utf8').trim(), variants: {} }
const names = variants.length > 0 ? variants.map((v) => path.basename(v)) : ['current']
for (const n of names) result.variants[n] = { cold: { rows: [] }, warm: { rows: [] } }
try {
  for (let round = 0; round < rounds; round++) {
    for (const [i, name] of names.entries()) {
      setVariant(variants[i])
      const v = result.variants[name]
      const tag = `${name} r${round + 1}`
      if (only !== 'warm') {
        // One unmeasured launch first, so the first run is not the first run of this exe against this profile.
        wipeHome()
        await launch()
        v.cold.rows.push(...(await series(`${tag} cold`, wipeHome, runs)))
      }
      if (only !== 'cold') {
        wipeHome()
        await launch() // starts the daemon and its first pane; closing the window leaves both running
        v.warm.rows.push(...(await series(`${tag} warm`, async () => {}, runs)))
      }
    }
  }
} finally {
  stopDaemon()
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  rmSync(trace, { force: true })
}
for (const v of Object.values(result.variants)) for (const s of ['cold', 'warm']) v[s].summary = summary(v[s].rows)

const f = (v) => (v === null || v === undefined ? '—' : String(Math.round(v)))
for (const [name, v] of Object.entries(result.variants)) {
  for (const scenario of ['cold', 'warm']) {
    if (v[scenario].rows.length === 0) continue
    console.log(`\n${label ? `${label}: ` : ''}${name} ${scenario} (ms since spawn, n=${v[scenario].rows.length}; median / p90)`)
    console.log('| milestone | median | p90 | n |\n|---|---:|---:|---:|')
    for (const k of KEYS) {
      const s = v[scenario].summary[k]
      console.log(`| ${k} | ${f(s.median)} | ${f(s.p90)} | ${s.n} |`)
    }
  }
}
if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 2))
