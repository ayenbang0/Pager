// node --test desktop/renderer/blocks/chats-rich.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRich, plainText } from './chats-rich.js'

const types = (toks) => toks.map((t) => t.t)

test('plain text, newlines and links', () => {
  const t = parseRich('hello\nsee https://example.com/a?b=1, ok')
  assert.deepEqual(types(t), ['text', 'br', 'text', 'link', 'text'])
  assert.equal(t[3].href, 'https://example.com/a?b=1')
  assert.equal(t[4].v, ', ok')
})

test('url trailing punctuation and brackets', () => {
  assert.equal(parseRich('(https://x.org/a)').find((x) => x.t === 'link').v, 'https://x.org/a')
  assert.equal(parseRich('https://x.org/a_(b)').find((x) => x.t === 'link').v, 'https://x.org/a_(b)')
  assert.equal(parseRich('go to https://x.org!').find((x) => x.t === 'link').v, 'https://x.org')
})

test('javascript: and data: urls are never links', () => {
  for (const s of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'https://ok.example']) {
    const links = parseRich(s).filter((x) => x.t === 'link')
    assert.equal(links.length, s.startsWith('https') ? 1 : 0, s)
  }
})

test('inline code wins over links and mentions', () => {
  const t = parseRich('run `npm i https://x.org @Mira` now', { names: ['Mira'] })
  assert.deepEqual(types(t), ['text', 'code', 'text'])
  assert.equal(t[1].v, 'npm i https://x.org @Mira')
})

test('fenced code blocks', () => {
  const t = parseRich('before\n```js\nconst a = 1\n```\nafter')
  assert.deepEqual(types(t), ['text', 'pre', 'text'])
  assert.equal(t[1].lang, 'js')
  assert.equal(t[1].v, 'const a = 1')
  // unclosed fence stays text
  assert.deepEqual(types(parseRich('```js\nno end')), ['text', 'br', 'text'])
})

test('mentions only for known names, case-insensitive, with spaces', () => {
  const t = parseRich('hi @mira and @Ada Lovelace, @nobody', { names: ['Mira', 'Ada Lovelace'], me: 'Mira' })
  const m = t.filter((x) => x.t === 'mention')
  assert.deepEqual(m.map((x) => x.v), ['@mira', '@Ada Lovelace'])
  assert.equal(m[0].me, true)
  assert.equal(m[1].me, false)
  // an email is not a mention
  assert.equal(parseRich('write to mira@example.com', { names: ['example'] }).filter((x) => x.t === 'mention').length, 0)
})

test('markdown only when flagged', () => {
  assert.deepEqual(types(parseRich('**bold** and _it_')), ['text'])
  const t = parseRich('**bold** and _it_ and ~~gone~~', { markdown: true })
  assert.deepEqual(types(t), ['b', 'text', 'i', 'text', 's'])
  const q = parseRich('> quoted\nplain', { markdown: true })
  assert.deepEqual(types(q), ['quote', 'text'])
})

test('hostile input stays text', () => {
  const t = parseRich('<img src=x onerror=alert(1)> <script>x</script> "><svg onload=1>')
  assert.deepEqual(types(t), ['text'])
  assert.ok(t[0].v.includes('<script>'))
})

test('plainText for previews', () => {
  assert.equal(plainText('**hi**\n```js\nx\n```\n`y`', true), 'hi x y')
})
