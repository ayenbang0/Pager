// node --test desktop/renderer/surface/render.test.mjs
// The renderers run here against a recording fake DOM that THROWS if anything assigns markup (innerHTML, outerHTML,
// insertAdjacentHTML), so passing proves hostile strings were only ever placed as text nodes, sandboxed iframes or checked image URLs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeBuilder } from './dom.js'
import { parseUnifiedDiff } from './diff.js'
import { buildDiffView, IFRAME_CSP, IFRAME_SANDBOX, mountSurface, sandboxDocument } from './render.js'

class FakeText {
  constructor(data) { this.nodeType = 3; this.data = data }
}
class FakeEl {
  constructor(tagName, ns) {
    this.nodeType = 1; this.tagName = tagName; this.ns = ns; this.attrs = {}; this.children = []; this.className = ''; this.listeners = {}
    this.style = { props: {}, setProperty: (k, v) => { this.style.props[k] = v } }
    const set = new Set()
    this.classList = { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), toggle: (c, f) => (f === undefined ? set.has(c) : f) ? set.add(c) : set.delete(c), contains: (c) => set.has(c) }
  }
  set innerHTML(v) { throw new Error(`innerHTML assigned: ${v}`) }
  set outerHTML(v) { throw new Error(`outerHTML assigned: ${v}`) }
  insertAdjacentHTML(_p, v) { throw new Error(`insertAdjacentHTML: ${v}`) }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] ?? null }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn) }
  appendChild(c) { this.children.push(c); c.parent = this; return c }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeText(c) : c) }
  replaceChildren(...cs) { this.children = []; this.append(...cs) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this) }
  querySelector() { return null }
  querySelectorAll() { return [] }
  get ownerDocument() { return doc }
  scrollTop = 0
}
const doc = {
  head: null,
  documentElement: new FakeEl('html'),
  createElement: (t) => new FakeEl(t),
  createElementNS: (ns, t) => new FakeEl(t, ns),
  createTextNode: (d) => new FakeText(d),
  querySelectorAll: () => [],
}

const walk = (n, fn) => { fn(n); for (const c of n.children || []) walk(c, fn) }
const all = (n) => { const out = []; walk(n, (x) => out.push(x)); return out }
const texts = (n) => all(n).filter((x) => x.nodeType === 3).map((x) => x.data)
const els = (n) => all(n).filter((x) => x.nodeType === 1)

const TAGS = new Set(['div', 'span', 'button', 'section', 'svg', 'path', 'rect', 'circle', 'pre', 'iframe', 'img', 'link'])
function assertInert(root, payloads) {
  for (const e of els(root)) {
    assert.ok(TAGS.has(e.tagName), `unexpected element <${e.tagName}>`)
    for (const k of Object.keys(e.attrs)) assert.ok(!/^on/i.test(k), `event attribute ${k}`)
    for (const k of Object.keys(e.attrs)) for (const p of payloads) assert.ok(!(k !== 'srcdoc' && e.attrs[k].includes(p)), `payload leaked into attribute ${k}`)
    if (e.tagName === 'iframe') {
      assert.equal(e.attrs.sandbox, IFRAME_SANDBOX, 'iframe is fully sandboxed')
      assert.equal(IFRAME_SANDBOX, '')
      assert.ok(!('allow' in e.attrs))
      assert.ok(e.attrs.srcdoc.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"'))
    }
  }
}

const XSS = [
  '<script>window.__xss=1</script>',
  '<img src=x onerror="window.__xss=1">',
  '"><svg onload=window.__xss=1>',
  "'; window.__xss=1; '",
  '<iframe srcdoc="<script>parent.__xss=1</script>">',
  'javascript:window.__xss=1',
]

test('diff: hostile file names, sections and lines are only text', () => {
  const b = makeBuilder(doc)
  const text = XSS.map((x, i) => `diff --git a/${x}.js b/${x}.js\n--- a/${x}.js\n+++ b/${x}.js\n@@ -1,2 +1,2 @@ ${x}\n ${x}\n-${x}\n+${x}\n`).join('')
  const parsed = parseUnifiedDiff(text)
  for (const mode of ['unified', 'split']) {
    const root = buildDiffView(b, parsed, { mode, closed: new Set() }, () => {})
    assertInert(root, XSS)
    const shown = texts(root).join('\n')
    for (const x of XSS) assert.ok(shown.includes(x), `${mode}: ${x} shown as text`)
  }
})

test('diff: collapsing a hunk or a file hides its lines; toggles call back', () => {
  const b = makeBuilder(doc)
  const parsed = parseUnifiedDiff('--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n@@ -9 +9 @@\n-z\n+y\n')
  const count = (state) => texts(buildDiffView(b, parsed, state, () => {})).filter((t) => t === 'const' || t === 'z' || t === 'y').length
  assert.equal(count({ mode: 'unified', closed: new Set() }), 4) // const x2, z, y
  assert.equal(count({ mode: 'unified', closed: new Set(['f0h0']) }), 2)
  assert.equal(count({ mode: 'unified', closed: new Set(['f0']) }), 0)
  let changed = 0
  const state = { mode: 'unified', closed: new Set() }
  const root = buildDiffView(b, parsed, state, () => changed++)
  const hunkHead = els(root).find((e) => e.className === 'pgs-hhead')
  hunkHead.listeners.click[0]()
  assert.ok(state.closed.has('f0h0') && changed === 1)
})

test('diff: a giant diff draws a bounded number of rows and says so', () => {
  const b = makeBuilder(doc)
  const n = 6000
  const parsed = parseUnifiedDiff(`@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+l${i}`).join('\n')}\n`)
  const root = buildDiffView(b, parsed, { mode: 'unified', closed: new Set() }, () => {})
  assert.equal(els(root).filter((e) => e.className === 'pgs-row add').length, 4000)
  assert.match(texts(root).join('\n'), /2000 more lines/)
})

test('the builder refuses markup-making attributes and keeps strings as text', () => {
  const b = makeBuilder(doc)
  assert.throws(() => b.h('div', { onclick: 'x' }), /not allowed/)
  assert.throws(() => b.h('div', { innerHTML: '<b>' }), /not allowed/)
  assert.throws(() => b.h('a', { href: 'javascript:1' }), /not allowed/)
  const e = b.h('div', null, '<b>bold</b>', 3)
  assert.deepEqual(texts(e), ['<b>bold</b>', '3'])
  assert.equal(e.children[0].nodeType, 3)
})

test('sandboxDocument: CSP first, nothing allowed beyond inline style and data images', () => {
  const html = sandboxDocument('<p>x</p>', { fg: 'red;}</style><script>1</script>', dark: true })
  assert.ok(html.includes(`content="${IFRAME_CSP}"`))
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<p>x</p>'))
  assert.ok(!html.includes('<script>'), 'a hostile theme value is dropped, not injected')
  assert.match(IFRAME_CSP, /^default-src 'none'/)
  assert.ok(!/script-src|connect-src|frame-src/.test(IFRAME_CSP))
})

function mount(msg) {
  const host = new FakeEl('div')
  const view = mountSurface(host, msg, { doc, openInPane: () => {} })
  return { host, view }
}

test('html-sandbox mounts one empty-sandbox iframe whose srcdoc holds the page', () => {
  for (const x of XSS) {
    const { host } = mount({ kind: 'html-sandbox', id: 'h', source: x })
    assertInert(host, [])
    const frames = els(host).filter((e) => e.tagName === 'iframe')
    assert.equal(frames.length, 1)
    assert.ok(frames[0].attrs.srcdoc.endsWith(`${x}</body></html>`))
  }
})

test('image: only a checked data URL reaches <img src>', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const ok = mount({ kind: 'image', id: 'i', source: `data:image/png;base64,${PNG}`, title: XSS[1] })
  const img = els(ok.host).find((e) => e.tagName === 'img')
  assert.ok(img.attrs.src.startsWith('data:image/png;base64,'))
  assert.equal(img.attrs.alt, XSS[1], 'alt is an attribute value, not markup')
  assertInert(ok.host, [])
  for (const source of ['javascript:window.__xss=1', 'https://evil.example/x.png', `data:image/svg+xml;base64,${Buffer.from('<svg onload=window.__xss=1/>').toString('base64')}`, `data:image/png;base64,${PNG}" onerror="window.__xss=1`]) {
    const bad = mount({ kind: 'image', id: 'i', source })
    assert.equal(els(bad.host).filter((e) => e.tagName === 'img').length, 0, source)
    assert.match(texts(bad.host).join(' '), /refused/)
  }
})

test('refused messages show a plain text reason, never the payload as markup', () => {
  const { host } = mount({ kind: '<script>', id: '<img onerror=1>', source: XSS[0] })
  assertInert(host, [])
  assert.match(texts(host).join(' '), /This surface was refused/)
})

test('titles are text', () => {
  const { host } = mount({ kind: 'diff', id: 'd', source: '@@ -1 +1 @@\n-a\n+b\n', title: XSS[0] })
  assertInert(host, XSS)
  assert.ok(texts(host).includes(XSS[0]))
})
