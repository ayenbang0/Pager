import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { DEFAULT_SETTINGS, loadSettings, parseBadge, saveSettings, type Settings } from './settings.js'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'

const tmp = (): string => tmpDir('pager-s-')

test('missing file yields defaults', () => {
  assert.deepEqual(loadSettings(tmp()), DEFAULT_SETTINGS)
})

test('saved settings round-trip and leave no temp file behind', () => {
  const dir = tmp()
  const saved: Settings = { theme: 'ocean', sidebar: false, accent: '#ff00aa', badge: '🚀', density: 'roomy', notify: false, soundMode: 'pings', notifySound: 'pop', ringSound: 'doorbell', lastSeenVersion: '1.0.0', reduceMotion: true, mouse: false, alerts: false, updateCheck: false, acp: false, web: false, agents: false, lan: true, folders: [{ name: 'work', ids: ['a', 'b'] }], collapsed: ['direct'] }
  saveSettings(dir, saved)
  assert.deepEqual(loadSettings(dir), saved)
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
})

test('the old sound switch becomes a sound mode; unknown presets fall back', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ sound: false, notifySound: 'kazoo' }))
  assert.deepEqual([loadSettings(dir).soundMode, loadSettings(dir).notifySound], ['off', 'chime'])
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ sound: true }))
  assert.equal(loadSettings(dir).soundMode, 'all')
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

test('folders: duplicates, bad names, an id in two folders and limits are normalized', () => {
  const dir = tmp()
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, ids: [] }))
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      folders: [
        { name: 'Work', ids: ['a', 'b', 'a', 7, ''] },
        { name: 'work', ids: ['c'] },
        { name: 'Home', ids: ['b', 'd'] },
        { name: '', ids: [] },
        { name: 'x'.repeat(25), ids: [] },
        { name: 'bell\x07', ids: [] },
        { name: 'nope' },
        'text',
      ],
      collapsed: ['direct', 'direct', 3, 'x'.repeat(41), 'folder:Work'],
    }),
  )
  const s = loadSettings(dir)
  assert.deepEqual(s.folders, [{ name: 'Work', ids: ['a', 'b'] }, { name: 'Home', ids: ['d'] }])
  assert.deepEqual(s.collapsed, ['direct', 'folder:Work'])
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ folders: many }))
  assert.equal(loadSettings(dir).folders.length, 12)
})

test('bad types for the new fields fall back to the defaults', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mouse: 'no', web: 1, folders: 'x', collapsed: {}, lan: true }))
  assert.deepEqual(loadSettings(dir), { ...DEFAULT_SETTINGS, lan: true })
})

after(removeTmpDirs)
