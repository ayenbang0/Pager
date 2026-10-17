import { useEffect, useState } from 'react'
import { Box } from 'ink'
import { SpinnerLine } from './SpinnerLine.js'
import { formatClock, statusSegments, type StatusInput } from './statusSegments.js'
import { useTheme } from './theme.js'

const CLOCK_REFRESH_MS = 20_000

type Props = Omit<StatusInput, 'clock'>

/** The bottom row: colored pills for mode, connection, peers and agents, and the clock, painted across the full width. */
export function StatusBar(props: Props) {
  const theme = useTheme()
  const [clock, setClock] = useState(() => formatClock(new Date()))
  useEffect(() => {
    const timer = setInterval(() => setClock(formatClock(new Date())), CLOCK_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
  return (
    <Box width={props.columns} height={1}>
      <SpinnerLine segs={statusSegments({ ...props, clock }, theme)} />
    </Box>
  )
}
