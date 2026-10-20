import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeBotMessage, parseBotMessage } from './botMessage.js'
import { BOT_PREFIX, opOf } from './ops.js'

test('a bot message keeps its lines on the wire without control characters and parses back', () => {
  const body = encodeBotMessage('grumpy', 'no.\n\n- point one\n\tindented \u001b[31mred\u0085')
  assert.equal(opOf(body), 'bot')
  assert.equal(/\p{Cc}/u.test(body), false)
  assert.deepEqual(parseBotMessage(body), { name: 'grumpy', text: 'no.\n\n- point one\n\tindented [31mred' })
})

test('a long reply is cut to fit one event', () => {
  const body = encodeBotMessage('grumpy', `${'"quoted"\n'.repeat(1000)}end`)
  assert.ok(body.length <= 4000, `${body.length}`)
  assert.ok(parseBotMessage(body)?.text.endsWith('…'))
})

test('a peer cannot smuggle escapes, bad names or empty text', () => {
  assert.equal(parseBotMessage(`${BOT_PREFIX}${JSON.stringify({ n: 'grumpy', t: '\u001b]0;pwn\u0007hi' })}`)?.text, ']0;pwnhi')
  for (const bad of [`${BOT_PREFIX}{oops`, `${BOT_PREFIX}${JSON.stringify({ n: 'Grumpy', t: 'x' })}`, `${BOT_PREFIX}${JSON.stringify({ n: 'g', t: 'x' })}`, `${BOT_PREFIX}${JSON.stringify({ n: 'grumpy', t: ' \u0007 ' })}`, `${BOT_PREFIX}null`, 'plain text']) {
    assert.equal(parseBotMessage(bad), undefined, bad)
  }
})
