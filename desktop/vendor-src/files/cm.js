// CodeMirror 6 for the Files block, bundled by build.mjs into renderer/vendor/files/cm.js (language packs split into chunks).
export { EditorState, EditorSelection, Compartment, StateField, StateEffect, RangeSet, RangeSetBuilder, Prec, Transaction } from '@codemirror/state'
export {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, gutter, GutterMarker,
  ViewPlugin, Decoration, placeholder, highlightSpecialChars, rectangularSelection, crosshairCursor,
} from '@codemirror/view'
export {
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll, toggleComment,
} from '@codemirror/commands'
export {
  openSearchPanel, closeSearchPanel, search, searchKeymap, highlightSelectionMatches, gotoLine, findNext, findPrevious,
} from '@codemirror/search'
export {
  syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap, indentUnit, StreamLanguage, LanguageDescription,
  foldAll, unfoldAll,
} from '@codemirror/language'
export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
export { classHighlighter } from '@lezer/highlight'
import { tagHighlighter, tags, classHighlighter as classHl, highlightTree } from '@lezer/highlight'

/** Extra classes classHighlighter lacks: function names (tok-fn). Combine with classHighlighter. */
export const fnHighlighter = tagHighlighter([
  { tag: tags.function(tags.variableName), class: 'tok-fn' },
  { tag: tags.function(tags.propertyName), class: 'tok-fn' },
  { tag: tags.definition(tags.function(tags.variableName)), class: 'tok-fn' },
  { tag: tags.standard(tags.variableName), class: 'tok-fn' },
  { tag: tags.self, class: 'tok-keyword' },
  { tag: tags.controlKeyword, class: 'tok-keyword' },
  { tag: tags.definitionKeyword, class: 'tok-keyword' },
  { tag: tags.moduleKeyword, class: 'tok-keyword' },
  { tag: tags.null, class: 'tok-number' },
])

import { StreamLanguage, LanguageDescription } from '@codemirror/language'

const legacy = (load, name) => load().then((m) => StreamLanguage.define(m[name]))

/** id -> () => Promise<Extension>. Each loader is its own chunk. */
const LOADERS = {
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  scss: () => legacy(() => import('@codemirror/legacy-modes/mode/css'), 'sCSS'),
  less: () => legacy(() => import('@codemirror/legacy-modes/mode/css'), 'less'),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown({ codeLanguages: CODE_LANGS })),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  rust: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  c: () => legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'c'),
  csharp: () => legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'csharp'),
  kotlin: () => legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'kotlin'),
  scala: () => legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'scala'),
  dart: () => legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'dart'),
  objectivec: () => legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'objectiveC'),
  shader: () => legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'shader'),
  shell: () => legacy(() => import('@codemirror/legacy-modes/mode/shell'), 'shell'),
  powershell: () => legacy(() => import('@codemirror/legacy-modes/mode/powershell'), 'powerShell'),
  toml: () => legacy(() => import('@codemirror/legacy-modes/mode/toml'), 'toml'),
  dockerfile: () => legacy(() => import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile'),
  ruby: () => legacy(() => import('@codemirror/legacy-modes/mode/ruby'), 'ruby'),
  lua: () => legacy(() => import('@codemirror/legacy-modes/mode/lua'), 'lua'),
  swift: () => legacy(() => import('@codemirror/legacy-modes/mode/swift'), 'swift'),
  diff: () => legacy(() => import('@codemirror/legacy-modes/mode/diff'), 'diff'),
  properties: () => legacy(() => import('@codemirror/legacy-modes/mode/properties'), 'properties'),
  cmake: () => legacy(() => import('@codemirror/legacy-modes/mode/cmake'), 'cmake'),
  r: () => legacy(() => import('@codemirror/legacy-modes/mode/r'), 'r'),
  perl: () => legacy(() => import('@codemirror/legacy-modes/mode/perl'), 'perl'),
  groovy: () => legacy(() => import('@codemirror/legacy-modes/mode/groovy'), 'groovy'),
  haskell: () => legacy(() => import('@codemirror/legacy-modes/mode/haskell'), 'haskell'),
  erlang: () => legacy(() => import('@codemirror/legacy-modes/mode/erlang'), 'erlang'),
  clojure: () => legacy(() => import('@codemirror/legacy-modes/mode/clojure'), 'clojure'),
  lisp: () => legacy(() => import('@codemirror/legacy-modes/mode/commonlisp'), 'commonLisp'),
  nginx: () => legacy(() => import('@codemirror/legacy-modes/mode/nginx'), 'nginx'),
  protobuf: () => legacy(() => import('@codemirror/legacy-modes/mode/protobuf'), 'protobuf'),
  tcl: () => legacy(() => import('@codemirror/legacy-modes/mode/tcl'), 'tcl'),
  julia: () => legacy(() => import('@codemirror/legacy-modes/mode/julia'), 'julia'),
}

/** Fenced-code languages inside Markdown: name/alias -> loader. */
const FENCES = {
  javascript: ['js', 'jsx', 'mjs', 'cjs', 'javascript'],
  typescript: ['ts', 'tsx', 'typescript'],
  json: ['json', 'jsonc', 'json5'],
  css: ['css'], scss: ['scss'], less: ['less'], html: ['html', 'htm', 'vue', 'svelte'], xml: ['xml', 'svg'],
  python: ['py', 'python'], rust: ['rs', 'rust'], cpp: ['cpp', 'c++', 'cc', 'cxx'], c: ['c', 'h'], java: ['java'],
  go: ['go', 'golang'], php: ['php'], sql: ['sql'], yaml: ['yaml', 'yml'], csharp: ['cs', 'csharp'], kotlin: ['kt', 'kotlin'],
  shell: ['sh', 'bash', 'zsh', 'shell', 'console'], powershell: ['ps1', 'powershell', 'pwsh'], toml: ['toml'],
  dockerfile: ['dockerfile'], ruby: ['rb', 'ruby'], lua: ['lua'], swift: ['swift'], diff: ['diff', 'patch'],
}
const CODE_LANGS = Object.entries(FENCES).map(([id, alias]) =>
  LanguageDescription.of({ name: id, alias, load: () => LOADERS[id]() }))

export const languageIds = Object.keys(LOADERS)

/** Resolve a language id (see files-util.js langForPath) to a CodeMirror extension; null when unknown. */
export function loadLanguage(id) {
  const f = LOADERS[id]
  return f ? f() : Promise.resolve(null)
}

/**
 * Syntax-highlight a snippet without an editor: resolves to [[text, className|'']...] covering `text` exactly.
 * Used for fenced code in the rendered Markdown view.
 */
export async function highlightSegments(text, id) {
  const ext = await loadLanguage(id)
  const lang = ext && (ext.language || ext)
  if (!lang || !lang.parser) return [[text, '']]
  const tree = lang.parser.parse(text)
  const out = []
  let pos = 0
  highlightTree(tree, [classHl, fnHighlighter], (from, to, cls) => {
    if (from > pos) out.push([text.slice(pos, from), ''])
    out.push([text.slice(from, to), cls])
    pos = to
  })
  if (pos < text.length) out.push([text.slice(pos), ''])
  return out
}
