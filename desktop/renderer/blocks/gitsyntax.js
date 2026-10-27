// A deliberately small, per-line syntax colouring for the git diff view: comments, strings, numbers, keywords, calls and
// type-like names. No DOM and no state across lines (a block comment that spans lines colours only the lines that start
// with its markers), so it is cheap enough to run over every visible diff line. See gitsyntax.test.mjs.

const C_KW = 'abstract as async await break case catch class const continue debugger default delete do else enum export extends false final finally fn for from func function go if implements import in instanceof interface let match mod mut new nil null of override package private protected pub public readonly return self static struct super switch this throw true try type typeof undefined use var void where while with yield impl trait crate unsafe dyn ref move loop defer fallthrough select chan range int string bool float double char long short byte unsigned signed struct union namespace using virtual operator template typename'
const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self cls print'
const SH_KW = 'if then else elif fi for while do done case esac function in return export local echo cd set unset source alias exit true false null'
const CSS_KW = 'important inherit initial unset none auto'

const set = (s) => new Set(s.split(/\s+/).filter(Boolean))
const KEYWORDS = { c: set(C_KW), py: set(PY_KW), sh: set(SH_KW), css: set(CSS_KW), none: new Set() }

const BY_EXT = {
  js: 'c', jsx: 'c', mjs: 'c', cjs: 'c', ts: 'c', tsx: 'c', mts: 'c', cts: 'c', java: 'c', kt: 'c', kts: 'c', go: 'c', rs: 'c', c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cs: 'c', swift: 'c', php: 'c', dart: 'c', scala: 'c', vue: 'c', svelte: 'c',
  json: 'json', jsonc: 'json', json5: 'json',
  py: 'py', pyi: 'py', rb: 'py', pl: 'py', r: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh', psm1: 'sh', yml: 'sh', yaml: 'sh', toml: 'sh', ini: 'sh', conf: 'sh', env: 'sh', dockerfile: 'sh', makefile: 'sh', mk: 'sh', gitignore: 'sh',
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', xhtml: 'html', vue2: 'html',
  md: 'none', txt: 'none', mdx: 'none',
}

/** The language family of a path: 'c' | 'json' | 'py' | 'sh' | 'css' | 'html' | 'none'. */
export function langOf(path) {
  const name = String(path ?? '').split('/').pop().toLowerCase()
  if (name === 'dockerfile' || name === 'makefile') return 'sh'
  const ext = name.includes('.') ? name.split('.').pop() : ''
  return BY_EXT[ext] ?? 'none'
}

const ID_START = /[A-Za-z_$]/
const ID = /[A-Za-z0-9_$]/
const DIGIT = /[0-9]/

/**
 * Splits one line into tokens `{ k, s }` whose texts concatenate back to the line. `k` is '' (plain), 'com', 'str', 'num',
 * 'kw', 'fn' (identifier followed by "("), 'ty' (Capitalised identifier) or 'tag' (HTML/XML tag).
 */
export function tokenize(text, lang) {
  if (!text || lang === 'none') return text ? [{ k: '', s: text }] : []
  const out = []
  let plain = ''
  const flush = () => {
    if (plain) {
      out.push({ k: '', s: plain })
      plain = ''
    }
  }
  const push = (k, s) => {
    flush()
    out.push({ k, s })
  }
  const kws = lang === 'json' ? new Set(['true', 'false', 'null']) : (KEYWORDS[lang] ?? KEYWORDS.c)
  const slashComments = lang === 'c' || lang === 'css' || lang === 'json'
  const hashComments = lang === 'py' || lang === 'sh'
  const n = text.length
  // A line that continues a block comment: starts with "*", "/*" or "*/" (after indentation).
  if ((lang === 'c' || lang === 'css') && /^\s*(\/\*|\*(?!\w)|\*\/)/.test(text)) return [{ k: 'com', s: text }]
  if (lang === 'html' && /^\s*<!--/.test(text)) return [{ k: 'com', s: text }]
  let i = 0
  while (i < n) {
    const c = text[i]
    if (slashComments && c === '/' && text[i + 1] === '/' && lang !== 'json') {
      push('com', text.slice(i))
      break
    }
    if (slashComments && c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      push('com', text.slice(i, stop))
      i = stop
      continue
    }
    if (hashComments && c === '#' && (i === 0 || /\s/.test(text[i - 1]) || lang === 'py')) {
      push('com', text.slice(i))
      break
    }
    if (lang === 'html' && c === '<') {
      const end = text.indexOf('>', i)
      const stop = end < 0 ? n : end + 1
      // Tag names and attributes stay one token; strings inside are not split further (light on purpose).
      push('tag', text.slice(i, stop))
      i = stop
      continue
    }
    if (c === '"' || c === "'" || (c === '`' && lang === 'c')) {
      let j = i + 1
      while (j < n && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      const stop = Math.min(n, j + 1)
      push('str', text.slice(i, stop))
      i = stop
      continue
    }
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(text[i + 1] ?? '') && !ID.test(text[i - 1] ?? ''))) {
      if (i > 0 && ID.test(text[i - 1])) {
        plain += c
        i++
        continue
      }
      let j = i + 1
      while (j < n && /[0-9a-fA-FxXoObB_.eE]/.test(text[j])) j++
      push('num', text.slice(i, j))
      i = j
      continue
    }
    if (ID_START.test(c)) {
      let j = i + 1
      while (j < n && ID.test(text[j])) j++
      const word = text.slice(i, j)
      if (kws.has(word)) push('kw', word)
      else if (text[j] === '(') push('fn', word)
      else if (lang !== 'css' && lang !== 'json' && /^[A-Z][a-z]/.test(word)) push('ty', word)
      else plain += word
      i = j
      continue
    }
    plain += c
    i++
  }
  flush()
  return out
}
