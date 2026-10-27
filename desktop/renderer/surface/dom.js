// A small DOM builder that cannot make markup out of a string: text only ever goes in through createTextNode, attributes
// are an allow-list, and there is no innerHTML anywhere in the surface renderer (a test fake throws if one is assigned).
// Taking the document as an argument lets the XSS tests run it against a recording fake under plain node.

const ATTRS = new Set(['title', 'type', 'role', 'tabindex', 'alt', 'draggable', 'sandbox', 'srcdoc', 'src', 'loading', 'referrerpolicy', 'aria-label', 'aria-expanded', 'aria-pressed', 'aria-hidden', 'disabled'])
const SVG_NS = 'http://www.w3.org/2000/svg'

const ICONS = {
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 3.2v-.3A1.4 1.4 0 0 0 9.1 1.5H3.9A1.4 1.4 0 0 0 2.5 2.9v5.2a1.4 1.4 0 0 0 1.4 1.4h.3"/>',
  check: '<path d="M3.2 8.4l3.2 3.2 6.4-7"/>',
  pane: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.2"/><path d="M9.2 2.8v10.4"/>',
  chev: '<path d="M6 4l4 4-4 4"/>',
  fold: '<path d="M4.5 6.2L8 2.8l3.5 3.4M4.5 9.8L8 13.2l3.5-3.4"/>',
  unfold: '<path d="M4.5 4.4L8 8l3.5-3.6M4.5 11.6L8 8"/>',
  mermaid: '<circle cx="3.6" cy="4" r="1.6"/><circle cx="12.4" cy="4" r="1.6"/><circle cx="8" cy="12.2" r="1.6"/><path d="M5.2 4h5.6M4.4 5.5l2.8 5.1M11.6 5.5L8.8 10.6"/>',
  math: '<path d="M12.5 3H5.2l4.3 5-4.3 5h7.3"/>',
  diff: '<path d="M4.5 2.5v8M2 5l2.5-2.5L7 5M11.5 13.5v-8M9 11l2.5 2.5L14 11"/>',
  image: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.2"/><circle cx="5.6" cy="6.4" r="1.2"/><path d="M2.4 12l3.8-3.6 2.6 2.4 2-1.8 3.2 3"/>',
  'html-sandbox': '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3l-2 10"/>',
}

export function makeBuilder(doc) {
  /** h('div', { class: 'a', title: 'x', style: { '--w': '3px' }, on: { click: fn } }, 'text', child, [more]) */
  const h = (tag, props, ...kids) => {
    const el = doc.createElement(tag)
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue
        if (k === 'class') el.className = v
        else if (k === 'style') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, String(val))
        else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn)
        else if (k.startsWith('data-') || ATTRS.has(k)) el.setAttribute(k, v === true ? '' : String(v))
        else throw new Error(`attribute not allowed: ${k}`)
      }
    }
    append(el, kids)
    return el
  }
  const append = (el, kids) => {
    for (const k of kids) {
      if (k === undefined || k === null || k === false) continue
      if (Array.isArray(k)) append(el, k)
      else if (typeof k === 'string' || typeof k === 'number') el.appendChild(doc.createTextNode(String(k)))
      else el.appendChild(k)
    }
  }
  /** A 16px stroke icon from the fixed table above. */
  const icon = (name) => {
    const svg = doc.createElementNS(SVG_NS, 'svg')
    for (const [k, v] of [['class', 'pgs-ico'], ['viewBox', '0 0 16 16'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.45'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) svg.setAttribute(k, v)
    // ICONS holds our own constant path data; parse it with a tiny tag reader instead of assigning markup.
    for (const m of (ICONS[name] || '').matchAll(/<(path|rect|circle)\s+([^>]*?)\/>/g)) {
      const node = doc.createElementNS(SVG_NS, m[1])
      for (const a of m[2].matchAll(/([a-z-]+)="([^"]*)"/g)) node.setAttribute(a[1], a[2])
      svg.appendChild(node)
    }
    return svg
  }
  return { h, icon, text: (s) => doc.createTextNode(String(s)) }
}

/** Copy text to the clipboard; resolves true on success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
