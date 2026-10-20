import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'
import { DEFAULT_CONFIG, loadConfig, nextMaterial, saveConfig, stepFont, stepOpacity } from './config.js'

after(removeTmpDirs)

test('a missing or garbage file gives the defaults', () => {
  const dir = tmpDir('pager-cfg-')
  const file = path.join(dir, 'desktop.json')
  assert.deepEqual(loadConfig(file), DEFAULT_CONFIG)
  fs.writeFileSync(file, '{{not json')
  assert.deepEqual(loadConfig(file), DEFAULT_CONFIG)
  fs.writeFileSync(file, '[1,2]')
  assert.deepEqual(loadConfig(file), DEFAULT_CONFIG)
})

test('values are validated and clamped; valid ones round-trip', () => {
  const dir = tmpDir('pager-cfg-')
  const file = path.join(dir, 'desktop.json')
  fs.writeFileSync(file, JSON.stringify({ material: 'wood', opacity: 500, fontSize: 3 }))
  assert.deepEqual(loadConfig(file), { material: 'solid', opacity: 100, fontSize: 10 })
  const c = { material: 'mica', opacity: 35, fontSize: 18 } as const
  saveConfig(file, c)
  assert.deepEqual(loadConfig(file), c)
  assert.deepEqual(fs.readdirSync(dir), ['desktop.json'], 'no temp file left behind')
})

test('material cycles glass, mica, solid; opacity and font stay in range', () => {
  assert.deepEqual([nextMaterial('glass'), nextMaterial('mica'), nextMaterial('solid')], ['mica', 'solid', 'glass'])
  assert.equal(stepOpacity(60, 10), 70)
  assert.equal(stepOpacity(95, 10), 100)
  assert.equal(stepOpacity(15, -10), 10)
  assert.equal(stepFont(28, 1), 28)
  assert.equal(stepFont(10, -1), 10)
  assert.equal(stepFont(15, 1), 16)
})
