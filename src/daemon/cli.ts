import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pageUrl } from '../platform/appBrowser.js'
import type { DaemonArgs } from './args.js'
import { connectOrStart, resolvePaths, tryConnect, type DaemonClient } from './client.js'
import { startDaemon, AlreadyRunningError } from './server.js'
import { EVENT_NAMES, type DaemonState, type Pane } from './protocol.js'

const out = (s: string): void => void process.stdout.write(`${s}\n`)

/** What `pager events` prints when no filter is given: everything but the full-state snapshots (`layout_changed` says when). */
const DEFAULT_EVENTS = EVENT_NAMES.filter((n) => n !== 'state')

/** The daemon process itself: runs until `pager daemon stop` or a signal. */
async function serve(dir: string): Promise<number> {
  const paths = resolvePaths({ dir })
  let handle
  try {
    handle = await startDaemon({ dir, address: paths.address, cliPath: paths.cliPath, nodePath: paths.nodePath })
  } catch (e) {
    if (e instanceof AlreadyRunningError) {
      process.stderr.write(`${e.message}\n`)
      return 0
    }
    throw e
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void handle.close())
  // A stray error in one pane's plumbing must not take every program down with the daemon.
  process.on('uncaughtException', (e) => process.stderr.write(`[${new Date().toISOString()}] uncaughtException: ${e.stack ?? e.message}\n`))
  process.on('unhandledRejection', (e) => process.stderr.write(`[${new Date().toISOString()}] unhandledRejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`))
  await handle.stopped
  return 0
}

async function dial(dir: string, start: boolean): Promise<DaemonClient> {
  const paths = resolvePaths({ dir })
  if (start) return (await connectOrStart(paths, { client: 'cli' })).client
  const client = await tryConnect(paths.address, { client: 'cli' })
  if (client === undefined) throw new Error('the daemon is not running (start it: pager daemon start)')
  return client
}

/** True once no process has `pid`; polls, since the daemon finishes its own shutdown (panes, chat engine) after it drops its clients. */
async function exited(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true
    }
    if (Date.now() >= end) return false
    await sleep(50)
  }
}

/** A pane id, `@focused`, or a title/kind; none given means the pane this runs in, else the focused one. */
export async function resolvePane(client: DaemonClient, spec: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<Pane> {
  const state = await client.call<DaemonState>('state')
  const want = spec ?? env.PAGER_PANE
  const byId = want === undefined ? undefined : state.panes.find((p) => p.id === want)
  if (byId !== undefined) return byId
  if (want === undefined || want === '@focused') {
    const session = state.sessions.find((s) => s.id === state.activeSession) ?? state.sessions[0]
    const tab = session?.tabs.find((t) => t.id === session.activeTab) ?? session?.tabs[0]
    const pane = tab === undefined ? undefined : state.panes.find((p) => p.id === tab.focus)
    if (pane === undefined) throw new Error('no pane is focused')
    return pane
  }
  const lower = want.toLowerCase()
  const named = state.panes.filter((p) => p.title.toLowerCase() === lower || p.kind === lower)
  if (named.length === 1) return named[0]!
  throw new Error(named.length === 0 ? `no pane matches ${want}` : `${want} matches ${named.length} panes: use an id`)
}

/** `pager run` inside a daemon pane: a new shell pane beside this one, typing `command`. */
export async function runInDaemon(dir: string, req: { cwd: string; command?: string }): Promise<void> {
  const client = await dial(dir, false)
  try {
    const here = process.env.PAGER_PANE
    await client.call('pane.run', { cwd: req.cwd, ...(req.command === undefined ? {} : { command: req.command }), ...(here === undefined ? {} : { paneId: here }) })
  } finally {
    client.close()
  }
}

function printTree(state: DaemonState): void {
  const byId = new Map(state.panes.map((p) => [p.id, p]))
  const leaves = (n: DaemonState['sessions'][number]['tabs'][number]['root']): string[] => (n.type === 'pane' ? [n.paneId] : [...leaves(n.a), ...leaves(n.b)])
  for (const s of state.sessions) {
    out(`${s.id === state.activeSession ? '*' : ' '} session ${s.id}  ${s.name}`)
    for (const t of s.tabs) {
      out(`    ${t.id === s.activeTab ? '*' : ' '} tab ${t.id}  ${t.title}`)
      for (const id of leaves(t.root)) {
        const p = byId.get(id)
        if (p === undefined) continue
        out(`        ${id === t.focus ? '>' : ' '} pane ${p.id}  ${p.kind}  ${p.state}${p.exitCode === undefined ? '' : ` (${p.exitCode})`}  ${p.cols}x${p.rows}  ${p.title}  ${p.cwd}`)
      }
    }
  }
  if (state.sessions.length === 0) out('no sessions')
}

/** `PATH[:LINE[:COL]]`: the colon suffixes are position, not part of a Windows drive path. */
export function splitTarget(t: string): { path: string; line?: number; col?: number } {
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(t)
  const file = m?.[1] === '' || m?.[1] === undefined ? t : m[1]
  return { path: file, ...(m?.[2] === undefined ? {} : { line: Number(m[2]) }), ...(m?.[3] === undefined ? {} : { col: Number(m[3]) }) }
}

async function execute(args: DaemonArgs, dir: string): Promise<number> {
  switch (args.verb) {
    case 'daemon': {
      if (args.action === 'serve') return serve(dir)
      const paths = resolvePaths({ dir })
      if (args.action === 'start') {
        const { client, started, ms } = await connectOrStart(paths, { client: 'cli' })
        out(`${started ? 'started' : 'already running'}: daemon pid ${client.pid}, ${client.build}, ${Math.round(ms)} ms`)
        client.close()
        return 0
      }
      const client = await tryConnect(paths.address, { client: 'cli' })
      if (client === undefined) {
        out('the daemon is not running')
        return args.action === 'stop' ? 0 : 1
      }
      if (args.action === 'status') {
        const s = await client.call<Record<string, unknown>>('status')
        client.close()
        out(`running: pid ${String(s.pid)}, ${String(s.build)}, up ${Math.round(Number(s.uptimeMs) / 1000)} s`)
        out(`  address ${String(s.address)}`)
        out(`  ${String(s.running)}/${String(s.panes)} panes running, ${String(s.sessions)} session(s), ${String(s.windows)} window(s) attached`)
        out(`  state ${String(s.stateFile)}`)
        return 0
      }
      const closed = Promise.withResolvers<void>()
      client.once('close', () => closed.resolve())
      await client.call('daemon.stop')
      await Promise.race([closed.promise, sleep(8000)])
      const pid = client.pid
      client.close()
      if (await exited(pid, 10_000)) {
        out('daemon stopped')
        return 0
      }
      out(`the daemon (pid ${pid}) was asked to stop but is still running`)
      return 1
    }
    case 'serve': {
      const { runServe } = await import('../remote/cli.js') // the web server loads only for `pager serve`
      return runServe(args, dir)
    }
    case 'split': {
      const client = await dial(dir, true)
      try {
        const command = args.words.length === 0 ? undefined : args.words.join(' ')
        const cwd = args.cwd !== undefined ? path.resolve(args.cwd) : process.cwd()
        const base = { cwd, ...(args.kind === undefined ? {} : { kind: args.kind }), ...(command === undefined ? {} : { command }) }
        const target = await resolvePane(client, args.pane).catch(() => undefined)
        const made = target === undefined ? await client.call<{ paneId: string }>('tab.new', base) : await client.call<{ paneId: string }>('pane.split', { paneId: target.id, dir: args.dir, ...base })
        out(made.paneId)
      } finally {
        client.close()
      }
      return 0
    }
    case 'capture': {
      const client = await dial(dir, false)
      try {
        const pane = await resolvePane(client, args.pane)
        const r = await client.call<{ text: string }>('pane.capture', { paneId: pane.id, plain: !args.ansi, ...(args.lines === undefined ? {} : { lines: args.lines }) })
        out(args.json ? JSON.stringify({ paneId: pane.id, ...r }) : r.text)
      } finally {
        client.close()
      }
      return 0
    }
    case 'events': {
      const client = await dial(dir, false)
      const stop = Promise.withResolvers<void>()
      client.on('event', (ev) => out(JSON.stringify(ev)))
      client.once('close', () => stop.resolve())
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.resolve())
      await client.subscribe(args.filter.length === 0 ? DEFAULT_EVENTS : args.filter)
      await stop.promise
      client.close()
      return 0
    }
    case 'open': {
      const client = await dial(dir, true)
      try {
        const here = args.pane ?? process.env.PAGER_PANE
        for (const target of args.targets) {
          if (pageUrl(target) !== undefined) await client.call('open', { url: target })
          else {
            const t = splitTarget(target)
            await client.call('open', { ...t, path: path.resolve(t.path), tab: args.tab, ...(args.split === undefined ? {} : { dir: args.split }), ...(here === undefined ? {} : { paneId: here }) })
          }
        }
      } finally {
        client.close()
      }
      return 0
    }
    case 'ls': {
      const client = await dial(dir, false)
      const state = await client.call<DaemonState>('state')
      client.close()
      if (args.json) out(JSON.stringify({ ...state, settings: undefined }))
      else printTree(state)
      return 0
    }
    case 'send': {
      const client = await dial(dir, false)
      try {
        const pane = await resolvePane(client, args.pane)
        await client.call('pane.input', { paneId: pane.id, data: args.enter ? `${args.text}\r` : args.text })
      } finally {
        client.close()
      }
      return 0
    }
  }
}

/** Runs one daemon-facing command and returns its exit code. */
export async function runDaemonCommand(args: DaemonArgs, dir: string): Promise<number> {
  try {
    return await execute(args, dir)
  } catch (e) {
    process.stderr.write(`pager ${args.verb}: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}
