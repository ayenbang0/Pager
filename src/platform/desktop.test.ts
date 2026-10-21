import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { CHIME_GAP_MS, desktopNotify, DUPLICATE_WINDOW_MS, resetDesktopState } from './desktop.js'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'

const T0 = 100_000
let file = ''
const env = (): NodeJS.ProcessEnv => ({ PAGER_NOTIFY_FILE: file })
const lines = (): { title: string; body: string; sound: boolean }[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

beforeEach(() => {
  resetDesktopState()
  file = path.join(tmpDir('pager-n-'), 'alerts.jsonl')
})

test('an alert is recorded with its chime, control characters stripped and long text cut', () => {
  assert.equal(desktopNotify({ title: 'a\u0007b', body: 'x'.repeat(500), sound: 'chime' }, T0, env()), 'shown')
  const [alert] = lines()
  assert.equal(alert?.title, 'a b')
  assert.equal(alert?.body.length, 200)
  assert.equal(alert?.sound, true)
})

test('a burst shares one chime, and an identical alert inside the window is dropped', () => {
  desktopNotify({ title: 'ann', body: 'one', sound: 'chime' }, T0, env())
  desktopNotify({ title: 'ann', body: 'two', sound: 'chime' }, T0 + CHIME_GAP_MS - 1, env())
  desktopNotify({ title: 'ann', body: 'three', sound: 'chime' }, T0 + CHIME_GAP_MS, env())
  assert.deepEqual(lines().map((l) => l.sound), [true, false, true])
  assert.equal(desktopNotify({ title: 'ann', body: 'three', sound: 'chime' }, T0 + CHIME_GAP_MS + DUPLICATE_WINDOW_MS - 1, env()), 'duplicate')
  assert.equal(desktopNotify({ title: 'ann', body: 'three', sound: 'chime' }, T0 + CHIME_GAP_MS + DUPLICATE_WINDOW_MS, env()), 'shown')
})

test('sound off never chimes; PAGER_NO_NOTIFY and the test runner without the seam do nothing', () => {
  desktopNotify({ title: 'ann', body: 'quiet', sound: undefined }, T0, env())
  assert.equal(lines()[0]?.sound, false)
  assert.equal(desktopNotify({ title: 'a', body: 'b', sound: 'chime' }, T0 + 50_000, { ...env(), PAGER_NO_NOTIFY: '1' }), 'off')
  assert.equal(desktopNotify({ title: 'a', body: 'b', sound: 'chime' }, T0 + 50_000, { NODE_TEST_CONTEXT: 'child-v8' }), 'off')
  assert.equal(lines().length, 1)
})

after(removeTmpDirs)
