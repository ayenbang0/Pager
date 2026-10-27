// Chats block DOM builder. Messages, names, notes and file names come from other people, so this builder cannot turn a string
// into markup: text only ever goes in through createTextNode, attributes are an allow-list, `src`/`href` are checked, and
// there is no innerHTML anywhere in the chats block (chats-dom.test.mjs runs the whole block against a fake DOM that throws if
// anything assigns markup). The document is an argument so the tests can run under plain node.
import { ICONS } from '../ui/icons.js'
import { safeHref, safeImageSrc } from './chats-util.js'

const SVG_NS = 'http://www.w3.org/2000/svg'

const ATTRS = new Set([
  'title', 'type', 'role', 'tabindex', 'alt', 'draggable', 'placeholder', 'rows', 'spellcheck', 'autocomplete', 'autocapitalize', 'maxlength',
  'name', 'for', 'accept', 'multiple', 'loading', 'decoding', 'width', 'height', 'enterkeyhint', 'inputmode', 'rel', 'target', 'id',
  'min', 'max', 'step', 'translate', 'dir', 'lang', 'open', 'download',
])
const PROPS = new Set(['value', 'disabled', 'checked', 'hidden', 'readOnly', 'selected'])

/** Icons the shared set does not have (16px grid, same stroke style). */
const EXTRA_ICONS = {
  reply: '<path d="M6.5 3 2.5 6.8l4 3.8M2.8 6.8h6.2a4.3 4.3 0 0 1 4.2 4.4V13"/>',
  smile: '<circle cx="8" cy="8" r="6"/><path d="M5.4 9.6a3.2 3.2 0 0 0 5.2 0M5.9 6.3h.01M10.1 6.3h.01"/>',
  paperclip: '<path d="M12.6 7.7 8.2 12.1a3 3 0 0 1-4.3-4.2l5-5a2 2 0 0 1 2.8 2.9l-5 5a1 1 0 0 1-1.4-1.4l4.4-4.4"/>',
  phone: '<path d="M4.2 2.2h2l1 2.9-1.3.9a7.2 7.2 0 0 0 3.2 3.2l.9-1.3 2.9 1v2a1.6 1.6 0 0 1-1.7 1.6A9.8 9.8 0 0 1 2.6 3.9 1.6 1.6 0 0 1 4.2 2.2z"/>',
  'phone-off': '<path d="M4.2 2.2h2l1 2.9-1.3.9a7.2 7.2 0 0 0 3.2 3.2l.9-1.3 2.9 1v2a1.6 1.6 0 0 1-1.7 1.6A9.8 9.8 0 0 1 2.6 3.9 1.6 1.6 0 0 1 4.2 2.2zM2.5 2.5l11 11"/>',
  users: '<circle cx="6" cy="5.4" r="2.4"/><path d="M1.8 13.4a4.3 4.3 0 0 1 8.4 0M10.6 3.4a2.4 2.4 0 0 1 0 4.2M12 9.4a4.3 4.3 0 0 1 2.4 4"/>',
  'user-plus': '<circle cx="6.2" cy="5.3" r="2.6"/><path d="M1.5 13.6a4.7 4.7 0 0 1 9.4 0M12.5 5v4M10.5 7h4"/>',
  archive: '<rect x="2" y="2.8" width="12" height="3.4" rx="1.2"/><path d="M3 6.2V12a1.4 1.4 0 0 0 1.4 1.4h7.2A1.4 1.4 0 0 0 13 12V6.2M6.4 9h3.2"/>',
  inbox: '<path d="M2.2 9.2 4 3.8a1.4 1.4 0 0 1 1.3-.9h5.4a1.4 1.4 0 0 1 1.3.9l1.8 5.4v2.6a1.4 1.4 0 0 1-1.4 1.4H3.6a1.4 1.4 0 0 1-1.4-1.4zM2.2 9.2h3.2l.9 1.6h3.4l.9-1.6h3.2"/>',
  'check-double': '<path d="M1.5 8.6l3 3L10.6 4.6M7.3 11.4l.7.7L14.5 4.6"/>',
  more: '<path d="M3.5 8h.01M8 8h.01M12.5 8h.01"/>',
  mention: '<circle cx="8" cy="8" r="2.6"/><path d="M10.6 8v1.1a1.9 1.9 0 0 0 3.8 0V8a6.4 6.4 0 1 0-2.6 5.1"/>',
  'mic-send': '<rect x="6" y="1.8" width="4" height="7.4" rx="2"/><path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.8V14"/>',
  chat: '<path d="M2.4 8a5.6 5.4 0 0 1 11.2 0 5.6 5.4 0 0 1-8.2 4.7L2.6 13.6l.9-2.6A5.4 5.4 0 0 1 2.4 8z"/>',
  'chat-plus': '<path d="M2.4 8a5.6 5.4 0 0 1 11.2 0 5.6 5.4 0 0 1-8.2 4.7L2.6 13.6l.9-2.6A5.4 5.4 0 0 1 2.4 8zM8 5.9v4.2M5.9 8h4.2"/>',
  bot: '<rect x="3" y="5.2" width="10" height="7.6" rx="2.4"/><path d="M8 5.2V3M6.2 8.8h.01M9.8 8.8h.01M6.4 11h3.2"/><circle cx="8" cy="2.4" r=".7"/>',
  at: '<circle cx="8" cy="8" r="2.5"/><path d="M10.5 6v3a1.8 1.8 0 0 0 3.6 0V8A6.1 6.1 0 1 0 12 12.7"/>',
  'sidebar-right': '<rect x="2" y="2.8" width="12" height="10.4" rx="2.2"/><path d="M10 2.8v10.4"/>',
  'x-circle': '<circle cx="8" cy="8" r="6"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
  heart: '<path d="M8 13.4S2.4 10 2.4 6A3 3 0 0 1 8 4.7 3 3 0 0 1 13.6 6c0 4-5.6 7.4-5.6 7.4z"/>',
  spark: '<path d="M8 2v4M8 10v4M2 8h4M10 8h4"/>',
  'ban': '<circle cx="8" cy="8" r="6"/><path d="M4.9 4.9l6.2 6.2"/>',
}

const SHAPES = /<(path|rect|circle|ellipse)\s+([^>]*?)\/>/g
const ATTR = /([a-zA-Z-]+)="([^"]*)"/g

export function iconTable() {
  return { ...ICONS, ...EXTRA_ICONS }
}

export function makeBuilder(doc) {
  const table = iconTable()
  const iconCache = new Map()

  const append = (el, kids) => {
    for (const k of kids) {
      if (k === undefined || k === null || k === false) continue
      if (Array.isArray(k)) append(el, k)
      else if (typeof k === 'string' || typeof k === 'number') el.appendChild(doc.createTextNode(String(k)))
      else el.appendChild(k)
    }
  }

  /** h('div', { class: 'a', title: 'x', style: { '--w': '3px' }, on: { click: fn }, data-k: 'v' }, 'text', child, [more]) */
  const h = (tag, props, ...kids) => {
    const el = doc.createElement(tag)
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k]
        if (v === undefined || v === null || v === false) continue
        if (k === 'class') el.className = v
        else if (k === 'style') for (const n of Object.keys(v)) el.style.setProperty(n, String(v[n]))
        else if (k === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev])
        else if (k === 'src') {
          const ok = safeImageSrc(v)
          if (ok) el.setAttribute('src', ok)
        } else if (k === 'href') {
          const ok = safeHref(v)
          if (ok) el.setAttribute('href', ok)
        } else if (PROPS.has(k)) el[k] = v
        else if (k.startsWith('data-') || k.startsWith('aria-') || ATTRS.has(k)) el.setAttribute(k, v === true ? '' : String(v))
        else throw new Error(`attribute not allowed: ${k}`)
      }
    }
    append(el, kids)
    return el
  }

  const text = (s) => doc.createTextNode(String(s))

  /** An inline SVG from the icon tables; unknown names get a neutral rounded square. Markup is never assigned, shapes are rebuilt. */
  const icon = (name, size = 16, cls = '') => {
    let shapes = iconCache.get(name)
    if (!shapes) {
      shapes = []
      const body = Object.hasOwn(table, name) ? table[name] : '<rect x="3" y="3" width="10" height="10" rx="2.5"/>'
      for (const m of String(body).matchAll(SHAPES)) {
        const attrs = []
        for (const a of m[2].matchAll(ATTR)) attrs.push([a[1], a[2]])
        shapes.push([m[1], attrs])
      }
      iconCache.set(name, shapes)
    }
    const svg = doc.createElementNS(SVG_NS, 'svg')
    const set = [['class', ('ico ' + cls).trim()], ['viewBox', '0 0 16 16'], ['width', size], ['height', size], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.45'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['focusable', 'false']]
    for (const [k, v] of set) svg.setAttribute(k, String(v))
    for (const [tag, attrs] of shapes) {
      const node = doc.createElementNS(SVG_NS, tag)
      for (const [k, v] of attrs) node.setAttribute(k, v)
      svg.appendChild(node)
    }
    return svg
  }

  return { h, icon, text }
}
