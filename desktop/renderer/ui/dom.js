// Tiny DOM helpers: hyperscript, selectors, a keyed list reconciler. No framework, no virtual DOM.

/** h('div', { class: 'a', onClick: fn, dataset: { x: 1 }, style: { color: 'red' } }, 'text', node, [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag)
  if (props) {
    for (const k in props) {
      const v = props[k]
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v
        else for (const p in v) (p.startsWith('--') ? el.style.setProperty(p, v[p]) : (el.style[p] = v[p]))
      } else if (k === 'dataset') for (const d in v) el.dataset[d] = v[d]
      else if (k === 'html') el.innerHTML = v
      else if (k === 'attrs') for (const a in v) el.setAttribute(a, v[a])
      else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k in el && typeof v !== 'object') el[k] = v
      else el.setAttribute(k, v === true ? '' : v)
    }
  }
  append(el, children)
  return el
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    if (Array.isArray(c)) append(el, c)
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
}

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))
export const frag = (...children) => {
  const f = document.createDocumentFragment()
  append(f, children)
  return f
}

/** Parse trusted SVG/HTML markup into one element (icons). */
export function fromHTML(markup) {
  const t = document.createElement('template')
  t.innerHTML = markup.trim()
  return t.content.firstElementChild
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** Run fn at most once per animation frame (last call wins). */
export function rafThrottle(fn) {
  let id = 0
  let args
  return (...a) => {
    args = a
    if (id) return
    id = requestAnimationFrame(() => {
      id = 0
      fn(...args)
    })
  }
}

/** Keep `parent`'s children in sync with `items` (keyed), reusing elements: create(item) once, update(el,item) every time. */
export function reconcile(parent, items, key, create, update) {
  const existing = new Map()
  for (const c of Array.from(parent.children)) if (c.__key !== undefined) existing.set(c.__key, c)
  let prev = null
  for (const item of items) {
    const k = key(item)
    let el = existing.get(k)
    if (el) existing.delete(k)
    else {
      el = create(item)
      el.__key = k
    }
    if (update) update(el, item)
    const want = prev ? prev.nextSibling : parent.firstChild
    if (want !== el) parent.insertBefore(el, want)
    prev = el
  }
  for (const el of existing.values()) el.remove()
}

/** Shell-ish path helpers for display. */
export const baseName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p || ''
export function tildePath(p, home) {
  if (!p) return ''
  const n = p.replace(/\\/g, '/')
  const hm = (home || '').replace(/\\/g, '/').replace(/\/$/, '')
  if (hm && (n === hm || n.startsWith(hm + '/'))) return '~' + n.slice(hm.length)
  return n
}

export function uid(prefix = 'x') {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`
}
