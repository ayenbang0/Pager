import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dmConvId, newGroupId } from './convId.js'

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)

test('dmConvId is symmetric and shaped dm:<32 hex>', () => {
  assert.equal(dmConvId(A, B), dmConvId(B, A))
  assert.match(dmConvId(A, B), /^dm:[0-9a-f]{32}$/)
  assert.notEqual(dmConvId(A, B), dmConvId(A, A))
})

test('newGroupId is unique and shaped grp:<32 hex>', () => {
  const a = newGroupId()
  assert.match(a, /^grp:[0-9a-f]{32}$/)
  assert.notEqual(a, newGroupId())
})
