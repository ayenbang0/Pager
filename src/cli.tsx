#!/usr/bin/env node
import type { Engine } from './engine.js'
import { acquireLock, AlreadyRunningError } from './lock.js'
import { dataDir } from './paths.js'
import { MOUSE_OFF } from './ui/mouse.js'
import { isNewer, latestVersion, runUpdate } from './update.js'
import { VERSION } from './version.js'

const USAGE = `pager: peer-to-peer terminal chat

Usage: pager [update | -h | --help | -v | --version]

  update           install the latest release (npm install -g pager-cli@latest)

Environment:
  PAGER_HOME             data directory (default ~/.pager)
  PAGER_BOOTSTRAP        comma-separated host:port DHT bootstrap nodes (default: public HyperDHT)
  PAGER_NO_UPDATE_CHECK  set to 1 to skip the daily check for a newer version
`

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (args.includes('-v') || args.includes('--version')) {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}
if (args[0] === 'update' && args.length === 1) process.exit(await runUpdate(dataDir(), VERSION))
if (args.length > 0) {
  process.stderr.write(USAGE)
  process.exit(2)
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('pager needs an interactive terminal\n')
  process.exit(1)
}

const dir = dataDir()
let release: () => void
try {
  release = acquireLock(dir)
} catch (err) {
  if (err instanceof AlreadyRunningError) {
    process.stderr.write(`pager is already running (pid ${err.pid}) for ${dir}\n`)
    process.exit(1)
  }
  throw err
}

const bootstrap = process.env.PAGER_BOOTSTRAP?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)

let engine: Engine
try {
  // Dynamic for the same reason as above: keep native addons out of `pager update` / --help / --version.
  const { Engine } = await import('./engine.js')
  engine = await Engine.open({ dir, bootstrap: bootstrap && bootstrap.length > 0 ? bootstrap : undefined })
} catch (err) {
  release()
  process.stderr.write(`pager failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}

if (process.env.PAGER_NO_UPDATE_CHECK !== '1') {
  void latestVersion(dir).then((latest) => {
    if (latest !== undefined && isNewer(latest, VERSION)) engine.setUpdate(latest)
  })
}

let shuttingDown = false
async function shutdown(code: number, error?: unknown): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.unmount()
  await app.waitUntilExit().catch(() => {})
  process.stdout.write(MOUSE_OFF) // the terminal outlives us; never leave mouse reporting on
  await engine.close().catch(() => {})
  release()
  if (error !== undefined) process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(code)
}

// Dynamic: static imports would load hyperdht's native addons even for `pager update`, and Windows
// cannot replace .node files this process has loaded.
const { render } = await import('ink')
const { App } = await import('./ui/App.js')

// interactive: stdin/stdout are already verified TTYs, so a stray CI variable must not blank the UI.
const app = render(<App engine={engine} onExit={() => void shutdown(0)} />, {
  alternateScreen: true,
  exitOnCtrlC: false,
  interactive: true,
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void shutdown(0))
process.on('uncaughtException', (err) => void shutdown(1, err))
process.on('unhandledRejection', (err) => void shutdown(1, err))
