import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'
import { findSox } from './audio.js'

after(removeTmpDirs)

/** `/call setup` runs winget, which updates the user's PATH for new terminals only: pager must still find SoX right away. */
test('SoX is found in winget folders a running process does not have on PATH yet', async () => {
  const local = tmpDir('pager-sox-')
  const exe = process.platform === 'win32' ? 'sox.exe' : 'sox'
  const env = { LOCALAPPDATA: local, PATH: '', PATHEXT: '.exe' }
  assert.equal(await findSox(env, 'win32'), undefined)
  const packaged = path.join(local, 'Microsoft', 'WinGet', 'Packages', 'ChrisBagwell.SoX_Microsoft.Winget.Source_8wekyb3d8bbwe', 'sox-14.4.2')
  fs.mkdirSync(packaged, { recursive: true })
  fs.writeFileSync(path.join(packaged, exe), '')
  assert.equal(await findSox(env, 'win32'), path.join(packaged, exe))
  const links = path.join(local, 'Microsoft', 'WinGet', 'Links')
  fs.mkdirSync(links, { recursive: true })
  fs.writeFileSync(path.join(links, exe), '')
  assert.equal(await findSox(env, 'win32'), path.join(links, exe), 'the link folder comes first')
})
