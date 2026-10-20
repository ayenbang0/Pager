import type { ControlRequest, SendResult } from '../app/control.js'
import { HOST_FILE, type HostRecord } from './install.js'
import type { PassArgs } from './wt.js'
import { passArgs, wtArgs } from './wt.js'
import path from 'node:path'

export interface LaunchIo {
  send(req: ControlRequest): Promise<SendResult>
  /** Starts a program that outlives us; rejects when it cannot start. */
  spawnDetached(file: string, args: string[]): Promise<void>
  exists(p: string): boolean
  read(p: string): string | undefined
  print(text: string): void
  wt: string
}

export interface LaunchOptions extends PassArgs {
  glass?: boolean
  node: string
  cli: string
  dataDir: string
}

export function readHost(dataDir: string, io: Pick<LaunchIo, 'read'>): HostRecord | undefined {
  const raw = io.read(path.join(dataDir, HOST_FILE))
  if (raw === undefined) return undefined
  try {
    const r = JSON.parse(raw) as Partial<HostRecord>
    return r.host === 'exe' || r.host === 'wt' ? { host: r.host, ...(typeof r.exe === 'string' ? { exe: r.exe } : {}) } : undefined
  } catch {
    return undefined
  }
}

/**
 * Opens the glass window, or reuses it: the own-window host is single-instance and forwards the request itself; with
 * Windows Terminal, a live pager takes the request over its control pipe, else a new `pager` window is started.
 */
export async function launch(o: LaunchOptions, io: LaunchIo): Promise<number> {
  const host = readHost(o.dataDir, io)
  try {
    if (host?.host === 'exe' && host.exe !== undefined && io.exists(host.exe)) {
      await io.spawnDetached(host.exe, passArgs(o))
      return 0
    }
    const live = await io.send({ type: 'ping' })
    if (live.kind === 'ok') {
      const words = o.words ?? []
      if (o.cwd !== undefined || words.length > 0) {
        const r = await io.send({ type: 'run', ...(o.cwd === undefined ? {} : { cwd: o.cwd }), ...(words.length === 0 ? {} : { command: words.join(' ') }) })
        if (r.kind === 'ok' && !r.reply.ok) {
          io.print(`${r.reply.error}\n`)
          return 1
        }
      }
      // Best effort: bring the window forward.
      await io.spawnDetached(io.wt, ['-w', 'pager', 'focus-tab', '-t', '0']).catch(() => {})
      return 0
    }
    await io.spawnDetached(io.wt, wtArgs(o))
    return 0
  } catch (e) {
    io.print(`pager desktop launch: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}
