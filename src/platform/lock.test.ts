import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { acquireLock, AlreadyRunningError } from './lock.js'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'

const tmp = (): string => tmpDir('pager-lock-')

test('second acquire on the same dir throws', () => {
  const dir = tmp()
  const release = acquireLock(dir)
  assert.throws(() => acquireLock(dir), AlreadyRunningError)
  release()
  acquireLock(dir)()
})

test('a lock held by a dead pid is replaced', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'pager.lock'), '2147483646')
  const release = acquireLock(dir)
  assert.equal(fs.readFileSync(path.join(dir, 'pager.lock'), 'utf8'), String(process.pid))
  release()
})

test('an old empty lock file (crash between create and write) is replaced', () => {
  const dir = tmp()
  const file = path.join(dir, 'pager.lock')
  fs.writeFileSync(file, '')
  const old = new Date(Date.now() - 10_000)
  fs.utimesSync(file, old, old)
  acquireLock(dir)()
})

test('a fresh empty lock file may be mid-creation by a live process', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'pager.lock'), '')
  assert.throws(() => acquireLock(dir), AlreadyRunningError)
})

after(removeTmpDirs)
