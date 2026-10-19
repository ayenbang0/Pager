import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { loadOrCreateIdentity, saveName } from './identity.js'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'

const tmp = (): string => tmpDir('pager-id-')

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

test('a stored name that no hello frame would accept falls back to the default', () => {
  for (const bad of ['', 'x'.repeat(80), 'bell\x07']) {
    const dir = tmp()
    const file = path.join(dir, 'identity.json')
    loadOrCreateIdentity(dir)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...data, name: bad }))
    const name = loadOrCreateIdentity(dir).name
    assert.ok(name.length > 0 && name.length <= 64 && !/\p{Cc}/u.test(name), JSON.stringify(bad))
  }
})

after(removeTmpDirs)
