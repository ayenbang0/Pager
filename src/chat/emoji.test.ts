import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMOJI, emojiMatches, expandEmoji } from './emoji.js'

test('known shortcodes expand and aliases share a character', () => {
  assert.equal(expandEmoji('ship it :rocket: now'), 'ship it 🚀 now')
  assert.equal(expandEmoji(':cry:'), '😭')
  assert.equal(EMOJI.sob, EMOJI.cry)
  assert.equal(expandEmoji(':100: :+1:'), '💯 👍')
})

test('unknown names and stray colons are left as typed', () => {
  assert.equal(expandEmoji('look :nope: here'), 'look :nope: here')
  assert.equal(expandEmoji('12:30:45 and a::b and :: and : x :'), '12:30:45 and a::b and :: and : x :')
  assert.equal(expandEmoji(':a:'), ':a:')
  assert.equal(expandEmoji(':FIRE:'), ':FIRE:')
  assert.equal(expandEmoji('no colons'), 'no colons')
})

test('adjacent shortcodes both expand, and an unknown one does not swallow the next', () => {
  assert.equal(expandEmoji(':fire::cry:'), '🔥😭')
  assert.equal(expandEmoji(':fire::fire::fire:'), '🔥🔥🔥')
  assert.equal(expandEmoji(':nope:fire:'), ':nope🔥')
})

test('inline code and fenced blocks are untouched, text around them still expands', () => {
  assert.equal(expandEmoji('use `:fire:` or :fire:'), 'use `:fire:` or 🔥')
  assert.equal(expandEmoji(':cry: ```\n:fire:\n``` :cry:'), '😭 ```\n:fire:\n``` 😭')
  assert.equal(expandEmoji('x ```\n:fire: never closed'), 'x ```\n:fire: never closed')
  assert.equal(expandEmoji('`a` :fire: `b :cry:`'), '`a` 🔥 `b :cry:`')
})

test('emojiMatches puts prefix matches before substring matches, alphabetical within each', () => {
  const names = emojiMatches('fi').map((m) => m.name)
  assert.equal(names[0], 'fire')
  assert.ok(names.includes('fist'))
  assert.ok(names.indexOf('fist') > names.indexOf('fire'))
  const prefixCount = names.filter((n) => n.startsWith('fi')).length
  assert.deepEqual(names.slice(0, prefixCount), [...names.slice(0, prefixCount)].sort())
  assert.ok(names.slice(prefixCount).every((n) => n.includes('fi') && !n.startsWith('fi')))
  assert.deepEqual(emojiMatches('fire'), [
    { name: 'fire', char: '🔥' },
  ])
})

test('emojiMatches honours the limit, ignores case and finds nothing for gibberish', () => {
  assert.equal(emojiMatches('s', 3).length, 3)
  assert.equal(emojiMatches('s').length, 8)
  assert.equal(emojiMatches('FIRE')[0]?.name, 'fire')
  assert.deepEqual(emojiMatches('qzxqzx'), [])
})

test('every table entry is reachable: lowercase, 2..24 characters of the shortcode alphabet', () => {
  for (const [name, char] of Object.entries(EMOJI)) {
    assert.match(name, /^[a-z0-9_+-]{2,24}$/, name)
    assert.equal(expandEmoji(`:${name}:`), char, name)
  }
})
