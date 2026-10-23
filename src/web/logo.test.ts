import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { LOGO_MARK_SVG, LOGO_SVG } from './logo.js'

const asset = (name: string): string => fs.readFileSync(new URL(`../../desktop/assets/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n').trimEnd()

test('the embedded logos are the desktop assets', () => {
  assert.equal(LOGO_SVG, asset('pager.svg'))
  assert.equal(LOGO_MARK_SVG, asset('pager-mark.svg'))
  assert.match(LOGO_SVG, /<rect width="64" height="64"/)
  assert.doesNotMatch(LOGO_MARK_SVG, /<rect width="64"/)
})
