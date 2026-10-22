import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RATE = 44_100
const ATTACK_SECONDS = 0.006
const RELEASE_SECONDS = 0.02
const PEAK = 0.99

type Wave = 'triangle' | 'sine' | 'square' | 'bell'

interface Tone {
  /** Start, seconds. */
  at: number
  hz: number
  /** Length, seconds. */
  len: number
  /** A second frequency sounded with the first (the two-tone phone ring). */
  hz2?: number
  /** Glides from `hz` to this by the end of the tone. */
  to?: number
}

interface Preset {
  wave: Wave
  /** Seconds for the volume to fall to 1/e. */
  decay: number
  tones: readonly Tone[]
}

const repeat = (times: number, every: number, tone: Omit<Tone, 'at'>): Tone[] => Array.from({ length: times }, (_, i) => ({ ...tone, at: i * every }))

/** The sound presets for messages, pings and calls. `chime` is the classic: a rising fifth then a fourth on a soft triangle wave. */
const PRESETS = {
  chime: { wave: 'triangle', decay: 0.15, tones: [{ at: 0, hz: 783.99, len: 0.26 }, { at: 0.16, hz: 1174.66, len: 0.26 }, { at: 0.32, hz: 1567.98, len: 0.26 }] },
  bell: { wave: 'bell', decay: 0.45, tones: [{ at: 0, hz: 1046.5, len: 1.1 }] },
  pop: { wave: 'sine', decay: 0.05, tones: [{ at: 0, hz: 420, len: 0.14, to: 1300 }] },
  blip: { wave: 'square', decay: 0.07, tones: [{ at: 0, hz: 880, len: 0.09 }, { at: 0.1, hz: 1318.5, len: 0.12 }] },
  marimba: { wave: 'sine', decay: 0.09, tones: [{ at: 0, hz: 659.25, len: 0.3 }, { at: 0.12, hz: 783.99, len: 0.3 }, { at: 0.24, hz: 1046.5, len: 0.4 }] },
  doorbell: { wave: 'sine', decay: 0.5, tones: [{ at: 0, hz: 659.25, len: 0.7 }, { at: 0.5, hz: 523.25, len: 1 }] },
  trill: { wave: 'triangle', decay: 0.2, tones: repeat(8, 0.055, { hz: 1318.5, len: 0.05 }).map((t, i) => (i % 2 === 1 ? { ...t, hz: 1567.98 } : t)) },
  ring: { wave: 'sine', decay: 10, tones: [...repeat(2, 0.5, { hz: 440, hz2: 480, len: 0.4 }), ...repeat(2, 0.5, { hz: 440, hz2: 480, len: 0.4 }).map((t) => ({ ...t, at: t.at + 1.4 }))] },
} satisfies Record<string, Preset>

export type SoundName = keyof typeof PRESETS
export const SOUND_NAMES = Object.keys(PRESETS) as SoundName[]
export const isSoundName = (v: unknown): v is SoundName => typeof v === 'string' && Object.hasOwn(PRESETS, v)

function sample(wave: Wave, phase: number): number {
  if (wave === 'triangle') return 4 * Math.abs(phase - Math.floor(phase + 0.5)) - 1
  if (wave === 'square') return phase - Math.floor(phase) < 0.5 ? 0.6 : -0.6
  if (wave === 'bell') return Math.sin(2 * Math.PI * phase) + 0.5 * Math.sin(2 * Math.PI * phase * 2.76) + 0.25 * Math.sin(2 * Math.PI * phase * 5.4)
  return Math.sin(2 * Math.PI * phase)
}

/** A preset as a 16-bit mono WAV: each tone with a short attack, an exponential decay and a release, normalised and never clipped. */
export function soundWav(name: SoundName): Buffer {
  const { wave, decay, tones }: Preset = PRESETS[name]
  const total = Math.ceil(Math.max(...tones.map((t) => t.at + t.len)) * RATE)
  const mix = new Float64Array(total)
  for (const tone of tones) {
    const start = Math.floor(tone.at * RATE)
    for (let i = 0; i < tone.len * RATE && start + i < total; i++) {
      const t = i / RATE
      // The phase of a glide is the integral of a linearly moving frequency.
      const phase = tone.hz * t + (tone.to === undefined ? 0 : ((tone.to - tone.hz) * t * t) / (2 * tone.len))
      const value = sample(wave, phase) + (tone.hz2 === undefined ? 0 : sample(wave, tone.hz2 * t))
      const env = Math.min(1, t / ATTACK_SECONDS) * Math.exp(-t / decay) * Math.min(1, (tone.len - t) / RELEASE_SECONDS)
      mix[start + i] = (mix[start + i] ?? 0) + value * env
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

/** Path of a preset's WAV, written to the temp dir on first use. Undefined when it cannot be written (the caller falls back to a system sound). */
export function soundPath(name: SoundName): string | undefined {
  const file = path.join(os.tmpdir(), `pager-sound-${name}-1.wav`)
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, soundWav(name))
    return file
  } catch {
    return undefined
  }
}
