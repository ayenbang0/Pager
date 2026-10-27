import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startFailure } from './chatsFailure.js'

test('a blocked native addon is named, not dumped as a file URL', () => {
  const cause = new Error('An Application Control policy has blocked this file.')
  const e = new Error("Cannot load addon 'file:///C:/app/node_modules/sodium-native/prebuilds/win32-x64/sodium-native.node'", { cause })
  const text = startFailure(e)
  assert.match(text, /^Windows blocked sodium-native\.node/)
  assert.match(text, /daemon restarts/)
  assert.doesNotMatch(text, /file:\/\//)
})

test('other failures keep their own message', () => {
  assert.equal(startFailure(new Error('EADDRINUSE')), 'Chat could not start: EADDRINUSE')
  assert.equal(startFailure('boom'), 'Chat could not start: boom')
  assert.equal(startFailure(new Error('x', { cause: new Error('disk full') })), 'Chat could not start: x')
})
