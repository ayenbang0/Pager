import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chimeWav } from './chime.js'

test('the chime is a valid loud WAV whose attack is sharp', () => {
  const wav = chimeWav()
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt32LE(40), wav.length - 44)
  const sample = (i: number): number => Math.abs(wav.readInt16LE(44 + i * 2))
  const count = wav.readUInt32LE(40) / 2
  let peak = 0
  for (let i = 0; i < count; i++) peak = Math.max(peak, sample(i))
  assert.ok(peak > 0.9 * 32767, `peak ${peak}`)
  // within 5 ms (220 samples) of the start the sound is already at more than half of its peak
  let early = 0
  for (let i = 0; i < 220; i++) early = Math.max(early, sample(i))
  assert.ok(early > 0.5 * peak, `early ${early}`)
  assert.ok(count / 44_100 < 0.9, 'short enough to stay a ping')
  let sum = 0
  for (let i = 0; i < count; i++) sum += sample(i) ** 2
  assert.ok(Math.sqrt(sum / count) > 0.25 * 32767, 'loud on average, not only at the peak')
})
