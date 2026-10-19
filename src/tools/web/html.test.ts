import assert from 'node:assert/strict'
import { test } from 'node:test'
import { htmlToText, scrub } from './html.js'

test('scripts, styles, comments, heads and svg are dropped; block tags break lines', () => {
  const html = '<html><head><title>T</title></head><body><style>p{}</style><script>alert(1)</script><!-- c --><h1>Title</h1><p>One<br>two</p><div>three</div><ul><li>a</li><li>b</li></ul><svg><text>no</text></svg><noscript>no</noscript></body></html>'
  assert.equal(htmlToText(html), 'Title\nOne\ntwo\nthree\na\nb')
})

test('entities decode (named and numeric), unknown ones stay', () => {
  assert.equal(htmlToText('<p>Tom &amp; Jerry &lt;3 &quot;q&quot; &#39;s&#39; &apos;x&apos; a&nbsp;b &#x1F525; &#128512; &bogus; &#xD800;</p>'), 'Tom & Jerry <3 "q" \'s\' \'x\' a b 🔥 😀 &bogus; &#xD800;')
})

test('control characters go, spaces and blank lines collapse', () => {
  assert.equal(htmlToText('<p>a\u0007b\u001b[31m   c</p>\n\n\n\n<p>d</p>'), 'ab[31m c\n\nd')
  assert.equal(scrub('x\u001b[0my\u0000'), 'x [0my ')
})

test('output is capped at 20,000 characters', () => {
  assert.equal(htmlToText('<p>' + 'a'.repeat(50_000) + '</p>').length, 20_000)
})
