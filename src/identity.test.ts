import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadOrCreateIdentity, saveName } from './identity.js'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pager-id-'))

test('identity is stable and saveName keeps the key', () => {
  const dir = tmp()
  const a = loadOrCreateIdentity(dir)
  const b = loadOrCreateIdentity(dir)
  assert.equal(a.pk, b.pk)
  assert.equal(a.pk.length, 64)
  saveName(dir, 'zed')
  const c = loadOrCreateIdentity(dir)
  assert.equal(c.pk, a.pk)
  assert.equal(c.name, 'zed')
})

test('corrupt identity.json throws and is left untouched', () => {
  const dir = tmp()
  const file = path.join(dir, 'identity.json')
  fs.writeFileSync(file, '{nope')
  assert.throws(() => loadOrCreateIdentity(dir), /corrupt/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{nope')
})
