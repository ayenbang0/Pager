import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RATE = 44_100
/** The old melody (a rising fifth, then a fourth) an octave lower: G5, D6, G6. */
const NOTES = [
  { at: 0, hz: 783.99 },
  { at: 0.16, hz: 1174.66 },
  { at: 0.32, hz: 1567.98 },
] as const
const NOTE_SECONDS = 0.26
const ATTACK_SECONDS = 0.006
const DECAY_SECONDS = 0.15
const RELEASE_SECONDS = 0.02
const PEAK = 0.99

/** The notification sound: a 16-bit mono WAV, a three-note melody on a triangle wave (soft, odd harmonics only), a short attack and a decay, never clipped. */
export function chimeWav(): Buffer {
  const total = Math.ceil((NOTES.at(-1)!.at + NOTE_SECONDS) * RATE)
  const mix = new Float64Array(total)
  for (const { at, hz } of NOTES) {
    const start = Math.floor(at * RATE)
    for (let i = 0; i < NOTE_SECONDS * RATE && start + i < total; i++) {
      const t = i / RATE
      const phase = hz * t
      const wave = 4 * Math.abs(phase - Math.floor(phase + 0.5)) - 1
      const env = Math.min(1, t / ATTACK_SECONDS) * Math.exp(-t / DECAY_SECONDS) * Math.min(1, (NOTE_SECONDS - t) / RELEASE_SECONDS)
      mix[start + i] = (mix[start + i] ?? 0) + wave * env
    }
  }
  const top = mix.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1
  const data = Buffer.alloc(total * 2)
  for (let i = 0; i < total; i++) data.writeInt16LE(Math.round(((mix[i] ?? 0) / top) * PEAK * 32767), i * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(RATE, 24)
  head.writeUInt32LE(RATE * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** Path of the chime file, written to the temp dir on first use. Undefined when it cannot be written (the caller falls back to a system sound). */
export function chimePath(): string | undefined {
  const file = path.join(os.tmpdir(), 'pager-chime-4.wav')
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, chimeWav())
    return file
  } catch {
    return undefined
  }
}
