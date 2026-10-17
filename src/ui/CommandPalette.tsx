import { useState } from 'react'
import { Box, useInput, usePaste } from 'ink'
import { fuzzyFilter } from './fuzzy.js'
import { backspace, deleteWordBack, emptyInput, insert, moveLeft, moveRight, splitAtCursor, type InputBuffer } from './inputBuffer.js'
import { OverlayCard } from './OverlayCard.js'
import { CARD_CHROME_ROWS, fieldSegs, footerSegs, listWindow, moreSegs, type KeyHint } from './overlayRows.js'
import { matchCount, noMatchSegs, paletteRow } from './paletteRows.js'
import { SegLine } from './SegLine.js'
import { segsWidth, type Seg } from './segs.js'
import { useTheme } from './theme.js'

export interface PaletteItem {
  label: string
  hint?: string
  run(): void
}

interface Props {
  items: readonly PaletteItem[]
  /** Rows available, including the card border and title. */
  height: number
  onClose(): void
}

/** Card chrome plus the query row and the footer. */
const CHROME_ROWS = CARD_CHROME_ROWS + 2
const HINTS: readonly KeyHint[] = [
  ['↑↓', 'move'],
  ['Enter', 'run'],
  ['Esc', 'close'],
]

/** Replaces the message pane. Enter runs the selection and closes; Esc closes. */
export function CommandPalette({ items, height, onClose }: Props) {
  const theme = useTheme()
  const [query, setQuery] = useState<InputBuffer>(emptyInput)
  const [selected, setSelected] = useState(0)
  const matches = fuzzyFilter(items, query.text)
  const row = Math.min(selected, Math.max(0, matches.length - 1))
  const listRows = Math.max(1, height - CHROME_ROWS)
  const { start, end, above, below } = listWindow(matches.length, row, listRows)
  const shown = matches.slice(start, end)

  const edit = (update: (prev: InputBuffer) => InputBuffer): void => {
    setQuery(update)
    setSelected(0)
  }
  usePaste((text) => edit((b) => insert(b, text)))
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.escape || (key.ctrl && (input === 'p' || input === 'c'))) return onClose()
    if (key.return) {
      const item = matches[row]
      onClose()
      item?.run()
      return
    }
    if (key.upArrow || (key.ctrl && input === 'k')) return setSelected(Math.max(0, row - 1))
    if (key.downArrow || (key.ctrl && input === 'n')) return setSelected(Math.min(matches.length - 1, row + 1))
    if (key.pageUp) return setSelected(Math.max(0, row - listRows))
    if (key.pageDown) return setSelected(Math.min(matches.length - 1, row + listRows))
    if (key.leftArrow) return setQuery(moveLeft)
    if (key.rightArrow) return setQuery(moveRight)
    if (key.backspace) return edit(backspace)
    if (key.ctrl && input === 'w') return edit(deleteWordBack)
    if (key.ctrl && input === 'u') return edit(() => emptyInput)
    if (input !== '' && !key.ctrl && !key.meta) edit((b) => insert(b, input))
  })

  const text = splitAtCursor(query)
  return (
    <OverlayCard title="COMMAND PALETTE" height={height}>
      {(inner) => {
        const count = matchCount(matches.length, items.length, theme)
        const prefix: Seg[] = [{ text: '❯ ', color: theme.glow, bg: theme.surface, bold: true }]
        const field = fieldSegs(prefix, text, 'type to filter…', true, Math.max(4, inner - segsWidth(count) - 1), theme)
        return (
          <>
            <SegLine segs={[...field, { text: ' ' }, ...count]} />
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              {matches.length === 0 ? <SegLine segs={noMatchSegs(theme)} /> : null}
              {shown.map((item, i) => (
                <SegLine key={`${start + i}:${item.label}`} segs={paletteRow(item, query.text, start + i === row, inner, theme)} />
              ))}
            </Box>
            <SegLine segs={footerSegs(HINTS, moreSegs(above, below, theme), inner, theme)} />
          </>
        )
      }}
    </OverlayCard>
  )
}
