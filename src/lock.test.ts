import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { acquireLock, AlreadyRunningError } from './lock.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pager-lock-'))

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

test('an empty lock file (crash between create and write) is replaced', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'pager.lock'), '')
  acquireLock(dir)()
})
