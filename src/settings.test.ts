import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pager-s-'))

test('missing file yields defaults', () => {
  assert.deepEqual(loadSettings(tmp()), DEFAULT_SETTINGS)
})

test('saved settings round-trip and leave no temp file behind', () => {
  const dir = tmp()
  saveSettings(dir, { theme: 'ocean', sidebar: false })
  assert.deepEqual(loadSettings(dir), { theme: 'ocean', sidebar: false })
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
})

test('corrupt JSON yields defaults instead of throwing', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'settings.json'), '{not json')
  assert.deepEqual(loadSettings(dir), DEFAULT_SETTINGS)
})

test('invalid fields fall back individually and keep the valid ones', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'nope', sidebar: false }))
  assert.deepEqual(loadSettings(dir), { theme: DEFAULT_SETTINGS.theme, sidebar: false })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'MONO', sidebar: 'yes' }))
  assert.deepEqual(loadSettings(dir), { theme: 'mono', sidebar: DEFAULT_SETTINGS.sidebar })
})
