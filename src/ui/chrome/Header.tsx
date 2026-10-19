import { Box } from 'ink'
import { headerSegs, type HeaderInput } from './chrome.js'
import { SegLine } from '../kit/SegLine.js'
import { useSpinnerGlyph } from '../kit/Spinner.js'
import { useTheme } from '../theme/theme.js'

/** The top row: two-tone logo, breadcrumb, and status pills on a full-width band. */
export function Header(props: Omit<HeaderInput, 'spinner'>) {
  const theme = useTheme()
  const spinner = useSpinnerGlyph()
  return (
    <Box width={props.width} height={1}>
      <SegLine segs={headerSegs({ ...props, spinner }, theme)} />
    </Box>
  )
}
