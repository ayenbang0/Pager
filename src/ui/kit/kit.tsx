import { Box } from 'ink'
import { SegLine } from './SegLine.js'
import { bandLabel, clipSegs, gradientRule, segsWidth, type Seg } from './segs.js'
import { useTheme } from '../theme/theme.js'

interface TitleProps {
  title: string
  width: number
  /** Dim text at the right end, e.g. `Esc closes`. */
  right?: string
}

/** A one-row overlay or section heading: `▌ TITLE ` on an accent band, a gradient rule across the rest, optional dim text at the end. */
export function BandTitle({ title, width, right }: TitleProps) {
  const theme = useTheme()
  const left: Seg[] = bandLabel(title, theme)
  const tail: Seg[] = right === undefined ? [] : [{ text: ` ${right}`, color: theme.dim }]
  const rule = Math.max(0, width - segsWidth(left) - segsWidth(tail) - 1)
  const segs: Seg[] = [...left, { text: ' ' }, ...gradientRule(rule, theme.gradient, '━'), ...tail]
  return (
    <Box width={width} height={1}>
      <SegLine segs={clipSegs(segs, width)} />
    </Box>
  )
}
