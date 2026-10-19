#!/usr/bin/env node
import './platform/env.js'
import type { Engine } from './app/engine.js'
import { acquireLock, AlreadyRunningError } from './platform/lock.js'
import { dataDir } from './platform/paths.js'
import { MOUSE_OFF } from './ui/input/mouse.js'
import { isNewer, latestVersion, runUpdate } from './app/update.js'
import { VERSION } from './app/version.js'
import { parseArgs } from './app/args.js'
import { applyEnvFromSettings } from './app/envSettings.js'
import { loadSettings } from './app/settings.js'
import { promptSecret } from './platform/secretPrompt.js'
import { runLock, runUnlock, unlockWithPassphrase } from './app/lockCommand.js'
import { identityLockState } from './chat/identity.js'
import { type Secrets } from './chat/secrets.js'

const USAGE = `pager: a simpler way to chat

Usage: pager [update | lock | unlock | -h | --help | -v | --version]

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
if (parsed.command === 'lock' || parsed.command === 'unlock') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`pager ${parsed.command} needs an interactive terminal\n`)
    process.exit(2)
  }
  process.exit(await (parsed.command === 'lock' ? runLock : runUnlock)(dataDir(), process.env))
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

const bootstrap = process.env.PAGER_BOOTSTRAP?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)

let engine: Engine
try {
  // Dynamic for the same reason as above: keep native addons out of `pager update` / --help / --version.
  const { Engine } = await import('./app/engine.js')
  engine = await Engine.open({ dir, bootstrap: bootstrap && bootstrap.length > 0 ? bootstrap : undefined, checkAgents: process.env.PAGER_NO_AGENTS !== '1', secrets, envLocks, agents: process.env.PAGER_NO_AGENTS !== '1' })
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
process.on('uncaughtException', (err) => void shutdown(1, err))
process.on('unhandledRejection', (err) => void shutdown(1, err))
