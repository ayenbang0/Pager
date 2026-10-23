import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readCapped, readPage } from './read.js'
import { blocked, formatResults, parseResults, searchWeb, unwrapLink } from './search.js'

/**
 * A trimmed sample in the shape DuckDuckGo's html endpoint returns (the class names `result__a` and `result__snippet`, links wrapped as
 * `//duckduckgo.com/l/?uddg=`). Written by hand: the session that wrote it could not reach DuckDuckGo to capture a live page, so
 * confirm the selectors against the real endpoint before relying on them.
 */
const SAMPLE = `<!DOCTYPE html><html><body><div id="links" class="results">
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fsqlite.html&amp;rut=abc123">SQLite | <b>Node.js</b> v24 Documentation</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fsqlite.html&amp;rut=abc123">The <b>node:sqlite</b> module facilitates working with SQLite databases &amp; more.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.org/direct?x=1&amp;y=2">Direct link result</a></h2>
    <a class="result__snippet" href="https://example.org/direct">A snippet on a direct link.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="javascript:alert(1)">Not http</a></h2>
    <a class="result__snippet" href="#">dropped with its link</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2Fsqlite&amp;rut=zzz">sqlite on npm</a></h2>
  </div>
</div>
</div></body></html>`

const html = (body: string, init: ResponseInit = {}): Response => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })

test('the parser keeps http(s) results, unwraps uddg redirects and decodes entities', () => {
  const results = parseResults(SAMPLE)
  assert.deepEqual(results, [
    { title: 'SQLite | Node.js v24 Documentation', url: 'https://nodejs.org/api/sqlite.html', snippet: 'The node:sqlite module facilitates working with SQLite databases & more.' },
    { title: 'Direct link result', url: 'https://example.org/direct?x=1&y=2', snippet: 'A snippet on a direct link.' },
    { title: 'sqlite on npm', url: 'https://www.npmjs.com/package/sqlite', snippet: '' },
  ])
})

test('unwrapLink refuses non-http targets and garbage', () => {
  assert.equal(unwrapLink('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)'), undefined)
  assert.equal(unwrapLink('//duckduckgo.com/l/?rut=x'), undefined)
  assert.equal(unwrapLink('//duckduckgo.com/l/?uddg=notaurl'), undefined)
  assert.equal(unwrapLink('ftp://x.org/a'), undefined)
  assert.equal(unwrapLink('https://a.org/b'), 'https://a.org/b')
})

test('a robot-check page and HTTP 202 are reported as blocked; other failures carry the status', async () => {
  assert.equal(blocked(202, ''), true)
  assert.equal(blocked(200, '<p>Unfortunately, bots use DuckDuckGo too. anomaly-modal</p>'), true)
  assert.equal(blocked(200, SAMPLE), false)
  await assert.rejects(searchWeb('x', { fetch: async () => html('', { status: 202 }) }), /DuckDuckGo blocked this request; try again later/)
  await assert.rejects(searchWeb('x', { fetch: async () => html('<div class="anomaly-modal"></div>') }), /blocked/)
  await assert.rejects(searchWeb('x', { fetch: async () => html('', { status: 500 }) }), /search answered 500/)
})

test('searchWeb sends the query and our user agent', async () => {
  let seen: { url: string; ua: string | null } | undefined
  const results = await searchWeb('node sqlite & more', {
    fetch: async (input, init) => {
      seen = { url: String(input), ua: new Headers(init?.headers).get('user-agent') }
      return html(SAMPLE)
    },
  })
  assert.equal(results.length, 3)
  assert.equal(seen?.url, 'https://html.duckduckgo.com/html/?q=node%20sqlite%20%26%20more')
  assert.match(seen?.ua ?? '', /^Mozilla\/5\.0 \(compatible; pager-cli\/\d+\.\d+\.\d+\)$/)
})

test('readPage: text only, private hosts refused, size capped', async () => {
  const page = await readPage('https://example.org/a', { fetch: async () => html('<html><head><title>Hi &amp; bye</title></head><body><p>Hello</p><script>x()</script></body></html>') })
  assert.deepEqual(page, { title: 'Hi & bye', text: 'Hello' })
  await assert.rejects(readPage('http://127.0.0.1/admin', { fetch: async () => html('secret') }), /Refusing to read a private-network address/)
  await assert.rejects(readPage('http://localhost:8080/', { fetch: async () => html('secret') }), /private-network/)
  await assert.rejects(readPage('http://printer.local/', { fetch: async () => html('x') }), /private-network/)
  await assert.rejects(readPage('file:///etc/passwd'), /Only http and https/)
  await assert.rejects(readPage('https://example.org/x.png', { fetch: async () => new Response('png', { headers: { 'content-type': 'image/png' } }) }), /Not a text page \(image\/png\)/)
  await assert.rejects(readPage('https://example.org/x', { fetch: async () => html('', { status: 404 }) }), /answered 404/)
  const plain = await readPage('https://example.org/t', { fetch: async () => new Response('a <b> c', { headers: { 'content-type': 'text/plain' } }) })
  assert.equal(plain.text, 'a <b> c')
  // a redirect that ends up on a private host is refused too
  const redirected = { fetch: async () => Object.defineProperty(html('hidden'), 'url', { value: 'http://10.0.0.5/inside' }) }
  await assert.rejects(readPage('https://example.org/r', redirected), /private-network/)
})

test('readCapped stops at 1 MiB', async () => {
  const big = 'a'.repeat(3 * 1024 * 1024)
  const text = await readCapped(new Response(big))
  assert.equal(text.length, 1024 * 1024)
})

test('formatResults numbers each hit and skips an empty snippet', () => {
  assert.deepEqual(
    formatResults([
      { title: 'One', url: 'https://example.org/1', snippet: 'first' },
      { title: 'Two', url: 'https://example.org/2', snippet: '' },
    ]),
    ['1. One', '   https://example.org/1', '   first', '2. Two', '   https://example.org/2'],
  )
})
