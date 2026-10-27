import assert from 'node:assert/strict'
import { test } from 'node:test'
import { langOf, tokenize } from './gitsyntax.js'

const join = (t) => t.map((x) => x.s).join('')
const kinds = (t) => t.filter((x) => x.k).map((x) => `${x.k}:${x.s}`)

test('langOf maps extensions and special file names', () => {
  assert.equal(langOf('src/app.ts'), 'c')
  assert.equal(langOf('a/b/Dockerfile'), 'sh')
  assert.equal(langOf('x.py'), 'py')
  assert.equal(langOf('x.JSON'), 'json')
  assert.equal(langOf('README.md'), 'none')
  assert.equal(langOf('LICENSE'), 'none')
  assert.equal(langOf('index.html'), 'html')
})

test('tokens always concatenate back to the line', () => {
  const lines = ['export const a = 1 // note', '  return `hi ${n}` + "x\\"y"', 'if (x) { call(1, 0xff, 2.5e3) }', '<div class="a">text</div>', '', '    ', '"unterminated', "'a' 'b", '/* c */ x /* open']
  for (const lang of ['c', 'py', 'sh', 'css', 'html', 'json', 'none']) for (const l of lines) assert.equal(join(tokenize(l, lang)), l, `${lang}: ${l}`)
})

test('colours keywords, strings, numbers, comments, calls and types', () => {
  assert.deepEqual(kinds(tokenize('export const a = 12 // done', 'c')), ['kw:export', 'kw:const', 'num:12', 'com:// done'])
  assert.deepEqual(kinds(tokenize('return new Map(items)', 'c')), ['kw:return', 'kw:new', 'fn:Map'])
  assert.deepEqual(kinds(tokenize('let s = "a // b"', 'c')), ['kw:let', 'str:"a // b"'])
  assert.deepEqual(kinds(tokenize('x = Foo.bar()', 'c')), ['ty:Foo', 'fn:bar'])
  assert.deepEqual(kinds(tokenize('def f(x): # hi', 'py')), ['kw:def', 'fn:f', 'com:# hi'])
  assert.deepEqual(kinds(tokenize('echo "$A" # c', 'sh')), ['kw:echo', 'str:"$A"', 'com:# c'])
})

test('identifiers with digits are not numbers; strings honour escapes', () => {
  assert.deepEqual(kinds(tokenize('v2 = x1', 'c')), [])
  assert.deepEqual(kinds(tokenize('s = "a\\"b" + 3', 'c')), ['str:"a\\"b"', 'num:3'])
})

test('continuation lines of a block comment are comments; json has no keywords but true/false/null', () => {
  assert.deepEqual(tokenize(' * more text', 'c'), [{ k: 'com', s: ' * more text' }])
  assert.deepEqual(tokenize(' */', 'c'), [{ k: 'com', s: ' */' }])
  assert.deepEqual(kinds(tokenize('{"a": true, "n": 4, "s": null}', 'json')), ['str:"a"', 'kw:true', 'str:"n"', 'num:4', 'str:"s"', 'kw:null'])
})

test('html tags and plain text; unknown languages stay plain', () => {
  assert.deepEqual(kinds(tokenize('<a href="x">t</a>', 'html')), ['tag:<a href="x">', 'tag:</a>'])
  assert.deepEqual(tokenize('some text', 'none'), [{ k: '', s: 'some text' }])
  assert.deepEqual(tokenize('', 'c'), [])
})
