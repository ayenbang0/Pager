import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completion, matchCommands } from './palette.js'

test('prefix matching on commands', () => {
  assert.deepEqual(matchCommands('/gr').map((c) => c.name), ['group'])
  assert.deepEqual(matchCommands('/a').map((c) => c.name), ['add', 'accept', 'agent'])
  assert.equal(matchCommands('/').length, 6)
})

test('group subcommands after "/group "', () => {
  assert.deepEqual(matchCommands('/group i').map((c) => c.name), ['invite'])
  assert.equal(matchCommands('/group ').length, 4)
  assert.deepEqual(matchCommands('/group invite bo'), [])
})

test('theme names complete after "/theme "', () => {
  assert.deepEqual(matchCommands('/theme mo').map((c) => c.name), ['mono'])
  assert.ok(matchCommands('/theme ').length >= 2)
  assert.deepEqual(matchCommands('/theme mono x'), [])
})

test('agent names and subcommands complete after "/agent "', () => {
  assert.deepEqual(matchCommands('/agent cl').map((c) => c.name), ['claude', 'cli'])
  assert.equal(matchCommands('/agent ').length, 6)
  assert.deepEqual(matchCommands('/agent claude fix').length, 0)
})

test('plain text, unknown commands and free-form arguments show nothing', () => {
  assert.deepEqual(matchCommands('hello'), [])
  assert.deepEqual(matchCommands('/add x'), [])
  assert.deepEqual(matchCommands('/constructor x'), [])
  assert.deepEqual(matchCommands('/__proto__ x'), [])
})

test('completion keeps the command prefix', () => {
  const [group] = matchCommands('/gr')
  const [invite] = matchCommands('/group i')
  const [mono] = matchCommands('/theme mo')
  assert.ok(group && invite && mono)
  assert.equal(completion('/gr', group), '/group ')
  assert.equal(completion('/group i', invite), '/group invite ')
  assert.equal(completion('/theme mo', mono), '/theme mono ')
})
