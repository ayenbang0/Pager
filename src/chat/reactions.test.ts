import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REACT_PREFIX } from './ops.js'
import { encodeReaction, foldReactions, isReactionEmoji, parseReaction, QUICK_REACTIONS } from './reactions.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

test('encode and parse round-trip', () => {
  const body = encodeReaction('+', { author: A, seq: 7 }, '🔥')
  assert.ok(body.startsWith(REACT_PREFIX))
  assert.deepEqual(parseReaction(body), { op: '+', author: A, seq: 7, emoji: '🔥' })
  assert.deepEqual(parseReaction(encodeReaction('-', { author: B, seq: 123456789 }, '👩‍💻')), { op: '-', author: B, seq: 123456789, emoji: '👩‍💻' })
  for (const e of QUICK_REACTIONS) assert.ok(parseReaction(encodeReaction('+', { author: A, seq: 1 }, e)))
})

test('malformed bodies are rejected', () => {
  const ok = encodeReaction('+', { author: A, seq: 1 }, '🔥')
  assert.equal(parseReaction('plain text'), undefined)
  assert.equal(parseReaction(ok.replace('+', '*')), undefined)
  assert.equal(parseReaction(REACT_PREFIX + '+:short:1:🔥'), undefined)
  assert.equal(parseReaction(REACT_PREFIX + `+:${A}:x:🔥`), undefined)
  assert.equal(parseReaction(REACT_PREFIX + `+:${A}:1234567890:🔥`), undefined)
  assert.equal(parseReaction(REACT_PREFIX + `+:${A}:1:`), undefined)
  assert.equal(parseReaction(REACT_PREFIX + `+:${A}:1:🔥🔥`), undefined)
  assert.equal(parseReaction(REACT_PREFIX + `+:${A}:1:a`), undefined)
  assert.equal(parseReaction(REACT_PREFIX + `+:${A}:1:7`), undefined)
  assert.equal(parseReaction(REACT_PREFIX + `+:${A}:1: `), undefined)
  assert.equal(parseReaction(REACT_PREFIX + `+:${A}:1:\u0007`), undefined)
  assert.equal(parseReaction(REACT_PREFIX + `+:${A}:1:${'👩‍👩‍👧‍👧'.repeat(2)}`), undefined)
})

test('the grapheme rule accepts one emoji (with joiners or skin tones) and nothing else', () => {
  for (const ok of ['🔥', '👍🏽', '👩‍💻', '❤️', '🇯🇵', '✔']) assert.equal(isReactionEmoji(ok), true, ok)
  for (const bad of ['', 'ab', '🔥🔥', 'x', '9', ' ', 'é', '\n']) assert.equal(isReactionEmoji(bad), false, JSON.stringify(bad))
})

test('fold: + adds a reactor, - removes, repeats are idempotent, and the order is count then emoji', () => {
  const ev = (author: string, seq: number, op: '+' | '-', emoji: string, target = { author: A, seq: 1 }) => ({ author, seq, body: encodeReaction(op, target, emoji) })
  const events = [
    ev(A, 1, '+', '🔥'),
    ev(A, 2, '+', '🔥'),
    ev(B, 1, '+', '🔥'),
    ev(B, 2, '+', '👍'),
    ev(B, 3, '+', '👀'),
    ev(B, 4, '-', '👀'),
    ev(C, 1, '+', '👍'),
    ev(C, 2, '+', '🎉', { author: B, seq: 9 }),
    ev(C, 3, '-', '🎉', { author: B, seq: 9 }),
  ]
  const folded = foldReactions(events, A)
  assert.deepEqual(folded.get(`${A}:1`), [
    { emoji: '👍', count: 2, mine: false },
    { emoji: '🔥', count: 2, mine: true },
  ])
  assert.equal(folded.has(`${B}:9`), false, 'everything on it was taken back')
  assert.deepEqual(foldReactions(events, C).get(`${A}:1`)?.map((r) => r.mine), [true, false])
  // order independence of ties: count desc, then emoji ascending
  const tie = foldReactions([ev(B, 1, '+', '😮'), ev(C, 1, '+', '👍')], A).get(`${A}:1`)?.map((r) => r.emoji)
  assert.deepEqual(tie, ['👍', '😮'])
})

test('malformed events in the log are skipped', () => {
  const folded = foldReactions([{ author: B, seq: 1, body: REACT_PREFIX + 'garbage' }, { author: B, seq: 2, body: 'hello' }], A)
  assert.equal(folded.size, 0)
})
