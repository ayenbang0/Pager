import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SOUND_NAMES, soundWav } from './sounds.js'

const RATE = 44_100
const NOTE_HZ = [783.99, 1174.66, 1567.98]
const NOTE_AT = [0, 0.16, 0.32]

/** Hann-windowed DFT magnitude of `samples` at `hz`. */
function magnitude(samples: readonly number[], hz: number): number {
  let re = 0
  let im = 0
  const n = samples.length
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    const angle = (2 * Math.PI * hz * i) / RATE
    re += (samples[i] ?? 0) * w * Math.cos(angle)
    im -= (samples[i] ?? 0) * w * Math.sin(angle)
  }
  return Math.hypot(re, im)
}

test('the chime preset is a soft, unclipped triangle-wave melody', () => {
  const wav = soundWav('chime')
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt32LE(40), wav.length - 44)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.readUInt32LE(24), RATE)
  const count = wav.readUInt32LE(40) / 2
  const samples: number[] = []
  for (let i = 0; i < count; i++) samples.push(wav.readInt16LE(44 + i * 2))
  const seconds = count / RATE
  assert.ok(seconds >= 0.5 && seconds <= 0.8, `duration ${seconds}`)
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  assert.ok(peak >= 0.9 * 32767 && peak <= 32767, `peak ${peak}`)
  const clipped = samples.filter((v) => Math.abs(v) > 0.98 * peak).length
  assert.ok(clipped / count < 0.02, `clipped ${clipped}`)
  const early = samples.slice(0, 44).reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  assert.ok(early < 0.25 * peak, `attack ${early}`)
  const rms = Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / count)
  assert.ok(rms > 0.15 * 32767, `rms ${rms}`)
  for (const [n, at] of NOTE_AT.entries()) {
    const from = Math.floor((at + 0.01) * RATE)
    const window = samples.slice(from, from + Math.floor(0.05 * RATE))
    const own = magnitude(window, NOTE_HZ[n] ?? 0)
    for (const [other, hz] of NOTE_HZ.entries()) if (other !== n) assert.ok(own > magnitude(window, hz), `note ${n} is not strongest at ${NOTE_HZ[n]}`)
  }
  const first = samples.slice(441, 2691)
  const f0 = NOTE_HZ[0] ?? 0
  const base = magnitude(first, f0)
  const third = magnitude(first, 3 * f0) / base
  assert.ok(third >= 0.06 && third <= 0.2, `3rd harmonic ratio ${third}`)
  const second = magnitude(first, 2 * f0) / base
  assert.ok(second < 0.05, `2nd harmonic ratio ${second}`)
})

test('every preset is a valid, normalised, unclipped WAV of a sensible length', () => {
  for (const name of SOUND_NAMES) {
    const wav = soundWav(name)
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF', name)
    const count = wav.readUInt32LE(40) / 2
    const seconds = count / RATE
    assert.ok(seconds >= 0.1 && seconds <= 3, `${name} lasts ${seconds}s`)
    let peak = 0
    for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(wav.readInt16LE(44 + i * 2)))
    assert.ok(peak >= 0.9 * 32767 && peak <= 32767, `${name} peak ${peak}`)
  }
})
