import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { HISTORY_MAX, loadHistory, saveHistory } from './history.js'
import { removeTmpDirs, tmpDir } from './testutil.js'

function withDir(fn: (dir: string) => void): void {
  const dir = tmpDir('pager-history-')
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('history round-trips and tolerates a missing or malformed file', () =>
  withDir((dir) => {
    assert.deepEqual(loadHistory(dir), [])
    saveHistory(dir, ['a', 'b'])
    assert.deepEqual(loadHistory(dir), ['a', 'b'])
    fs.writeFileSync(path.join(dir, 'history.json'), '{not json')
    assert.deepEqual(loadHistory(dir), [])
    fs.writeFileSync(path.join(dir, 'history.json'), '{"a":1}')
    assert.deepEqual(loadHistory(dir), [])
  }))

test('non-string entries are dropped and only the newest HISTORY_MAX are kept', () =>
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(['a', 1, null, 'b']))
    assert.deepEqual(loadHistory(dir), ['a', 'b'])
    const many = Array.from({ length: HISTORY_MAX + 5 }, (_, i) => `m${i}`)
    saveHistory(dir, many)
    const back = loadHistory(dir)
    assert.equal(back.length, HISTORY_MAX)
    assert.equal(back.at(-1), `m${HISTORY_MAX + 4}`)
    assert.equal(back[0], 'm5')
  }))

after(removeTmpDirs)
