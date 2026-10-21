import { spawn } from 'node:child_process'
import { findBinary } from '../agents/run/adapters.js'
import { findSox } from './audio.js'

/** How this system gets SoX: a command pager runs for you, or what to type yourself (Linux needs sudo, which pager cannot answer). */
export type SoxInstaller = { bin: string; args: string[]; via: string } | { manual: string }

const LINUX: readonly (readonly [manager: string, command: string])[] = [
  ['apt-get', 'sudo apt install sox'],
  ['dnf', 'sudo dnf install sox'],
  ['pacman', 'sudo pacman -S sox'],
  ['zypper', 'sudo zypper install sox'],
  ['apk', 'sudo apk add sox'],
]

export async function soxInstaller(platform: NodeJS.Platform = process.platform): Promise<SoxInstaller> {
  // winget is an app alias in WindowsApps that a file check may not see; spawning it by name works, and a missing one fails there.
  if (platform === 'win32') return { bin: 'winget', args: ['install', '--id', 'ChrisBagwell.SoX', '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements'], via: 'winget' }
  if (platform === 'darwin') {
    const brew = (await findBinary('brew')) ?? (await findBinary('/opt/homebrew/bin/brew')) ?? (await findBinary('/usr/local/bin/brew'))
    return brew === undefined ? { manual: 'Install Homebrew (https://brew.sh), then run: brew install sox' } : { bin: brew, args: ['install', 'sox'], via: 'Homebrew' }
  }
  for (const [manager, command] of LINUX) if ((await findBinary(manager)) !== undefined) return { manual: `Run this in a terminal, then /call again: ${command}` }
  return { manual: 'Install sox with your package manager, then /call again' }
}

/** Runs the installer and checks the result by looking for SoX afterwards (winget exits non-zero when it was already there). */
export function installSox(plan: Extract<SoxInstaller, { bin: string }>): Promise<{ ok: boolean; detail: string }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; detail: string }>()
  let out = ''
  const keep = (data: Buffer): void => {
    out = (out + data.toString()).slice(-4000)
  }
  const finish = async (detail: string): Promise<void> => resolve((await findSox()) === undefined ? { ok: false, detail } : { ok: true, detail: '' })
  try {
    const child = spawn(plan.bin, plan.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', (err) => void finish(`${plan.via} did not start (${err.message})`))
    child.on('close', (code) => {
      // Progress bars redraw with \r: the last real line says what went wrong.
      const last = out.split(/[\r\n]+/).map((l) => l.replace(/\p{Cc}/gu, '').trim()).filter((l) => /\p{L}/u.test(l)).at(-1)
      void finish(last ?? `${plan.via} exited with code ${code}`)
    })
  } catch (err) {
    void finish(err instanceof Error ? err.message : String(err))
  }
  return promise
}
