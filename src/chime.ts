import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RATE = 44_100
/** Three bright pings climbing a fifth: G6, D7, G7. */
const PINGS = [
  { at: 0, hz: 1568 },
  { at: 0.15, hz: 2349 },
  { at: 0.3, hz: 3136 },
] as const
const PING_SECONDS = 0.34
const ATTACK_SECONDS = 0.0008
const DECAY_SECONDS = 0.12
const PEAK = 0.99
/** Soft-clipping drive: pushes the average level (what is heard as loudness) far above what the peak alone gives. */
const DRIVE = 4
/** Strength of the 2nd and 3rd harmonics: they are what makes the ping sharp rather than a soft beep. */
const HARMONICS = [1, 0.45, 0.22]

/** The notification sound: a 16-bit mono WAV, a near-instant attack and a short decay, loud and high so it cuts through. */
export function chimeWav(): Buffer {
  const total = Math.ceil((PINGS.at(-1)!.at + PING_SECONDS) * RATE)
  const mix = new Float64Array(total)
  for (const { at, hz } of PINGS) {
    const start = Math.floor(at * RATE)
    for (let i = 0; i < PING_SECONDS * RATE && start + i < total; i++) {
      const t = i / RATE
      const env = Math.min(1, t / ATTACK_SECONDS) * Math.exp(-t / DECAY_SECONDS)
      let s = 0
      for (const [h, amp] of HARMONICS.entries()) s += amp * Math.sin(2 * Math.PI * hz * (h + 1) * t)
      mix[start + i] = (mix[start + i] ?? 0) + s * env
    }
  }
  const top0 = mix.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1
  for (let i = 0; i < total; i++) mix[i] = Math.tanh((DRIVE * (mix[i] ?? 0)) / top0)
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
  const file = path.join(os.tmpdir(), 'pager-chime-3.wav')
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, chimeWav())
    return file
  } catch {
    return undefined
  }
}
