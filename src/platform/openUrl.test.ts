import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'
import { openUrl } from './openUrl.js'

after(removeTmpDirs)

test('http(s) URLs are handed to the seam file; everything else is refused', () => {
  const file = path.join(tmpDir('pager-open-'), 'open.txt')
  process.env.PAGER_OPEN_FILE = file
  try {
    assert.equal(openUrl('https://example.com/a?b=c'), true)
    assert.equal(openUrl('http://example.com'), true)
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x', 'https://exa mple.com', 'https://x.com/\n', 'not a url', '']) assert.equal(openUrl(bad), false, bad)
    assert.equal(fs.readFileSync(file, 'utf8'), 'https://example.com/a?b=c\nhttp://example.com\n')
  } finally {
    delete process.env.PAGER_OPEN_FILE
  }
})
