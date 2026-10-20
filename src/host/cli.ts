import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopArgs } from '../app/args.js'
import { sendControl } from '../app/control.js'
import { install } from './install.js'
import { realIo } from './io.js'
import { launch, type LaunchIo } from './launch.js'
import { hostPaths } from './paths.js'
import { status } from './status.js'
import { uninstall } from './uninstall.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'cli.js')
/** `desktop/` next to `dist/` in the repository, the npm package and the packed app. */
const assetsDir = path.join(here, '..', '..', 'desktop')

const say = (s: string): void => void process.stdout.write(s)

/** `pager desktop <action>`; the exit code. */
export async function runDesktop(a: DesktopArgs, dataDir: string): Promise<number> {
  if (process.platform !== 'win32') {
    process.stderr.write('The desktop host is Windows only\n')
    return 2
  }
  try {
    switch (a.action) {
      case 'install': {
        const r = await install({ node: process.execPath, cli, assetsDir, dataDir, ...(a.exe === undefined ? {} : { exe: path.resolve(a.exe) }) }, realIo)
        for (const [k, v] of Object.entries(r)) say(`${k}: ${String(v)}\n`)
        return 0
      }
      case 'uninstall': {
        const problems = await uninstall(dataDir, realIo)
        say(problems.length === 0 ? 'removed\n' : `removed, except:\n${problems.map((x) => `  ${x}`).join('\n')}\n`)
        return 0
      }
      case 'status':
        say(`${(await status(dataDir, realIo)).join('\n')}\n`)
        return 0
      case 'launch': {
        const io: LaunchIo = {
          send: (req) => sendControl(dataDir, req),
          spawnDetached(file, args) {
            const { promise, resolve, reject } = Promise.withResolvers<void>()
            const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
            child.once('error', reject)
            child.once('spawn', () => {
              child.unref()
              resolve()
            })
            return promise
          },
          exists: realIo.exists,
          read: realIo.read,
          print: (t) => void process.stderr.write(t),
          wt: hostPaths(process.env).wt,
        }
        return await launch({ node: process.execPath, cli, dataDir, ...(a.cwd === undefined ? {} : { cwd: path.resolve(a.cwd) }), ...(a.words === undefined ? {} : { words: a.words }), ...(a.solid === true ? { solid: true } : {}) }, io)
      }
    }
  } catch (e) {
    process.stderr.write(`pager desktop ${a.action}: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}
