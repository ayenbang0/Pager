import { Box } from 'ink'
import { SegLine } from './SegLine.js'
import { useTheme } from './theme.js'
import { shellLabel, terminalTitle, type TermInfo } from './terminalChrome.js'

const SHELL = shellLabel(process.env, process.platform)

/** Title row of the Terminal tab: band, shell pill, running command or directory, and a running / exit-code pill. */
export function TerminalHeader({ term, width }: { term: TermInfo; width: number }) {
  const theme = useTheme()
  return (
    <Box width={width} height={1}>
      <SegLine segs={terminalTitle(term, SHELL, width, theme)} />
    </Box>
  )
}
