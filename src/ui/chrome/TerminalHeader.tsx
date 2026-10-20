import { Box } from 'ink'
import type { TermInfo } from '../../tools/terminal/sessions.js'
import { SegLine } from '../kit/SegLine.js'
import { useTheme } from '../theme/theme.js'
import { terminalTitle } from './terminalChrome.js'

/** Title row of a Terminal tab: band, shell pill, running command or directory, and a running / exit-code pill. */
export function TerminalHeader({ term, width, n }: { term: TermInfo; width: number; n: number }) {
  const theme = useTheme()
  return (
    <Box width={width} height={1}>
      <SegLine segs={terminalTitle(term, width, theme, n)} />
    </Box>
  )
}
