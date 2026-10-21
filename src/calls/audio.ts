import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { findBinary } from '../agents/run/adapters.js'

/** Calls carry 16 kHz mono signed 16-bit little-endian PCM. */
export const SAMPLE_RATE = 16_000
/** Bytes per chunk sent: 64 ms of audio. */
export const CHUNK_BYTES = 2048
const RAW = ['-t', 'raw', '-r', String(SAMPLE_RATE), '-e', 'signed', '-b', '16', '-c', '1']
const GLOBAL = ['-q', '--buffer', String(CHUNK_BYTES)]

export interface Mic {
  stop(): void
}

export interface Speaker {
  write(pcm: Buffer): void
  stop(): void
}

/** The microphone and the speakers, as raw PCM. */
export interface AudioIo {
  mic(onChunk: (pcm: Buffer) => void): Mic
  speaker(): Speaker
}

export const SOX_MISSING = 'Calls need SoX for the microphone and speakers: type /call setup to install it, then /call again'

/**
 * Where an install may have put SoX without this process's PATH knowing yet: winget's link folder and its package folder
 * (a portable install falls back to the latter when it cannot make links), and Homebrew's prefixes.
 */
function extraDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return ['/opt/homebrew/bin', '/usr/local/bin']
  const winget = path.join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet')
  const packages = path.join(winget, 'Packages')
  let installed: string[] = []
  try {
    installed = fs
      .readdirSync(packages)
      .filter((d) => d.startsWith('ChrisBagwell.SoX'))
      .flatMap((d) => fs.readdirSync(path.join(packages, d)).filter((s) => s.startsWith('sox')).map((s) => path.join(packages, d, s)))
  } catch {
    // no winget packages folder
  }
  return [path.join(winget, 'Links'), ...installed]
}

/** The SoX binary: on PATH, or where `/call setup` (or the user) just installed it. */
export function findSox(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  return findBinary('sox', { ...env, PATH: [env.PATH ?? env.Path ?? '', ...extraDirs(env, platform)].join(path.delimiter) })
}

/** SoX on the system's default recording and playback devices (`-d`), or why calls have no sound here. */
export async function soxAudio(): Promise<AudioIo | string> {
  const bin = await findSox()
  if (bin === undefined) return SOX_MISSING
  return {
    mic(onChunk) {
      const child = spawn(bin, [...GLOBAL, '-d', ...RAW, '-'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let rest = Buffer.alloc(0)
      child.on('error', () => undefined)
      child.stdout.on('data', (data: Buffer) => {
        rest = Buffer.concat([rest, data])
        while (rest.length >= CHUNK_BYTES) {
          onChunk(rest.subarray(0, CHUNK_BYTES))
          rest = rest.subarray(CHUNK_BYTES)
        }
      })
      return { stop: () => void child.kill() }
    },
    speaker() {
      const child = spawn(bin, [...GLOBAL, ...RAW, '-', '-d'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      child.on('error', () => undefined)
      child.stdin.on('error', () => undefined)
      return {
        write: (pcm) => void (child.stdin.writable && child.stdin.write(pcm)),
        stop: () => void child.kill(),
      }
    },
  }
}

/** The loudest sample of a chunk, 0..32768: below a small floor the chunk is silence and is not sent. */
export function peak(pcm: Buffer): number {
  let max = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)))
  return max
}
