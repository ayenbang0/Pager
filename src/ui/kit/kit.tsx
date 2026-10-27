import { Box } from 'ink'
import { SegLine } from './SegLine.js'
import type { Seg } from './segs.js'
import { titleRow } from './tern.js'
import { useTheme } from '../theme/theme.js'

interface TitleProps {
  title: string
  width: number
  /** Dim text at the right end, e.g. `Esc closes`. */
  right?: string
  /** A glyph before the title, e.g. a presence dot. */
  lead?: Seg
}

/** A one-row heading: the title on a soft raised chip, a quiet hairline across the rest, optional dim text at the end. */
export function BandTitle({ title, width, right, lead }: TitleProps) {
  const theme = useTheme()
  return (
    <Box width={width} height={1}>
      <SegLine segs={titleRow(title, right, width, theme, lead)} />
    </Box>
  )
}
