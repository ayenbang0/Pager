import assert from 'node:assert/strict'
import { test } from 'node:test'
import { replaceRange, setText } from '../input/inputBuffer.js'
import { completion, matchCommands, matchEmoji, menuItems, type AgentMenu } from './palette.js'

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

test('section names complete after "/settings "', () => {
  assert.deepEqual(matchCommands('/settings ap').map((c) => c.name), ['appearance'])
  assert.ok(matchCommands('/settings ').length >= 2)
  assert.deepEqual(matchCommands('/settings appearance x'), [])
})

test('agent names and subcommands complete after "/agent "', () => {
  assert.deepEqual(matchCommands('/agent cl', ['omp', 'claude']).map((c) => c.name), ['claude', 'cli'])
  assert.deepEqual(matchCommands('/agent cl').map((c) => c.name), ['cli'])
  assert.equal(matchCommands('/agent ', ['omp', 'claude']).length, 6)
  assert.deepEqual(matchCommands('/agent claude fix', ['claude']).length, 0)
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
  const [appearance] = matchCommands('/settings ap')
  assert.ok(group && invite && appearance)
  assert.equal(completion('/gr', group), '/group ')
  assert.equal(completion('/group i', invite), '/group invite ')
  assert.equal(completion('/settings ap', appearance), '/settings appearance ')
})

test('a :name fragment at the end offers emoji, prefix matches first', () => {
  const items = matchEmoji('great :fi')
  assert.equal(items[0]?.label, '🔥 :fire:')
  assert.equal(items[0]?.insert, '🔥 ')
  assert.deepEqual([items[0]?.from, items[0]?.to], [6, 9])
  assert.ok(items.length <= 6)
  assert.ok(matchEmoji(':fi').length > 0)
})

test('emoji suggestions need two characters after a colon at a word start and never appear on slash lines', () => {
  assert.deepEqual(matchEmoji(':'), [])
  assert.deepEqual(matchEmoji(':f'), [])
  assert.deepEqual(matchEmoji('a:fi'), [])
  assert.deepEqual(matchEmoji('12:30'), [])
  assert.deepEqual(matchEmoji(':fire: done'), [])
  assert.deepEqual(matchEmoji(':qzxqzx'), [])
  assert.deepEqual(matchEmoji('/name :fi'), [])
})

test('menuItems prefers the slash menu, honours the emoji switch and the cursor, and Tab-style replacement keeps the rest', () => {
  const commands = menuItems('/gr', 3, true)
  assert.equal(commands[0]?.label, '/group new|invite|members|leave')
  assert.equal(commands[0]?.insert, '/group ')
  assert.deepEqual(menuItems('hi :fi', 6, false), [])
  const [fire] = menuItems('hi :fi there', 6, true)
  assert.ok(fire)
  const next = replaceRange(setText('hi :fi there'), fire.from, fire.to, fire.insert)
  assert.equal(fire.insert, '🔥')
  assert.equal(next.text, 'hi 🔥 there')
  assert.equal(next.cursor, 'hi 🔥'.length)
  assert.deepEqual(menuItems('hi :fi there', 12, true), [])
})

const OMP: AgentMenu = {
  agent: 'omp',
  commands: [
    { name: 'usage', description: 'Provider limits' },
    { name: 'compact', description: 'Shrink context', hint: 'instructions' },
    { name: 'help', description: 'omp help' },
  ],
}

test("an agent tab's / menu lists pager commands first, then the agent's commands tagged with its name", () => {
  const items = menuItems('/', 1, false, [], OMP)
  const labels = items.map((i) => i.label)
  assert.equal(labels[0], '/help')
  assert.deepEqual(labels.slice(-3), ['/usage', '/compact <instructions>', '/agent omp /help'])
  const usage = items.find((i) => i.label === '/usage')
  assert.equal(usage?.summary, 'omp · Provider limits')
  assert.equal(usage?.insert, '/usage ')
})

test('typing narrows the agent commands, and a command that clashes with a pager command is reached through /agent <name> /cmd', () => {
  assert.deepEqual(menuItems('/us', 3, false, [], OMP).map((i) => i.label), ['/usage'])
  const help = menuItems('/hel', 4, false, [], OMP)
  assert.deepEqual(help.map((i) => i.label), ['/help', '/agent omp /help'])
  assert.equal(help[1]?.insert, '/agent omp /help ')
})

test('agent commands never show without an agent tab, after a space, or on plain text', () => {
  assert.deepEqual(menuItems('/us', 3, false), [])
  assert.deepEqual(menuItems('/usage x', 8, false, [], OMP), [])
  assert.deepEqual(menuItems('usage', 5, false, [], OMP), [])
})

test('/agent invite lists the contacts that match what was typed and completes the last word', () => {
  assert.deepEqual(matchCommands('/agent invite ', [], ['bob', 'ann']).map((c) => c.name), ['bob', 'ann'])
  assert.deepEqual(matchCommands('/agent invite B', [], ['bob', 'ann']).map((c) => c.name), ['bob'])
  assert.deepEqual(matchCommands('/agent invite ', [], []), [])
  assert.deepEqual(menuItems('/agent invite b', 15, false, [], undefined, ['bob']).map((i) => i.insert), ['/agent invite bob '])
  assert.equal(completion('/agent invite b', { name: 'bob', usage: '', summary: '' }), '/agent invite bob ')
  assert.equal(completion('/agent n', { name: 'new', usage: '', summary: '' }), '/agent new ')
})
