import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Box, useInput, usePaste } from 'ink'
import { copyText, readClipboard } from '../../platform/clipboard.js'
import type { Anchor } from '../../docs/crdt.js'
import { clampCursor, handleKey, initialVim, selection, type Edit, type KeyInput, type VimState } from '../../docs/vim.js'
import { diffText, indexAtRow, lineKinds, rowOf, wrapRows } from '../../docs/view.js'
import type { Engine } from '../../app/engine.js'
import type { Theme } from '../theme/themes.js'
import { commandRow, docRowSegs, editorRowSegs, emptyListRows, frameBottom, frameTop, listFooter, listSummary, modePill, statusRow, syncPill, type DocRowInput, type Peer } from './docsChrome.js'
import { BandTitle } from '../kit/kit.js'
import { colorFor } from '../theme/look.js'
import { SegLine } from '../kit/SegLine.js'
import { useTheme } from '../theme/theme.js'

/** What the app forwards to the panel: the mouse is owned by the app, not by components. */
export interface DocsCtl {
  click(x: number, y: number): void
  wheel(direction: 1 | -1): void
}

export interface DocsChords {
  onPalette(): void
  onSidebar(): void
  onSwitch(direction: 1 | -1): void
  onHelp(): void
  onQuit(): void
}

interface Props extends DocsChords {
  engine: Engine
  width: number
  /** Rows available, including the status row. */
  height: number
  /** 1-based screen column of the panel's first cell and row of its first body row (for mouse mapping). */
  left: number
  top: number
  active: boolean
  ctl: RefObject<DocsCtl | null>
  /** Highlighted row of the list. */
  selected: number
  onMove(delta: number): void
}

/** Lines scrolled per wheel notch. */
const WHEEL_ROWS = 3

/** How often the editor checks whether its edits have gone out (the store publishes them from a timer and emits nothing). */
const SYNC_POLL_MS = 400

/** The Docs tab: a list of shared documents, or the vim-style editor for the open one. */
export function DocsPanel(props: Props) {
  const id = props.engine.openedDoc()
  return id === null ? <DocList {...props} /> : <DocEditor key={id} {...props} docId={id} />
}

/** Collaborators editing a document right now, each with the color their messages use. */
function peersOf(engine: Engine, id: string, theme: Theme): Peer[] {
  const keys = engine.docs.activeEditors(id)
  return engine.docEditors(id).map((name, i) => ({ name, color: colorFor(theme, keys[i] ?? '') }))
}

/** The document list. Selection and keys belong to the app (the prompt stays active below the list so slash commands keep working). */
function DocList({ engine, width, height, top, ctl, selected, onMove }: Props) {
  const theme = useTheme()
  const docs = engine.docList()
  const at = Math.min(selected, Math.max(0, docs.length - 1))
  const body = Math.max(1, height - 3)
  const first = Math.min(Math.max(0, at - body + 1), Math.max(0, docs.length - body))

  ctl.current = {
    click: (_x, y) => {
      const doc = docs[first + (y - top - 2)]
      if (doc) engine.openDoc(doc.id)
    },
    wheel: (dir) => onMove(-dir),
  }

  const now = Date.now()
  const inputs = docs.map((d): DocRowInput => ({ name: d.name, where: d.where, length: d.length, lastEdit: d.lastEdit, peers: peersOf(engine, d.id, theme), unsent: engine.docs.unsent(d.id) }))
  const summary = { docs: docs.length, live: inputs.filter((d) => d.peers.length > 0).length, unsent: inputs.filter((d) => d.unsent).length }

  return (
    <Box height={height} width={width} flexDirection="column" overflow="hidden">
      <BandTitle title="DOCUMENTS" width={width} />
      <SegLine segs={listSummary(summary, width, theme)} />
      {docs.length === 0
        ? emptyListRows(width, theme).map((segs, i) => <SegLine key={i} segs={segs} />)
        : inputs.slice(first, first + body).map((input, i) => <SegLine key={docs[first + i]?.id ?? i} segs={docRowSegs(input, first + i === at, width, now, theme)} />)}
      <Box flexGrow={1} />
      <SegLine segs={listFooter(width, theme)} />
    </Box>
  )
}

/** The vim-style editor in an accent frame: mode pill and sync state on the top border, the text with line numbers, a status row of pills under it. */
function DocEditor({ engine, docId, width, height, left, top, active, ctl, onPalette, onSidebar, onSwitch, onHelp, onQuit }: Props & { docId: string }) {
  const theme = useTheme()
  const docs = engine.docs
  const info = docs.info(docId)
  const text = docs.text(docId)
  const vimRef = useRef<VimState>(initialVim())
  const [, setVimState] = useState<VimState>(vimRef.current)
  /** The cursor, the visual anchor and the first visible row follow their characters through other people's edits. */
  const pins = useRef({ cursor: docs.anchorAt(docId, 0, true), anchor: docs.anchorAt(docId, 0, true) })
  const topRef = useRef(docs.anchorAt(docId, 0, true))
  const [, setTop] = useState(topRef.current)
  const scrollRef = useRef(0)
  const lastText = useRef(text)
  /** An anchor for `pos` in `t`; in an empty text it pins the start, so text that arrives later does not drag it to the end. */
  const anchor = (pos: number, after: boolean, t: string): Anchor => docs.anchorAt(docId, pos, after || t.length === 0)
  const scrollTo = (a: Anchor): void => {
    topRef.current = a
    setTop(a)
  }
  /** The vim state, with the cursor and anchor moved onto wherever their characters are now (collaborators and agents edit the text). */
  const current = (): VimState => {
    const t = docs.text(docId)
    if (t === lastText.current) return vimRef.current
    lastText.current = t
    vimRef.current = clampCursor({ ...vimRef.current, cursor: docs.positionOf(docId, pins.current.cursor), anchor: docs.positionOf(docId, pins.current.anchor) }, t)
    return vimRef.current
  }
  const vim = current()
  const unsent = docs.unsent(docId)
  // Publishing happens on a timer inside the store, so nothing re-renders when it finishes: look again shortly.
  const [, setPolled] = useState(unsent)
  useEffect(() => {
    const timer = setInterval(() => setPolled(docs.unsent(docId)), SYNC_POLL_MS)
    return () => clearInterval(timer)
  }, [docs, docId])
  const peers = peersOf(engine, docId, theme)

  // Top border, bottom border and the status row take three of the rows.
  const body = Math.max(1, height - 3)
  const lines = text.split('\n').length
  const gutter = Math.max(3, String(lines).length + 1)
  const textWidth = Math.max(8, width - 2 - gutter)
  const rows = useMemo(() => wrapRows(text, textWidth), [text, textWidth])
  const kinds = useMemo(() => lineKinds(text), [text])
  const scroll = rowOf(rows, docs.positionOf(docId, topRef.current))
  scrollRef.current = scroll

  const commit = (next: VimState, nextText: string, reveal: boolean): void => {
    vimRef.current = next
    setVimState(next)
    lastText.current = nextText
    pins.current = { cursor: anchor(next.cursor, next.mode === 'insert', nextText), anchor: anchor(next.anchor, false, nextText) }
    if (!reveal) return
    const rowsNext = wrapRows(nextText, textWidth)
    const top = rowOf(rowsNext, docs.positionOf(docId, topRef.current))
    const r = rowOf(rowsNext, next.cursor)
    const row = r < top ? r : r >= top + body ? r - body + 1 : top
    scrollTo(anchor(rowsNext[row]?.start ?? 0, false, nextText))
  }

  const applyEdits = (edits: readonly Edit[]): void => {
    for (const e of edits) {
      if (e.del > 0) docs.delete(docId, e.pos, e.del)
      if (e.ins !== '') docs.insert(docId, e.pos, e.ins)
    }
  }

  const note = (message: string): void => commit({ ...current(), message }, docs.text(docId), false)

  const history = (dir: 'undo' | 'redo'): void => {
    const v = current()
    const before = docs.text(docId)
    const worked = dir === 'undo' ? docs.undo(docId) : docs.redo(docId)
    const after = docs.text(docId)
    const cursor = worked ? diffText(before, after).pos : v.cursor
    const next = clampCursor({ ...v, mode: v.mode === 'insert' ? 'insert' : 'normal', cursor, message: worked ? '' : `nothing to ${dir}` }, after)
    commit(next, after, true)
  }

  const feed = (key: KeyInput): void => {
    const v = current()
    const before = docs.text(docId)
    const result = handleKey(v, key, { text: before, height: body })
    applyEdits(result.edits)
    if (result.state.mode !== 'insert') docs.endGroup(docId)
    for (const effect of result.effects) {
      if (effect.kind === 'undo') return history('undo')
      if (effect.kind === 'redo') return history('redo')
      if (effect.kind === 'yank') copyText(effect.text)
      else if (effect.kind === 'close') {
        docs.flush(docId)
        return engine.openDoc(null)
      } else if (effect.kind === 'quit') return onQuit()
      else if (effect.kind === 'rename') {
        const err = docs.rename(docId, effect.name)
        if (err) result.state.message = err
      }
    }
    commit(result.state, docs.text(docId), true)
  }

  const copy = (): void => {
    const v = current()
    const t = docs.text(docId)
    const s = selection(v, t)
    if (s) copyText(t.slice(s.start, s.end))
    else {
      const start = t.lastIndexOf('\n', v.cursor - 1) + 1
      const end = t.indexOf('\n', v.cursor)
      copyText(t.slice(start, end < 0 ? t.length : end))
    }
    note('copied')
  }

  const paste = (pasted: string): void => {
    const v = current()
    if (pasted === '' || v.mode === 'command' || v.mode === 'search') return
    if (v.mode === 'insert') {
      applyEdits([{ pos: v.cursor, del: 0, ins: pasted }])
      return commit({ ...v, cursor: v.cursor + pasted.length, message: '' }, docs.text(docId), true)
    }
    if (v.mode !== 'normal') {
      // Pasting over a visual selection replaces it, as in most editors.
      feed({ input: 'd' })
      return paste(pasted)
    }
    vimRef.current = { ...v, register: { text: pasted, line: pasted.endsWith('\n') } }
    feed({ input: 'p' })
  }

  ctl.current = {
    click: (x, y) => {
      const v = current()
      if (v.mode === 'command' || v.mode === 'search') return
      const at = y - top - 1
      const row = scroll + at
      if (at < 0 || at >= body || row >= rows.length) return
      const index = indexAtRow(rows, row, x - (left + 1 + gutter))
      const t = docs.text(docId)
      commit(clampCursor({ ...v, cursor: index, goal: -1, pending: '', message: '' }, t), t, false)
    },
    wheel: (dir) => {
      const n = Math.min(Math.max(0, rows.length - 1), Math.max(0, scrollRef.current - dir * WHEEL_ROWS))
      scrollRef.current = n
      scrollTo(anchor(rows[n]?.start ?? 0, false, text))
    },
  }

  usePaste((pasted) => paste(pasted), { isActive: active })
  useInput(
    (input, key) => {
      if (key.eventType === 'release') return
      // Mouse reports (ESC [ < b ; x ; y M) also reach this hook; they must never run as editor commands or type into the text.
      if (/\[<\d*;?\d*;?\d*[Mm]?/.test(input) && input.includes('[<')) return
      if (key.meta && key.upArrow) return onSwitch(-1)
      if (key.meta && key.downArrow) return onSwitch(1)
      if (key.ctrl) {
        switch (input) {
          case 'p':
            return onPalette()
          case 'b':
            return onSidebar()
          case 'g':
            return onHelp()
          case 'n':
            return onSwitch(1)
          case 'o':
            return onSwitch(-1)
          case 'c':
            return copy()
          case 'z':
            return history('undo')
          case 'y':
            return history('redo')
          case 'v':
            return void readClipboard().then(paste)
          default:
            return feed({ input, ctrl: true })
        }
      }
      const named: KeyInput['named'] = key.escape
        ? 'escape'
        : key.return
          ? 'return'
          : key.backspace
            ? 'backspace'
            : key.delete
              ? 'delete'
              : key.leftArrow
                ? 'left'
                : key.rightArrow
                  ? 'right'
                  : key.upArrow
                    ? 'up'
                    : key.downArrow
                      ? 'down'
                      : key.home
                        ? 'home'
                        : key.end
                          ? 'end'
                          : key.pageUp
                            ? 'pageUp'
                            : key.pageDown
                              ? 'pageDown'
                              : key.tab
                                ? 'tab'
                                : undefined
      if (named !== undefined) return feed({ input: '', named })
      if (key.meta || input === '') return
      // Fast typing can deliver several characters at once; outside insert mode each one is its own command.
      if (vimRef.current.mode === 'insert' || input.length === 1) return feed({ input })
      for (const ch of input) feed({ input: ch })
    },
    { isActive: active },
  )

  const sel = selection(vim, text)
  const cursorRow = rowOf(rows, vim.cursor)
  const cursorLine = rows[cursorRow]?.line ?? 0
  const lineStart = rows.find((r) => r.line === cursorLine)?.start ?? 0
  const visible = rows.slice(scroll, scroll + body)
  const first = theme.gradient[0] ?? theme.accent
  const last = theme.gradient.at(-1) ?? theme.accent
  const typing = vim.mode === 'command' || vim.mode === 'search'

  return (
    <Box height={height} width={width} flexDirection="column" overflow="hidden">
      <SegLine segs={frameTop(width, modePill(vim.mode, theme), syncPill(unsent, theme), theme)} />
      <Box height={body} width={width} flexDirection="column" overflow="hidden" borderStyle="round" borderTop={false} borderBottom={false} borderLeftColor={first} borderRightColor={last}>
        {visible.map((row) => (
          <SegLine key={row.start} segs={editorRowSegs(text, row, { gutter, onCursorLine: row.line === cursorLine, kind: kinds[row.line], cursor: vim.cursor, sel }, theme)} />
        ))}
      </Box>
      <SegLine segs={frameBottom(width, theme)} />
      <SegLine
        segs={
          typing
            ? commandRow(vim.mode === 'command' ? ':' : '/', vim.cmdline, width, theme)
            : statusRow({ line: cursorLine + 1, col: vim.cursor - lineStart + 1, name: info?.name ?? 'document', peers, message: vim.message, pending: vim.pending }, width, theme)
        }
      />
    </Box>
  )
}
