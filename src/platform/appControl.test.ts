import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blockedFile, startError } from './appControl.js'

// The text Windows put in the error when it refused sodium-native.node (CodeIntegrity event 3077).
const native = 'An Application Control policy has blocked this file.\n  \\\\?\\C:\\app\\node_modules\\sodium-native\\prebuilds\\win32-x64\\sodium-native.node'

test('the blocked file is found in the error or in its causes, without the \\\\?\\ prefix', () => {
  const file = 'C:\\app\\node_modules\\sodium-native\\prebuilds\\win32-x64\\sodium-native.node'
  assert.equal(blockedFile(new Error(native)), file)
  assert.equal(blockedFile(new Error('wrapper', { cause: new Error('mid', { cause: new Error(native) }) })), file)
})

test('other errors and non-errors name no file', () => {
  assert.equal(blockedFile(new Error('ENOENT: no such file')), undefined)
  assert.equal(blockedFile('An Application Control policy has blocked this file.\n  x'), undefined)
  assert.equal(blockedFile(undefined), undefined)
})

test('startError explains a block and passes other messages through', () => {
  assert.match(startError(new Error(native)), /^Windows Smart App Control blocked C:\\app\\node_modules\\sodium-native\\.*sodium-native\.node\. /)
  assert.equal(startError(new Error('disk full')), 'disk full')
  assert.equal(startError('plain'), 'plain')
})
