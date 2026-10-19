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

test('emojiMatches puts the exact name first, then prefix matches, then substring matches; shorter names first', () => {
  const names = emojiMatches('fi', 40).map((m) => m.name)
  assert.equal(names[0], 'fire')
  assert.ok(names.includes('fist'))
  assert.ok(names.indexOf('fist') > names.indexOf('fire'))
  const prefixCount = names.filter((n) => n.startsWith('fi')).length
  const prefixed = names.slice(0, prefixCount)
  assert.deepEqual(prefixed, [...prefixed].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)))
  assert.ok(names.slice(prefixCount).every((n) => n.includes('fi') && !n.startsWith('fi')))
  assert.deepEqual(emojiMatches('fire')[0], { name: 'fire', char: '🔥' })
  assert.equal(emojiMatches('heart')[0]?.name, 'heart')
})

test('the table has about 500 well-formed shortcodes, each new glyph a single code point with no duplicates', () => {
  const names = Object.keys(EMOJI)
  assert.ok(names.length >= 480, `${names.length} names`)
  for (const name of names) assert.match(name, /^[a-z0-9_+-]{2,24}$/, name)
  assert.equal(new Set(names).size, names.length)
  // The first 123 names are the original table (several carry variation selectors); everything added later is one code point.
  const added = names.slice(123)
  assert.ok(added.length >= 357)
  const seen = new Map<string, string>()
  for (const name of Object.keys(EMOJI).slice(0, 123)) seen.set(EMOJI[name] ?? '', name)
  for (const name of added) {
    const glyph = EMOJI[name] ?? ''
    assert.equal([...glyph].length, 1, `${name} ${glyph}`)
    assert.ok(!seen.has(glyph), `${name} duplicates ${seen.get(glyph)}`)
    seen.set(glyph, name)
  }
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
