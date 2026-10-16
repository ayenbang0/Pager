import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Box, Text, useInput, usePaste } from 'ink'
import { copyText, readClipboard } from '../docs/clipboard.js'
import { clampCursor, handleKey, initialVim, selection, type Edit, type KeyInput, type VimState } from '../docs/vim.js'
import { diffText, indexAtRow, lineKinds, rowOf, rowPieces, shiftIndex, wrapRows, type LineKind } from '../docs/view.js'
import type { Engine } from '../engine.js'
import { useTheme } from './theme.js'

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

const ago = (ms: number, now: number): string => {
  if (ms === 0) return 'new'
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** The Docs tab: a list of shared documents, or the vim-style editor for the open one. */
export function DocsPanel(props: Props) {
  const id = props.engine.openedDoc()
  return id === null ? <DocList {...props} /> : <DocEditor key={id} {...props} docId={id} />
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

  return (
    <Box height={height} width={width} flexDirection="column" overflow="hidden" paddingX={1}>
      <Box flexShrink={0}>
        <Text bold color={theme.accent}>
          Documents
        </Text>
        <Text dimColor> · shared Markdown, edited live with everyone in the chat</Text>
      </Box>
      <Text> </Text>
      {docs.length === 0 ? (
        <Text dimColor>No documents yet. /doc new &lt;name&gt; starts a private one; /doc new &lt;name&gt; in &lt;chat&gt; shares it.</Text>
      ) : (
        docs.slice(first, first + body).map((d, i) => {
          const current = first + i === at
          return (
            <Box key={d.id}>
              <Text wrap="truncate-end" inverse={current} color={current ? undefined : theme.accent}>
                {current ? '▸ ' : '  '}
                {d.name}
              </Text>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {d.where} · {d.length} chars · {ago(d.lastEdit, Date.now())}
              </Text>
            </Box>
          )
        })
      )}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">
        PgUp/PgDn or click to pick · Enter on an empty prompt opens · /doc rm name deletes
      </Text>
    </Box>
  )
}

const MODE_LABEL: Record<VimState['mode'], string> = {
  normal: 'NORMAL',
  insert: 'INSERT',
  visual: 'VISUAL',
  vline: 'V-LINE',
  command: 'COMMAND',
  search: 'SEARCH',
}

function DocEditor({ engine, docId, width, height, left, top, active, ctl, onPalette, onSidebar, onSwitch, onHelp, onQuit }: Props & { docId: string }) {
  const theme = useTheme()
  const docs = engine.docs
  const info = docs.info(docId)
  const text = docs.text(docId)
  const [vim, setVimState] = useState<VimState>(() => initialVim())
  const vimRef = useRef(vim)
  const [scroll, setScroll] = useState(0)
  const lastText = useRef(text)

  const body = Math.max(1, height - 1)
  const lines = text.split('\n').length
  const gutter = Math.max(3, String(lines).length + 1)
  const textWidth = Math.max(8, width - 2 - gutter)
  const rows = useMemo(() => wrapRows(text, textWidth), [text, textWidth])
  const kinds = useMemo(() => lineKinds(text), [text])

  const commit = (next: VimState, nextText: string, reveal: boolean): void => {
    vimRef.current = next
    setVimState(next)
    lastText.current = nextText
    if (!reveal) return
    const r = rowOf(wrapRows(nextText, textWidth), next.cursor)
    setScroll((s) => (r < s ? r : r >= s + body ? r - body + 1 : s))
  }

  // Edits by collaborators (or agents) shift the cursor so it keeps its character.
  useEffect(() => {
    if (lastText.current === text) return
    const change = diffText(lastText.current, text)
    lastText.current = text
    const v = vimRef.current
    const next = clampCursor({ ...v, cursor: shiftIndex(v.cursor, change), anchor: shiftIndex(v.anchor, change) }, text)
    vimRef.current = next
    setVimState(next)
  }, [text])

  const applyEdits = (edits: readonly Edit[]): void => {
    for (const e of edits) {
      if (e.del > 0) docs.delete(docId, e.pos, e.del)
      if (e.ins !== '') docs.insert(docId, e.pos, e.ins)
    }
  }

  const note = (message: string): void => commit({ ...vimRef.current, message }, docs.text(docId), false)

  const history = (dir: 'undo' | 'redo'): void => {
    const before = docs.text(docId)
    const worked = dir === 'undo' ? docs.undo(docId) : docs.redo(docId)
    const after = docs.text(docId)
    const v = vimRef.current
    const cursor = worked ? diffText(before, after).pos : v.cursor
    const next = clampCursor({ ...v, mode: v.mode === 'insert' ? 'insert' : 'normal', cursor, message: worked ? '' : `nothing to ${dir}` }, after)
    commit(next, after, true)
  }

  const feed = (key: KeyInput): void => {
    const before = docs.text(docId)
    const result = handleKey(vimRef.current, key, { text: before, height: body })
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
    const v = vimRef.current
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
    const v = vimRef.current
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
      const v = vimRef.current
      if (v.mode === 'command' || v.mode === 'search') return
      const row = scroll + (y - top)
      if (y - top < 0 || y - top >= body || row >= rows.length) return
      const index = indexAtRow(rows, row, x - (left + 1 + gutter))
      commit(clampCursor({ ...v, cursor: index, goal: -1, pending: '', message: '' }, text), text, false)
    },
    wheel: (dir) => setScroll((s) => Math.min(Math.max(0, rows.length - 1), Math.max(0, s - dir * WHEEL_ROWS))),
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
  const editors = engine.docEditors(docId)
  const modeColor = vim.mode === 'insert' ? theme.success : vim.mode === 'visual' || vim.mode === 'vline' ? theme.warning : theme.accent
  const style = (kind: LineKind | undefined): { bold?: boolean; dim?: boolean; italic?: boolean; color?: string } =>
    kind === 'heading' ? { bold: true, color: theme.accent } : kind === 'code' ? { color: theme.info } : kind === 'quote' ? { dim: true, italic: true } : kind === 'rule' ? { dim: true } : {}

  return (
    <Box height={height} width={width} flexDirection="column" overflow="hidden">
      <Box height={body} flexDirection="column" overflow="hidden" paddingX={1}>
        {visible.map((row) => {
          const s = style(kinds[row.line])
          const pieces = rowPieces(text, row, vim.cursor, sel)
          return (
            <Text key={row.start} wrap="truncate-end">
              <Text color={row.line === cursorLine ? theme.accent : undefined} dimColor={row.line !== cursorLine}>
                {row.first ? `${row.line + 1}`.padStart(gutter - 1) + ' ' : ' '.repeat(gutter)}
              </Text>
              {pieces.length === 0 ? <Text> </Text> : null}
              {pieces.map((p, i) => (
                <Text
                  key={i}
                  bold={s.bold || p.cursor}
                  dimColor={s.dim}
                  italic={s.italic}
                  color={s.color}
                  inverse={p.cursor}
                  backgroundColor={p.selected && !p.cursor ? theme.border : undefined}
                >
                  {p.text}
                </Text>
              ))}
            </Text>
          )
        })}
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        {vim.mode === 'command' || vim.mode === 'search' ? (
          <Text wrap="truncate-end">
            {vim.mode === 'command' ? ':' : '/'}
            {vim.cmdline}
            <Text inverse> </Text>
          </Text>
        ) : (
          <>
            <Text wrap="truncate-end">
              <Text bold inverse color={modeColor}>
                {` ${MODE_LABEL[vim.mode]} `}
              </Text>
              <Text> {info?.name ?? 'document'}</Text>
              <Text dimColor>
                {' '}
                {cursorLine + 1}:{vim.cursor - lineStart + 1}
              </Text>
              {editors.length > 0 ? <Text color={theme.online}> ● {editors.join(', ')} editing</Text> : null}
            </Text>
            <Text dimColor wrap="truncate-end">
              {vim.message !== '' ? vim.message : vim.pending}
            </Text>
          </>
        )}
      </Box>
    </Box>
  )
}
