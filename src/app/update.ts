import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { acquireLock, AlreadyRunningError } from '../platform/lock.js'

export const CACHE_TTL_MS = 86_400_000
const REGISTRY_URL = 'https://registry.npmjs.org/pager-cli/latest'
const REGISTRY_TIMEOUT_MS = 4000
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/

/** True when `latest` (a stable x.y.z) is strictly newer than `current` (pre-release suffixes ignored). */
export function isNewer(latest: string, current: string): boolean {
  const a = STABLE.exec(latest)
  const b = /^(\d+)\.(\d+)\.(\d+)/.exec(current)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(b[i])
    if (diff !== 0) return diff > 0
  }
  return false
}

async function fetchLatest(): Promise<string> {
  const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`registry answered ${res.status}`)
  const body: unknown = await res.json()
  if (typeof body === 'object' && body !== null && 'version' in body && typeof body.version === 'string') return body.version
  throw new Error('unexpected registry response')
}

function readCache(dir: string): { checkedAt: number; latest: string } | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'update.json'), 'utf8'))
    if (typeof raw === 'object' && raw !== null && 'checkedAt' in raw && 'latest' in raw) {
      const { checkedAt, latest } = raw
      if (typeof checkedAt === 'number' && typeof latest === 'string' && STABLE.test(latest)) return { checkedAt, latest }
    }
  } catch {
    // missing or corrupt cache: ask the registry
  }
  return undefined
}

export interface LatestOptions {
  /** Ignore the once-a-day cache. */
  force?: boolean
  now?: number
  /** Test seam; defaults to the npm registry. */
  fetchLatest?: () => Promise<string>
}

/** Latest published version, cached for a day in `<dir>/update.json`. Undefined when it cannot be determined. */
export async function latestVersion(dir: string, opts: LatestOptions = {}): Promise<string | undefined> {
  const now = opts.now ?? Date.now()
  const cached = readCache(dir)
  if (!opts.force && cached && now - cached.checkedAt < CACHE_TTL_MS) return cached.latest
  try {
    const latest = await (opts.fetchLatest ?? fetchLatest)()
    if (!STABLE.test(latest)) return undefined
    try {
      fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ checkedAt: now, latest }))
    } catch {
      // a read-only data dir only costs one extra request next time
    }
    return latest
  } catch {
    return undefined
  }
}

/** npm's own entry script, next to the running node (no `.cmd` shim, so no shell is needed on Windows). */
function npmCli(): string | undefined {
  const node = path.dirname(process.execPath)
  return [
    path.join(node, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(node, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((p) => fs.existsSync(p))
}

/** `pager update`: installs the latest release globally. Returns the process exit code. */
export async function runUpdate(dir: string, current: string): Promise<number> {
  const out = (s: string): void => void process.stdout.write(`${s}\n`)
  const manual = 'Run manually: npm install -g pager-cli@latest'
  const latest = await latestVersion(dir, { force: true })
  if (latest === undefined) {
    out('Could not reach the npm registry.')
    return 1
  }
  if (!isNewer(latest, current)) {
    out(`pager ${current} is up to date.`)
    return 0
  }
  // Holding the lock stops a pager in this data directory from running while its files are replaced.
  let release: () => void
  try {
    release = acquireLock(dir)
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      out(`pager is running (pid ${err.pid}). Quit it, then run \`pager update\` again.`)
      return 1
    }
    throw err
  }
  try {
    const cli = npmCli()
    if (cli === undefined) {
      out(`Could not find npm next to node. ${manual}`)
      return 1
    }
    out(`Updating pager ${current} -> ${latest} ...`)
    const { promise, resolve } = Promise.withResolvers<number>()
    const child = spawn(process.execPath, [cli, 'install', '-g', 'pager-cli@latest'], { stdio: 'inherit', windowsHide: true })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
    const code = await promise
    out(
      code === 0
        ? `Updated to ${latest}. Start pager again.`
        : `Update failed (npm exit ${code}). If a file is busy, quit every running pager first. ${manual}`,
    )
    return code
  } finally {
    release()
  }
}
