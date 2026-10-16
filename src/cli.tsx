#!/usr/bin/env node
import { createRequire } from 'node:module'
import { render } from 'ink'
import { Engine } from './engine.js'
import { acquireLock, AlreadyRunningError } from './lock.js'
import { dataDir } from './paths.js'
import { App } from './ui/App.js'

const USAGE = `pager: peer-to-peer terminal chat

Usage: pager [-h | --help] [-v | --version]

Environment:
  PAGER_HOME       data directory (default ~/.pager)
  PAGER_BOOTSTRAP  comma-separated host:port DHT bootstrap nodes (default: public HyperDHT)
`

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (args.includes('-v') || args.includes('--version')) {
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
  process.stdout.write(`${pkg.version}\n`)
  process.exit(0)
}
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
  engine = await Engine.open({ dir, bootstrap: bootstrap && bootstrap.length > 0 ? bootstrap : undefined })
} catch (err) {
  release()
  process.stderr.write(`pager failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}

let shuttingDown = false
async function shutdown(code: number, error?: unknown): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.unmount()
  await app.waitUntilExit().catch(() => {})
  await engine.close().catch(() => {})
  release()
  if (error !== undefined) process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(code)
}

// interactive: stdin/stdout are already verified TTYs, so a stray CI variable must not blank the UI.
const app = render(<App engine={engine} onExit={() => void shutdown(0)} />, {
  alternateScreen: true,
  exitOnCtrlC: false,
  interactive: true,
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void shutdown(0))
process.on('uncaughtException', (err) => void shutdown(1, err))
process.on('unhandledRejection', (err) => void shutdown(1, err))
