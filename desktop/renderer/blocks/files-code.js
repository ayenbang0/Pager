// Source view of the Files block: CodeMirror 6 (vendored, vendor/files/cm.js) with a git change bar, line numbers, wrap and search.

let cmP = null
export const loadCM = () => (cmP ||= import('../vendor/files/cm.js'))

/**
 * @param {HTMLElement} host
 * @param {{text:string, lang:string|null, wrap:boolean, lineNumbers:boolean, tabSize:number, indent:string, readOnly?:boolean,
 *   plain?:boolean, onChange:(dirty:boolean)=>void, onCursor:(c:{line:number,col:number,sel:number})=>void}} o
 */
export async function createCodeEditor(host, o) {
  const cm = await loadCM()
  const { EditorState, EditorView, Compartment, StateField, StateEffect, RangeSet, Prec } = cm

  class Mark extends cm.GutterMarker {
    constructor(kind) { super(); this.kind = kind }
    eq(other) { return other.kind === this.kind }
    toDOM() {
      const d = document.createElement('div')
      d.className = 'fb-gm fb-gm-' + this.kind
      return d
    }
  }
  const MARKS = { added: new Mark('added'), modified: new Mark('modified'), removed: new Mark('removed') }
  const setMarks = StateEffect.define()
  const marksField = StateField.define({
    create: () => RangeSet.empty,
    update(set, tr) {
      set = set.map(tr.changes)
      for (const e of tr.effects) {
        if (!e.is(setMarks)) continue
        const doc = tr.state.doc
        const ranges = []
        for (const m of e.value) {
          if (m.kind === 'removed') {
            const ln = Math.min(Math.max(m.line, 1), doc.lines)
            ranges.push(MARKS.removed.range(doc.line(ln).from))
          } else {
            for (let l = Math.max(1, m.start); l <= Math.min(m.end, doc.lines); l++) ranges.push(MARKS[m.kind].range(doc.line(l).from))
          }
        }
        set = RangeSet.of(ranges, true)
      }
      return set
    },
  })

  const wrapC = new Compartment()
  const numsC = new Compartment()
  const langC = new Compartment()
  const indentC = new Compartment()
  const roC = new Compartment()

  let savedDoc = null
  let lastDirty = false
  let destroyed = false

  const report = (view) => {
    const sel = view.state.selection.main
    const line = view.state.doc.lineAt(sel.head)
    o.onCursor({ line: line.number, col: sel.head - line.from + 1, sel: Math.abs(sel.to - sel.from) })
  }

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: o.text,
      extensions: [
        marksField,
        cm.gutter({ class: 'fb-git', markers: (v) => v.state.field(marksField), renderEmptyElements: false }),
        numsC.of(o.lineNumbers ? [cm.lineNumbers(), cm.highlightActiveLineGutter()] : []),
        cm.highlightSpecialChars(),
        cm.history(),
        cm.drawSelection(),
        cm.dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        cm.indentOnInput(),
        cm.syntaxHighlighting(cm.classHighlighter),
        cm.syntaxHighlighting(cm.fnHighlighter),
        cm.bracketMatching(),
        cm.closeBrackets(),
        cm.rectangularSelection(),
        cm.crosshairCursor(),
        cm.highlightActiveLine(),
        cm.highlightSelectionMatches(),
        cm.search({ top: true }),
        indentC.of([EditorState.tabSize.of(o.tabSize), cm.indentUnit.of(o.indent)]),
        wrapC.of(o.wrap ? EditorView.lineWrapping : []),
        langC.of([]),
        roC.of(EditorState.readOnly.of(!!o.readOnly)),
        Prec.high(cm.keymap.of([
          { key: 'Mod-s', run: () => true }, // the block handles saving
          { key: 'Alt-z', run: () => true },
        ])),
        cm.keymap.of([...cm.closeBracketsKeymap, ...cm.defaultKeymap, ...cm.searchKeymap, ...cm.historyKeymap, ...cm.foldKeymap, cm.indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const dirty = !savedDoc || !u.state.doc.eq(savedDoc)
            if (dirty !== lastDirty) lastDirty = dirty
            o.onChange(dirty)
          }
          if (u.docChanged || u.selectionSet) report(u.view)
        }),
        EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': 'Source' }),
      ],
    }),
  })
  savedDoc = view.state.doc

  const setLang = async (id) => {
    if (!id || o.plain) return
    try {
      const ext = await cm.loadLanguage(id)
      if (!destroyed && ext) view.dispatch({ effects: langC.reconfigure(ext) })
    } catch { /* no highlighting */ }
  }
  setLang(o.lang)
  report(view)

  return {
    view,
    getText: () => view.state.doc.toString(),
    /** Replace the document with `text`, touching only the differing middle so the caret, scroll and undo history survive. */
    setText(text) {
      const cur = view.state.doc.toString()
      if (cur === text) return
      let a = 0
      const max = Math.min(cur.length, text.length)
      while (a < max && cur.charCodeAt(a) === text.charCodeAt(a)) a++
      let b = 0
      while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++
      view.dispatch({ changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) } })
    },
    markSaved() { savedDoc = view.state.doc; lastDirty = false; o.onChange(false) },
    isDirty: () => !savedDoc || !view.state.doc.eq(savedDoc),
    setMarks(list) { view.dispatch({ effects: setMarks.of(list || []) }) },
    setWrap(on) { view.dispatch({ effects: wrapC.reconfigure(on ? EditorView.lineWrapping : []) }) },
    setLineNumbers(on) { view.dispatch({ effects: numsC.reconfigure(on ? [cm.lineNumbers(), cm.highlightActiveLineGutter()] : []) }) },
    setIndent(tabSize, unit) { view.dispatch({ effects: indentC.reconfigure([EditorState.tabSize.of(tabSize), cm.indentUnit.of(unit)]) }) },
    setLang,
    goto(line, col = 1) {
      const doc = view.state.doc
      const ln = doc.line(Math.min(Math.max(1, line), doc.lines))
      const pos = Math.min(ln.from + Math.max(0, col - 1), ln.to)
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    },
    search: () => cm.openSearchPanel(view),
    focus: () => view.focus(),
    replaceAll(fn) { const t = fn(view.state.doc.toString()); this.setText(t) },
    destroy() { destroyed = true; view.destroy() },
  }
}
