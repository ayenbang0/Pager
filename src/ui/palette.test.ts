import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completion, matchCommands } from './palette.js'

test('prefix matching on commands', () => {
  assert.deepEqual(matchCommands('/gr').map((c) => c.name), ['group'])
  assert.deepEqual(matchCommands('/a').map((c) => c.name), ['add', 'accept'])
  assert.equal(matchCommands('/').length, 6)
})

test('group subcommands after "/group "', () => {
  assert.deepEqual(matchCommands('/group i').map((c) => c.name), ['invite'])
  assert.equal(matchCommands('/group ').length, 4)
  assert.deepEqual(matchCommands('/group invite bo'), [])
})

test('plain text and command arguments show nothing', () => {
  assert.deepEqual(matchCommands('hello'), [])
  assert.deepEqual(matchCommands('/add x'), [])
})

test('completion keeps the /group prefix', () => {
  const [group] = matchCommands('/gr')
  const [invite] = matchCommands('/group i')
  assert.ok(group && invite)
  assert.equal(completion('/gr', group), '/group ')
  assert.equal(completion('/group i', invite), '/group invite ')
})
