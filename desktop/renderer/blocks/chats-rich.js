// Chats block: message text -> tokens -> DOM. The parser only produces data; the renderer only creates text nodes and
// allow-listed elements, so a hostile message can never become markup.
//   tokens: { t:'text', v } { t:'code', v } { t:'link', v, href } { t:'mention', v, me } { t:'b'|'i'|'s', kids } { t:'br' }
//           { t:'pre', lang, v } { t:'quote', kids }
import { safeHref } from './chats-util.js'

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi
const OPENERS = { ')': '(', ']': '[', '}': '{' }
const count = (s, ch) => s.split(ch).length - 1

/** Trims sentence punctuation (and an unbalanced closing bracket) off a matched URL; returns [url, rest]. */
function trimUrl(raw) {
  let url = raw
  while (url.length) {
    const c = url[url.length - 1]
    if ('.,;:!?\'">'.includes(c)) url = url.slice(0, -1)
    else if (c in OPENERS && count(url, OPENERS[c]) < count(url, c)) url = url.slice(0, -1)
    else break
  }
  return [url, raw.slice(url.length)]
}

/** Splits a string at fenced ``` blocks: [{ pre:false, v } | { pre:true, lang, v }]. An unclosed fence stays plain text. */
function splitFences(text) {
  const out = []
  const re = /(^|\n)```([A-Za-z0-9_+.#-]{0,24})[ \t]*\n([\s\S]*?)\n?```(?=\n|$)/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length
    if (start > last) out.push({ pre: false, v: text.slice(last, m.index) })
    out.push({ pre: true, lang: m[2] || '', v: m[3] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ pre: false, v: text.slice(last) })
  return out
}

function mentionRegex(names) {
  const list = [...names].filter((n) => n && n.length <= 64).sort((a, b) => b.length - a.length)
  if (!list.length) return null
  const esc = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?<![\\p{L}\\p{N}_@])@(${esc.join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
}

/** Inline pass over one line (no newlines): code spans, links, mentions, and bold/italic/strike when `markdown`. */
function inline(line, o) {
  const out = []
  const push = (t) => {
    const last = out[out.length - 1]
    if (t.t === 'text' && last && last.t === 'text') last.v += t.v
    else out.push(t)
  }
  // 1) code spans win over everything inside them
  const parts = line.split(/(`+)([^`\n]+?)\1(?!`)/)
  // split with 2 capture groups yields [text, fence, code, text, ...]
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) richText(parts[i], o, push)
    if (i + 2 < parts.length) push({ t: 'code', v: parts[i + 2] })
  }
  return out
}

function richText(s, o, push) {
  // links first, then mentions + emphasis in the text between them
  let last = 0
  URL_RE.lastIndex = 0
  let m
  while ((m = URL_RE.exec(s))) {
    const [url, rest] = trimUrl(m[0])
    const href = safeHref(url)
    if (!href) continue
    if (m.index > last) emphasis(s.slice(last, m.index), o, push)
    push({ t: 'link', v: url, href })
    if (rest) push({ t: 'text', v: rest })
    last = m.index + m[0].length
  }
  if (last < s.length) emphasis(s.slice(last), o, push)
}

function emphasis(s, o, push) {
  if (!o.markdown) return mentions(s, o, push)
  const re = /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(?<![\w*])(\*|_)(?=\S)([^*_\n]*?\S)\3(?![\w*])|~~(?=\S)([\s\S]*?\S)~~/g
  let last = 0
  let m
  while ((m = re.exec(s))) {
    if (m.index > last) mentions(s.slice(last, m.index), o, push)
    if (m[1]) push({ t: 'b', kids: sub(m[2], o) })
    else if (m[3]) push({ t: 'i', kids: sub(m[4], o) })
    else push({ t: 's', kids: sub(m[5], o) })
    last = m.index + m[0].length
  }
  if (last < s.length) mentions(s.slice(last), o, push)
}

function sub(s, o) {
  const kids = []
  const push = (t) => {
    const l = kids[kids.length - 1]
    if (t.t === 'text' && l && l.t === 'text') l.v += t.v
    else kids.push(t)
  }
  mentions(s, o, push)
  return kids
}

function mentions(s, o, push) {
  const re = o.mentionRe
  if (!re) return void (s && push({ t: 'text', v: s }))
  re.lastIndex = 0
  let last = 0
  let m
  while ((m = re.exec(s))) {
    if (m.index > last) push({ t: 'text', v: s.slice(last, m.index) })
    push({ t: 'mention', v: '@' + m[1], me: !!o.me && m[1].toLowerCase() === o.me.toLowerCase() })
    last = m.index + m[0].length
  }
  if (last < s.length) push({ t: 'text', v: s.slice(last) })
}

/** Parses a message body. opts: { markdown?: boolean, names?: Iterable<string> (mentionable), me?: string } */
export function parseRich(text, opts = {}) {
  const o = { markdown: !!opts.markdown, me: opts.me || '', mentionRe: mentionRegex(opts.names || []) }
  const src = String(text ?? '').replace(/\r\n?/g, '\n')
  const out = []
  for (const seg of splitFences(src)) {
    if (seg.pre) {
      out.push({ t: 'pre', lang: seg.lang, v: seg.v })
      continue
    }
    const lines = seg.v.split('\n')
    lines.forEach((line, i) => {
      if (i > 0) out.push({ t: 'br' })
      if (!line) return
      if (o.markdown && /^>\s?/.test(line)) out.push({ t: 'quote', kids: inline(line.replace(/^>\s?/, ''), o) })
      else out.push(...inline(line, o))
    })
  }
  // a break right after a code block is just the block's own spacing
  return out.filter((t, i) => !(t.t === 'br' && (out[i - 1]?.t === 'pre' || out[i - 1]?.t === 'quote')))
}

/** Plain-text version for previews and notifications (no markup characters from emphasis, code fences dropped to `code`). */
export function plainText(text, markdown = false) {
  const walk = (toks) =>
    toks
      .map((t) => {
        switch (t.t) {
          case 'br':
            return ' '
          case 'pre':
            return ' ' + t.v + ' '
          case 'b':
          case 'i':
          case 's':
          case 'quote':
            return walk(t.kids)
          default:
            return t.v
        }
      })
      .join('')
  return walk(parseRich(text, { markdown })).replace(/\s+/g, ' ').trim()
}

/** DOM for tokens. `b` is a makeBuilder; hooks: { openLink(href), copy(text) }. */
export function renderRich(b, tokens, hooks = {}) {
  const { h, icon } = b
  const one = (t) => {
    switch (t.t) {
      case 'text':
        return t.v
      case 'br':
        return h('br')
      case 'code':
        return h('code', { class: 'cm-code' }, t.v)
      case 'mention':
        return h('span', { class: 'cm-mention' + (t.me ? ' me' : '') }, t.v)
      case 'b':
        return h('strong', null, t.kids.map(one))
      case 'i':
        return h('em', null, t.kids.map(one))
      case 's':
        return h('s', null, t.kids.map(one))
      case 'quote':
        return h('div', { class: 'cm-bq' }, t.kids.map(one))
      case 'link':
        return h(
          'a',
          {
            class: 'cm-link',
            href: t.href,
            rel: 'noopener noreferrer',
            title: t.href,
            on: {
              click: (e) => {
                e.preventDefault()
                e.stopPropagation()
                hooks.openLink?.(t.href)
              },
              auxclick: (e) => e.preventDefault(),
            },
          },
          t.v,
        )
      case 'pre': {
        const code = h('code', null, t.v)
        const btn = h('button', { class: 'cm-pre-copy', type: 'button', title: 'Copy code', 'aria-label': 'Copy code', on: { click: (e) => { e.stopPropagation(); hooks.copy?.(t.v, btn) } } }, icon('copy', 13))
        return h('div', { class: 'cm-pre' }, h('div', { class: 'cm-pre-bar' }, h('span', { class: 'cm-pre-lang' }, t.lang || 'code'), btn), h('pre', null, code))
      }
      default:
        return ''
    }
  }
  return tokens.map(one)
}
