import { useState } from 'react'
import { Box, useInput } from 'ink'
import { OverlayCard } from './OverlayCard.js'
import { CARD_CHROME_ROWS, footerSegs, listWindow, moreSegs, type KeyHint } from './overlayRows.js'
import { paletteRow } from './paletteRows.js'
import { SegLine } from '../kit/SegLine.js'
import { fitSegs, pillSeg } from '../kit/segs.js'
import { useTheme } from '../theme/theme.js'

/** One row of a list panel: a section title, or an entry with what Enter and its letter keys do. */
export type PanelItem =
  | { header: string }
  | {
      label: string
      hint?: string
      /** Enter, with its footer word. */
      enter?: readonly [label: string, run: () => void]
      /** Letter keys for this row: key, footer word, action. */
      keys?: readonly (readonly [key: string, label: string, run: () => void])[]
    }

interface Props {
  title: string
  items: readonly PanelItem[]
  /** Shown when there are no entries at all. */
  empty: string
  /** Rows available, including the card border and title. */
  height: number
  onClose(): void
}

/** Card chrome plus the footer. */
const CHROME_ROWS = CARD_CHROME_ROWS + 1

/** A read-mostly list in place of the message pane (the group screen, requests): ↑↓ move over entries, Enter and letter keys act, Esc closes. */
export function ListPanel({ title, items, empty, height, onClose }: Props) {
  const theme = useTheme()
  const entries = items.flatMap((item, i) => ('header' in item ? [] : [i]))
  const [cursor, setCursor] = useState(0)
  const at = Math.min(cursor, Math.max(0, entries.length - 1))
  const selected = items[entries[at] ?? -1]
  const entry = selected === undefined || 'header' in selected ? undefined : selected
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.escape || (key.ctrl && input === 'c')) return onClose()
    if (key.upArrow) return setCursor(Math.max(0, at - 1))
    if (key.downArrow) return setCursor(Math.min(entries.length - 1, at + 1))
    if (key.return) return entry?.enter?.[1]()
    const hit = entry?.keys?.find(([k]) => k === input)
    if (hit !== undefined && !key.ctrl && !key.meta) hit[2]()
  })
  const listRows = Math.max(1, height - CHROME_ROWS)
  const { start, end, above, below } = listWindow(items.length, entries[at] ?? 0, listRows)
  const hints: KeyHint[] = [['↑↓', 'move'], ...(entry?.enter === undefined ? [] : [['Enter', entry.enter[0]] as const]), ...(entry?.keys ?? []).map(([k, label]) => [k, label] as const), ['Esc', 'close']]
  return (
    <OverlayCard title={title} height={height}>
      {(inner) => (
        <>
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {entries.length === 0 ? <SegLine segs={fitSegs([{ text: ' ' }, pillSeg(empty, theme.pill.muted, false)], inner)} /> : null}
            {items.slice(start, end).map((item, i) =>
              'header' in item ? (
                <SegLine key={`h${start + i}`} segs={fitSegs([{ text: ' ' }, { text: item.header, color: theme.accent2, bold: true }], inner)} />
              ) : (
                <SegLine key={`e${start + i}`} segs={paletteRow(item, '', start + i === entries[at], inner, theme)} />
              ),
            )}
          </Box>
          <SegLine segs={footerSegs(hints, moreSegs(above, below, theme), inner, theme)} />
        </>
      )}
    </OverlayCard>
  )
}
