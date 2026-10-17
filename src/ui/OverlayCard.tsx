import { useRef, type ReactNode } from 'react'
import { Box, useBoxMetrics, useWindowSize, type DOMElement } from 'ink'
import { BandTitle } from './kit.js'
import { CARD_CHROME_ROWS } from './overlayRows.js'
import { SIDEBAR_WIDTH } from './Sidebar.js'
import { useTheme } from './theme.js'

interface Props {
  title: string
  /** Dim text at the end of the title row. */
  right?: string
  /** Rows to fill, border included. */
  height: number
  /** Draws the card body for `inner` columns and `rows` rows (the height less border and title). */
  children(inner: number, rows: number): ReactNode
}

/**
 * The frame every picker overlay shares: a rounded accent border, a banded title with a gradient rule, then the body.
 * It measures its own width, so callers only pass the height the message pane has.
 */
export function OverlayCard({ title, right = 'Esc closes', height, children }: Props) {
  const theme = useTheme()
  const { columns } = useWindowSize()
  const ref = useRef<DOMElement>(null)
  const { clientWidth, hasMeasured } = useBoxMetrics(ref)
  // Until the first layout pass, assume the sidebar is open; the measured width replaces it a frame later.
  const content = hasMeasured && clientWidth > 0 ? clientWidth : Math.max(12, columns - SIDEBAR_WIDTH - 2)
  const inner = Math.max(8, content - 2)
  return (
    <Box ref={ref} height={height} flexDirection="column" overflow="hidden" paddingX={1} borderStyle="round" borderColor={theme.accent}>
      <BandTitle title={title} width={inner} right={right} />
      {children(inner, Math.max(1, height - CARD_CHROME_ROWS))}
    </Box>
  )
}
