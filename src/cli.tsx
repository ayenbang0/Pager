#!/usr/bin/env node
import './platform/env.js'
import fs from 'node:fs'
import path from 'node:path'
import type { Engine } from './app/engine.js'
import type { LanHandle } from './net/lan.js'
import { AlreadyRunningError } from './platform/lock.js'
import { acquireLockOrAskDaemon, HeldByDaemonError } from './daemon/handoff.js'
import { dataDir } from './platform/paths.js'
import { MOUSE_OFF } from './ui/input/mouse.js'
import { isNewer, latestVersion, runUpdate } from './app/update.js'
import { VERSION } from './app/version.js'
import { parseArgs } from './app/args.js'
import { applyEnvFromSettings } from './app/envSettings.js'
import { loadSettings } from './app/settings.js'
import { promptSecret } from './platform/secretPrompt.js'
import { startError } from './platform/appControl.js'
import { sendControl, startControl } from './app/control.js'
import { openInApp } from './platform/appBrowser.js'
import type { Secrets } from './chat/secrets.js'

const USAGE = `pager: a simpler way to chat

Usage: pager [--cwd DIR] [--lan [host:port]] [--no-agents] [run | docs | studio | desktop | daemon | serve | show | split | capture | send | ls | events | open | update | lock | unlock | -h | --help | -v | --version]

  --cwd DIR          start with the Terminal tab in DIR
  --lan [host:port]  chat over the local network only: find (or start) the network's DHT, or join the one at host:port
  --no-agents        turn off the agents room, the AI tab and the agent tool server

  docs             open the local docs and your usage stats (a running pager serves them; shown in the desktop window's browser pane)
  studio           open the local bot studio: shape bots in fine detail, preview their prompt, try them
  run [--cwd DIR] [--] <command...>
                   run a command in a new Terminal tab of the running pager (or start pager with it)
  desktop install|uninstall|launch|status
                   Windows only: a glass window host for pager (Windows Terminal), Start menu entry, "Open Pager here"
  daemon start|stop|status
                   the session daemon that keeps the desktop window's programs alive between windows
  serve [--port N] [--host ADDR] [--read-only] [--tls-cert FILE --tls-key FILE] [--allow-host NAME]... | --stop | --status
                   the session daemon in a browser: live terminals, input, new/split/close panes (127.0.0.1:8377; the URL carries a one-time token; --host 0.0.0.0 opts in to the network)
  show mermaid|math|diff|image <file|-> [--title TEXT] [--id ID] [--height ROWS]
                   draw a diagram, formula, diff or picture inline in the desktop terminal (reads standard input for -)
  split right|down [--pane ID] [--kind K] [--cwd DIR] [-- COMMAND...]
                   a pane beside this one (or the focused one) in the desktop window
  capture [--pane ID] [--lines N] [--ansi] [--json]
                   print what a pane shows
  send [--pane ID] [--no-enter] TEXT...
                   type TEXT (and Enter) into a pane
  ls [--json]      sessions, tabs and panes
  events [--filter KIND,...]
                   JSON lines of what happens, until interrupted
  open [--pane ID] [--split right|down] [--tab] PATH[:LINE[:COL]]... | URL
                   show files in a files block, or a page in the browser pane
  update           install the latest release (npm install -g pager-cli@latest)
  lock             protect your identity key and encrypt history, group titles and contact names with a passphrase
  unlock           remove that protection again

Environment:
  PAGER_HOME             data directory (default ~/.pager)
  PAGER_BOOTSTRAP        comma-separated host:port DHT bootstrap nodes (default: public HyperDHT)
  PAGER_NO_UPDATE_CHECK  set to 1 to skip the daily check for a newer version
  PAGER_PASSPHRASE       passphrase to try first when pager is locked
`

const parsed = parseArgs(process.argv.slice(2))
if ('error' in parsed) {
  process.stderr.write(USAGE)
  process.exit(2)
}
if (parsed.command === 'help') {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (parsed.command === 'version') {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}
if (parsed.command === 'update') process.exit(await runUpdate(dataDir(), VERSION))
if (parsed.command === 'docs' || parsed.command === 'studio') {
  const sent = await sendControl(dataDir(), parsed.command === 'studio' ? { type: 'docs', page: 'studio' } : { type: 'docs' })
  if (sent.kind === 'none' || !sent.reply.ok || sent.reply.url === undefined) {
    process.stderr.write(sent.kind === 'ok' && !sent.reply.ok ? `${sent.reply.error}\n` : 'pager is not running: start it, then run pager ${parsed.command} (or press F1 / F2 in the desktop window)\n')
    process.exit(1)
  }
  if (!(await openInApp(sent.reply.url))) process.stdout.write(`${sent.reply.url}\n(the browser pane lives in the Pager desktop window: pager desktop install)\n`)
  process.exit(0)
}
if (parsed.command === 'desktop') {
  const { runDesktop } = await import('./host/cli.js') // only the desktop commands pay for loading it
  process.exit(await runDesktop(parsed.desktop!, dataDir()))
}
if (parsed.command === 'daemon') {
  const { runDaemonCommand } = await import('./daemon/cli.js') // only the daemon commands pay for loading it
  process.exit(await runDaemonCommand(parsed.daemon!, dataDir()))
}
if (parsed.command === 'show') {
  const { runShow } = await import('./surface/emit.js') // only `pager show` pays for loading it
  process.exit(
    await runShow(parsed.show!, {
      stdin: process.stdin,
      write: (text) => {
        const done = Promise.withResolvers<void>()
        process.stdout.write(text, (e) => (e ? done.reject(e) : done.resolve()))
        return done.promise
      },
      error: (text) => process.stderr.write(text),
    }),
  )
}
if (parsed.cwd !== undefined) {
  let isDir = false
  try {
    isDir = fs.statSync(parsed.cwd).isDirectory()
  } catch {
    // not there
  }
  if (!isDir) {
    process.stderr.write(`not a folder: ${parsed.cwd}\n`)
    process.exit(2)
  }
  process.chdir(parsed.cwd)
}
let startup: { cwd: string; command?: string } | undefined
if (parsed.command === 'exec') {
  const command = parsed.words?.join(' ')
  const request = { cwd: process.cwd(), ...(command === undefined ? {} : { command }) }
  if (process.env.PAGER_PANE !== undefined) {
    // Inside a desktop pane the daemon lays the new shell out beside this pane; a daemon that is gone falls through to the control pipe.
    const { runInDaemon } = await import('./daemon/cli.js')
    try {
      await runInDaemon(dataDir(), request)
      process.stdout.write('sent to pager\n')
      process.exit(0)
    } catch {
      // no daemon behind this pane: the usual way below
    }
  }
  let sent
  try {
    sent = await sendControl(dataDir(), { type: 'run', ...request })
  } catch (err) {
    process.stderr.write(`pager run: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
  if (sent.kind === 'ok') {
    if (sent.reply.ok) process.stdout.write('sent to pager\n')
    else process.stderr.write(`${sent.reply.error}\n`)
    process.exit(sent.reply.ok ? 0 : 1)
  }
  startup = request
}
if (parsed.command === 'lock' || parsed.command === 'unlock') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`pager ${parsed.command} needs an interactive terminal\n`)
    process.exit(2)
  }
  // Dynamic: these load hyperdht, whose native addons must stay unloaded for `pager update` (Windows cannot replace loaded .node files).
  const { runLock, runUnlock } = await import('./app/lockCommand.js')
  process.exit(await (parsed.command === 'lock' ? runLock : runUnlock)(dataDir(), process.env))
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('pager needs an interactive terminal\n')
  process.exit(1)
}

const dir = dataDir()
let release: () => void
try {
  release = await acquireLockOrAskDaemon(dir)
} catch (err) {
  if (err instanceof AlreadyRunningError) {
    const by = err instanceof HeldByDaemonError ? ` The pager daemon holds it for the desktop's chat; \`pager daemon stop\` releases it.` : ''
    process.stderr.write(`pager is already running (pid ${err.pid}) for ${dir}.${by}\n`)
    process.exit(1)
  }
  throw err
}

// Dynamic like the Engine import below: native addons stay out of `pager update` / --help / --version. A load failure
// (Smart App Control refusing a .node file) is explained instead of printing a stack.
const failStart = (err: unknown): never => {
  release()
  process.stderr.write(`pager failed to start: ${startError(err)}\n`)
  process.exit(1)
}
const { identityLockState } = await import('./chat/identity.js').catch(failStart)
const { unlockWithPassphrase } = await import('./app/lockCommand.js').catch(failStart)
let secrets: Secrets | undefined
const lockState = identityLockState(dir)
if (lockState.locked) {
  secrets = await unlockWithPassphrase(dir, lockState.salt!, process.env, { ask: (q) => promptSecret(q), out: (l) => void process.stderr.write(`${l}\n`) })
  if (secrets === undefined) {
    release()
    process.exit(1)
  }
}

// Settings that modules read from the environment at load time must be projected before the dynamic imports below.
const envLocks = applyEnvFromSettings(loadSettings(dir), process.env, { lan: parsed.lan, noAgents: parsed.noAgents })

// LAN-only mode (the flag, or the setting plus a restart) keeps everything on the local network: no web, no update check.
const lanOn = process.env.PAGER_LAN === '1'
if (lanOn) {
  const source = parsed.lan ? '--lan' : 'PAGER_LAN'
  process.env.PAGER_NO_WEB = '1'
  process.env.PAGER_NO_UPDATE_CHECK = '1'
  for (const key of ['web', 'updateCheck'] as const) if (!envLocks.some((l) => l.key === key)) envLocks.push({ key, source })
}

const bootstrap = process.env.PAGER_BOOTSTRAP?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)

let lan: LanHandle | undefined
if (lanOn) {
  try {
    const { startLan } = await import('./net/lan.js')
    lan = await startLan({ target: parsed.lanTarget })
  } catch (err) {
    release()
    process.stderr.write(`pager failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

let engine: Engine
try {
  // Dynamic for the same reason as above: keep native addons out of `pager update` / --help / --version.
  const { Engine } = await import('./app/engine.js')
  const agents = process.env.PAGER_NO_AGENTS !== '1'
  // LAN mode ignores PAGER_BOOTSTRAP: it talks to the DHT found (or started) on the local network.
  const nodes = lan !== undefined ? lan.bootstrap : bootstrap && bootstrap.length > 0 ? bootstrap : undefined
  engine = await Engine.open({ dir, bootstrap: nodes, checkAgents: agents, secrets, envLocks, agents, ...(lan === undefined ? {} : { lan: { hosting: lan.hosting, address: lan.address } }) })
} catch (err) {
  release()
  process.stderr.write(`pager failed to start: ${startError(err)}\n`)
  process.exit(1)
}

if (process.env.PAGER_NO_UPDATE_CHECK !== '1') {
  void latestVersion(dir).then((latest) => {
    if (latest !== undefined && isNewer(latest, VERSION)) engine.setUpdate(latest)
  })
}

let control: { close(): void } | undefined
try {
  control = await startControl(dir, (r) => (r.type === 'docs' ? engine.docsUrl(r.page).then((url) => ({ ok: true as const, url })) : engine.runInTerminal(r)))
} catch {
  // No control channel (name taken, pipes unavailable): pager still works, `pager run` just starts its own.
}

let shuttingDown = false
async function shutdown(code: number, error?: unknown): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  control?.close()
  app.unmount()
  await app.waitUntilExit().catch(() => {})
  process.stdout.write(MOUSE_OFF) // the terminal outlives us; never leave mouse reporting on
  await engine.close().catch(() => {})
  await lan?.stop().catch(() => {})
  release()
  if (error !== undefined) process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(code)
}

// Dynamic: static imports would load hyperdht's native addons even for `pager update`, and Windows
// cannot replace .node files this process has loaded.
const { createElement } = await import('react') // not JSX: its static runtime import would load React before env.ts sets NODE_ENV
const { render } = await import('ink')
const { App } = await import('./ui/App.js')

// interactive: stdin/stdout are already verified TTYs, so a stray CI variable must not blank the UI.
const app = render(createElement(App, { engine, onExit: () => void shutdown(0) }), {
  alternateScreen: true,
  exitOnCtrlC: false,
  interactive: true,
  incrementalRendering: true,
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void shutdown(0))
// Ink ends on its own when the UI throws while rendering (its exit promise rejects): that is a real crash, so leave with its error.
void app.waitUntilExit().then(
  () => void shutdown(0),
  (err: unknown) => {
    recordCrash('ui', err)
    void shutdown(1, err)
  },
)

// Last resort: a stray error in a background task must not take the whole session down with it. Errors that leave the process unsound
// (the terminal is gone, out of memory) or that keep coming still end the run; any other is logged to crash.log and shown as a toast.
const crashLog = path.join(dir, 'crash.log')
const FATAL_CODES = new Set(['EPIPE', 'EIO', 'ENOMEM', 'ERR_WORKER_OUT_OF_MEMORY', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_USE_AFTER_CLOSE'])
const STORM = { count: 20, windowMs: 10_000 }
const recent: number[] = []
function errorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err)
}
function recordCrash(kind: string, err: unknown): void {
  try {
    fs.appendFileSync(crashLog, `[${new Date().toISOString()}] ${kind} (pager ${VERSION}): ${errorText(err)}\n`)
  } catch {
    // The data directory may be what is broken; the toast and stderr path below still run.
  }
}
function survive(kind: string, err: unknown): void {
  recordCrash(kind, err)
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : ''
  const now = Date.now()
  recent.push(now)
  while (recent.length > 0 && now - recent[0]! > STORM.windowMs) recent.shift()
  if (shuttingDown) return
  if (FATAL_CODES.has(code) || recent.length >= STORM.count) return void shutdown(1, err)
  try {
    const why = err instanceof Error ? err.message : String(err)
    engine.toast('error', `Pager hit an error and kept going: ${why.slice(0, 200)} (details: ${crashLog})`)
  } catch {
    // No toast: the log has it.
  }
}
process.on('uncaughtException', (err) => survive('uncaughtException', err))
process.on('unhandledRejection', (err) => survive('unhandledRejection', err))

// `pager run` found no running pager: this one starts with the request.
if (startup !== undefined) {
  const reply = engine.runInTerminal(startup)
  if (!reply.ok) engine.toast('error', reply.error)
}
