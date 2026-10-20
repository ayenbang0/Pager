import { useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react'
import { lensFor, renderLens } from '../../tools/lens/lens.js'
import { Box, Text, usePaste, useStdin } from 'ink'
import type { Engine, Toast } from '../../app/engine.js'
import { copyText } from '../../platform/clipboard.js'
import { classifyInput, encodeMouse, type InputModes } from '../../tools/terminal/keys.js'
import type { PtySession } from '../../tools/terminal/pty.js'
import { fitSegs, type Seg } from '../kit/segs.js'
import { SegLine } from '../kit/SegLine.js'
import { useTheme } from '../theme/theme.js'
import { gutterFor, moveSelection, type BlockSpan } from './blockNav.js'

/** What the app forwards to the panel: the mouse is owned by the app, not by components. */
export interface TermCtl {
  click(x: number, y: number): void
  wheel(direction: 1 | -1): void
}

interface Props {
  engine: Engine
  id: string
  width: number
  /** Rows available; the panel draws no prompt. */
  height: number
  /** 1-based screen column of the panel's first cell and row of its first body row (for mouse mapping). */
  left: number
  top: number
  active: boolean
  ctl: RefObject<TermCtl | null>
  onPalette(): void
  onSwitch(direction: 1 | -1): void
}

const GUTTER = 2
const WHEEL_ROWS = 3
const NO_MODES: InputModes = { appCursor: false, focus: false }
const BLOCK_KEYS = '↑↓ select  c output  y command  r rerun'

/** A shell on a PTY: the grid is drawn from the headless terminal, and raw stdin chunks go to the child except four Alt chords. */
export function TerminalPanel({ engine, id, width, height, left, top, active, ctl, onPalette, onSwitch }: Props) {
  const theme = useTheme()
  const { stdin, setRawMode } = useStdin()
  const info = engine.terms.info(id)
  const session: PtySession | undefined = engine.terms.get(id)
  const [mode, setMode] = useState<'live' | 'blocks'>('live')
  const [selected, setSelected] = useState<number | null>(null)
  const [showLens, setShowLens] = useState(false)
  const notified = useRef(false)
  const inner = Math.max(2, width - GUTTER)
  const exited = info?.exited ?? null
  const selBlock = mode === 'blocks' ? session?.blocks.list().find((b) => b.id === selected) : undefined
  const lensData = useMemo(() => (selBlock === undefined || session === undefined ? null : lensFor(selBlock.command, session.blocks.text(selBlock.id))), [session, selBlock?.id])

  useEffect(() => {
    engine.terms.setSize(inner, height)
  }, [engine, inner, height, session])
  useEffect(() => {
    setMode('live')
    setSelected(null)
    setShowLens(false)
  }, [id, session])

  const toast = (kind: Toast['kind'], text: string): void => void engine.emit('toast', { kind, text } satisfies Toast)

  const leave = (): void => {
    setMode('live')
    setSelected(null)
    setShowLens(false)
    session?.scrollToBottom()
  }
  const select = (blockId: number): void => {
    if (session === undefined || blockId < 0) return
    setSelected(blockId)
    const r = session.blocks.rows(blockId)
    if (r !== undefined) session.scrollTo(r.first)
  }
  const enterBlocks = (): void => {
    if (session === undefined) return
    const done = session.blocks.list().filter((b) => b.exit !== null)
    if (done.length === 0) {
      if (!session.shell.integrated && !notified.current) {
        notified.current = true
        toast('info', 'No command blocks: this shell has no integration')
      } else toast('info', 'No command blocks yet')
      return
    }
    setMode('blocks')
    select(moveSelection(done.map((b) => b.id), null, -1))
  }

  const blockKey = (chunk: string): void => {
    if (session === undefined) return
    if (showLens) {
      if (chunk === '\x1b' || chunk === 'q') setShowLens(false)
      return
    }
    if (chunk === '\x1b' || chunk === '\x1bk') return leave()
    const done = session.blocks.list().filter((b) => b.exit !== null)
    const ids = done.map((b) => b.id)
    const block = done.find((b) => b.id === selected)
    if (chunk === '\x1b[A' || chunk === 'k') return select(moveSelection(ids, selected, -1))
    if (chunk === '\x1b[B' || chunk === 'j') return select(moveSelection(ids, selected, 1))
    if (block === undefined) return
    if (chunk === 'c') {
      copyText(session.blocks.text(block.id))
      toast('info', 'Copied output')
    } else if (chunk === 'y') {
      copyText(block.command)
      toast('info', 'Copied command')
    } else if (chunk === 'r') {
      if (session.blocks.running() !== undefined) return toast('warn', 'A command is still running')
      leave()
      session.write(`${block.command}\r`)
    } else if (chunk === 'l') {
      if (lensData === null) toast('info', 'No lens for this command')
      else setShowLens(true)
    } else if (chunk === 'e') {
      leave()
      engine.explainBlock(id, block.id)
    }
  }

  const latest = useRef<(chunk: string) => void>(() => {})
  latest.current = (chunk) => {
    if (chunk.includes('\x1b[200~')) return // the paste channel delivers it
    const input = classifyInput(chunk, session?.modes ?? NO_MODES)
    if ('chord' in input) {
      if (input.chord === 'prev') return onSwitch(-1)
      if (input.chord === 'next') return onSwitch(1)
      if (input.chord === 'palette') return onPalette()
      if (mode === 'blocks') return leave()
      return enterBlocks()
    }
    if (session === undefined) return
    if (exited !== null) {
      if (input.pty.includes('\r')) void engine.terms.restart(id)
      return
    }
    if (mode === 'blocks') return blockKey(chunk)
    if (input.pty !== '') session.write(input.pty)
  }
  useEffect(() => {
    if (!active) return
    setRawMode(true)
    // Raw chunks, not Ink's parsed keys: the shell needs the exact bytes. (useMouse and Ctrl+H read stdin the same way.)
    const onData = (chunk: Buffer | string): void => latest.current(String(chunk))
    stdin.on('data', onData)
    return () => {
      stdin.off('data', onData)
      setRawMode(false)
    }
  }, [active, stdin, setRawMode])
  usePaste((text) => session?.paste(text), { isActive: active && session !== undefined && exited === null && mode === 'live' })

  ctl.current = {
    click: (x, y) => {
      if (session === undefined || mode !== 'live') return
      const col = x - left - GUTTER + 1
      const row = y - top + 1
      if (col < 1 || row < 1 || !session.screen().mouse) return
      session.write(encodeMouse('press', col, row) + encodeMouse('release', col, row))
    },
    wheel: (direction) => {
      if (session === undefined) return
      const screen = session.screen()
      if (screen.mouse) return session.write(encodeMouse(direction > 0 ? 'wheelUp' : 'wheelDown', 1, 1))
      if (screen.alt) {
        const arrow = (session.modes.appCursor ? '\x1bO' : '\x1b[') + (direction > 0 ? 'A' : 'B')
        return session.write(arrow.repeat(WHEEL_ROWS))
      }
      session.scroll(direction * WHEEL_ROWS)
    },
  }

  const blank = (text: string, color?: string): ReactElement => (
    <Box height={height} width={width} alignItems="center" justifyContent="center">
      <Text {...(color === undefined ? { dimColor: true } : { color })}>{text}</Text>
    </Box>
  )
  if (info === undefined) return blank('')
  if (info.unavailable !== null) return blank(`Terminal unavailable: ${info.unavailable}`, theme.error)
  if (session === undefined) return blank('starting…')

  const screen = session.screen()
  const spans: BlockSpan[] = []
  for (const b of session.blocks.list()) {
    const r = session.blocks.rows(b.id)
    if (r !== undefined) spans.push({ id: b.id, first: r.first, last: r.last, exit: b.exit, running: b.exit === null })
  }
  const gutterOn = session.blocks.seen() && !screen.alt
  const plain: Seg = { text: '  ', chrome: true }
  const lensRows = showLens && lensData !== null ? renderLens(lensData, inner, theme) : undefined
  const grid: Seg[][] =
    lensRows === undefined
      ? screen.rows.slice(0, height).map((segs, i) => [gutterOn ? gutterFor(screen.top + i, spans, selected, theme) : plain, ...segs])
      : lensRows.slice(0, height - 1).map((r) => [plain, ...r])
  while (grid.length < height) grid.push([])
  const hint = `${BLOCK_KEYS}${lensData === null ? '' : '  l lens'}${engine.ai === undefined ? '' : '  e explain'}  Esc back`
  const footer = exited !== null ? `[exited ${exited}] press Enter to restart` : showLens ? 'Esc back' : mode === 'blocks' ? hint : undefined
  if (footer !== undefined) grid[height - 1] = [{ text: ` ${footer}`, color: theme.dim, chrome: true }]

  return (
    <Box height={height} width={width} flexDirection="column" overflow="hidden">
      {grid.map((row, i) => (
        <SegLine key={i} segs={fitSegs(row, width)} />
      ))}
    </Box>
  )
}
