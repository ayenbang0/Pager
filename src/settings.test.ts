import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DEFAULT_SETTINGS, loadSettings, parseBadge, saveSettings, type Settings } from './settings.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pager-s-'))

test('missing file yields defaults', () => {
  assert.deepEqual(loadSettings(tmp()), DEFAULT_SETTINGS)
})

test('saved settings round-trip and leave no temp file behind', () => {
  const dir = tmp()
  const saved: Settings = { theme: 'ocean', sidebar: false, accent: '#ff00aa', badge: '🚀', density: 'roomy', notify: false, sound: false }
  saveSettings(dir, saved)
  assert.deepEqual(loadSettings(dir), saved)
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
  assert.deepEqual(loadSettings(dir), { ...DEFAULT_SETTINGS, sidebar: false })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'MONO', sidebar: 'yes' }))
  assert.deepEqual(loadSettings(dir), { ...DEFAULT_SETTINGS, theme: 'mono' })
})

test('accent, badge and density are validated field by field', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ accent: 'Orange', badge: 'abc', density: 'huge', theme: 'neon' }))
  assert.deepEqual(loadSettings(dir), { ...DEFAULT_SETTINGS, theme: 'neon', accent: '#ff8a00' })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ accent: 'nope', badge: 'none', density: 'compact' }))
  assert.deepEqual(loadSettings(dir), { ...DEFAULT_SETTINGS, badge: 'none', density: 'compact' })
})

test('parseBadge accepts one symbol or emoji, auto and none; nothing else', () => {
  for (const ok of ['auto', 'none', '🚀', '❤️', '◆', '👩‍💻', '🇯🇵', ' ⚡ ']) assert.notEqual(parseBadge(ok), undefined, ok)
  assert.equal(parseBadge(' ⚡ '), '⚡')
  for (const bad of ['', 'ab', 'a', '7', '🚀🚀', ' ', '\n']) assert.equal(parseBadge(bad), undefined, JSON.stringify(bad))
})
