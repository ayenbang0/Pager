import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { selftest } from './selftest.js'

export interface ExecResult {
  code: number
  out: string
}

/** Every side effect of install, uninstall and status, so they can be tested without touching the registry or COM. */
export interface InstallIo {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists(p: string): boolean
  read(p: string): string | undefined
  mkdir(p: string): void
  write(p: string, data: string): void
  copy(from: string, to: string): void
  /** Recursive and forgiving: a missing path is fine. A locked file throws. */
  remove(p: string): void
  exec(file: string, args: string[], env?: Record<string, string>): Promise<ExecResult>
  selftest(exe: string): Promise<{ ok: boolean; reason?: string }>
}

export const realIo: InstallIo = {
  platform: process.platform,
  env: process.env,
  // lstat, not existsSync: Store app aliases such as wt.exe are reparse points that stat() cannot follow.
  exists(p) {
    try {
      fs.lstatSync(p)
      return true
    } catch {
      return false
    }
  },
  read(p) {
    try {
      return fs.readFileSync(p, 'utf8')
    } catch {
      return undefined
    }
  },
  mkdir: (p) => void fs.mkdirSync(p, { recursive: true }),
  write(p, data) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, data) // UTF-8, no BOM: Windows Terminal rejects a BOM in fragments
  },
  copy(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  },
  remove: (p) => fs.rmSync(p, { recursive: true, force: true }),
  exec(file, args, env) {
    const { promise, resolve } = Promise.withResolvers<ExecResult>()
    execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1
      resolve({ code, out: `${stdout}${stderr}`.trim() })
    })
    return promise
  },
  selftest: (exe) => selftest(exe),
}
