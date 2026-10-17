import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameRows } from './frame.js'

test('Windows leaves the last row empty so frames never fill the console', () => {
  assert.equal(frameRows(24, 'win32'), 23)
  assert.equal(frameRows(24, 'linux'), 24)
  assert.equal(frameRows(24, 'darwin'), 24)
})
