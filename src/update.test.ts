import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { CACHE_TTL_MS, isNewer, latestVersion } from './update.js'
import { removeTmpDirs, tmpDir } from './testutil.js'

const tmp = (): string => tmpDir('pager-u-')

test('isNewer compares numerically, not lexically, and ignores pre-release suffixes on the current version', () => {
  assert.ok(isNewer('0.10.0', '0.9.9'))
  assert.ok(isNewer('1.0.0', '0.99.99'))
  assert.ok(!isNewer('0.2.0', '0.2.0'))
  assert.ok(!isNewer('0.1.9', '0.2.0'))
  assert.ok(!isNewer('0.2.0', '0.2.0-beta.1'))
  assert.ok(isNewer('0.2.1', '0.2.0-beta.1'))
  assert.ok(!isNewer('latest', '0.2.0'))
})

test('the registry is asked once a day, and again when forced', async () => {
  const dir = tmp()
  let calls = 0
  const fetchLatest = async (): Promise<string> => (++calls, '0.3.0')
  assert.equal(await latestVersion(dir, { now: 1000, fetchLatest }), '0.3.0')
  assert.equal(await latestVersion(dir, { now: 2000, fetchLatest }), '0.3.0')
  assert.equal(calls, 1)
  await latestVersion(dir, { now: 2000, force: true, fetchLatest })
  assert.equal(calls, 2)
  await latestVersion(dir, { now: 2000 + CACHE_TTL_MS + 1, fetchLatest })
  assert.equal(calls, 3)
})

test('network failures and malformed answers yield undefined and cache nothing', async () => {
  const dir = tmp()
  assert.equal(await latestVersion(dir, { fetchLatest: () => Promise.reject(new Error('offline')) }), undefined)
  assert.equal(await latestVersion(dir, { fetchLatest: async () => '1.0.0; rm -rf /' }), undefined)
  assert.equal(fs.existsSync(path.join(dir, 'update.json')), false)
})

test('a corrupt cache file is ignored', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'update.json'), '{nope')
  assert.equal(await latestVersion(dir, { fetchLatest: async () => '0.4.0' }), '0.4.0')
})

after(removeTmpDirs)
