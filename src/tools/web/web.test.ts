import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir } from '../../testing/testutil.js'
import { readCapped, readPage } from './read.js'
import { blocked, parseResults, searchWeb, unwrapLink } from './search.js'
import { WebTool, WEB_OFF } from './tool.js'

after(removeTmpDirs)

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

test('WebTool grammar: bare text searches, open writes the URL to the seam, read prints text, bad numbers fail', async () => {
  const file = path.join(tmpDir('pager-web-'), 'open.txt')
  process.env.PAGER_OPEN_FILE = file
  try {
    const tool = new WebTool({
      fetch: async (input) => (String(input).includes('duckduckgo') ? html(SAMPLE) : html('<title>Doc</title><p>page body</p>')),
    })
    await tool.run('node sqlite')
    const first = tool.list()[0]!
    assert.equal(first.state, 'done')
    assert.equal(first.lines[0], '1. SQLite | Node.js v24 Documentation')
    assert.equal(first.lines[1], '   https://nodejs.org/api/sqlite.html')
    assert.equal(first.results?.length, 3)
    await tool.run('open 2')
    assert.equal(fs.readFileSync(file, 'utf8'), 'https://example.org/direct?x=1&y=2\n')
    await tool.run('read 1')
    assert.deepEqual(tool.list().at(-1)?.lines, ['Doc', '', 'page body'])
    await tool.run('read 9')
    assert.deepEqual([tool.list().at(-1)?.state, tool.list().at(-1)?.lines], ['failed', ['No result 9']])
    await tool.run('search')
    assert.equal(tool.list().at(-1)?.state, 'failed')
    await tool.run('help')
    assert.ok((tool.list().at(-1)?.lines.length ?? 0) >= 4)
    await tool.run('clear')
    assert.equal(tool.list().length, 0)
    assert.equal(tool.busy, false)
  } finally {
    delete process.env.PAGER_OPEN_FILE
  }
})

test('WebTool answers that web search is off when PAGER_NO_WEB=1, and reports fetch errors as failed entries', async () => {
  const tool = new WebTool({ fetch: async () => html('', { status: 500 }) })
  await tool.run('anything')
  assert.deepEqual([tool.list()[0]?.state, tool.list()[0]?.lines[0]], ['failed', 'search answered 500'])
  process.env.PAGER_NO_WEB = '1'
  try {
    await tool.run('again')
    assert.deepEqual([tool.list().at(-1)?.state, tool.list().at(-1)?.lines], ['failed', [WEB_OFF]])
  } finally {
    delete process.env.PAGER_NO_WEB
  }
})

test('entries are capped at 50 and control characters from the web never reach a line', async () => {
  const tool = new WebTool({ fetch: async () => html('<p>bad \u001b[31mred\u0007</p>', { headers: { 'content-type': 'text/html' } }) })
  await tool.run('x')
  for (let i = 0; i < 55; i++) await tool.run(`q${i}`)
  assert.equal(tool.list().length, 50)
  await tool.run('open 1') // no results from a page with no links
  assert.equal(tool.list().at(-1)?.state, 'failed')
})
