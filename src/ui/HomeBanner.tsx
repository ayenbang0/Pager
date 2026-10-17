import { Box, useAnimation } from 'ink'
import type { HomeStats } from '../engine.js'
import type { HomeAgents } from './homeAgents.js'
import { BANNER_ROWS, homeRows } from './homeRows.js'
import { REDUCED_MOTION } from './motion.js'
import { SegLine } from './SegLine.js'
import { useLook, useTheme } from './theme.js'

export { BANNER_ROWS }

const FRAME_MS = 70

interface Props {
  width: number
  height: number
  stats: HomeStats
  /** The AGENTS card: ready agents with their numbers, activity, reviews, usage and the next step. */
  agents: HomeAgents
  /** Detail lines after the title (name, contact code, getting started); shown as the YOU code and the START steps. */
  info: string[]
}

/**
 * The Home screen: a gradient PAGER logo (a one-line mark on small panes), tagline, greeting with your name and badge and your
 * contact code, then banded cards START, PEOPLE, AGENTS and ACTIVITY. Rows are built in `homeRows.ts`; cards drop from the bottom
 * when the pane is short.
 */
export function HomeBanner({ width, height, stats, agents, info }: Props) {
  const theme = useTheme()
  const look = useLook()
  const animate = !REDUCED_MOTION
  const { frame } = useAnimation({ interval: FRAME_MS, isActive: animate })
  const hour = new Date().getHours()
  const rows = homeRows({ width, height, frame, animate, hour, theme, look, stats, agents, info })
  return (
    <Box height={height} width={width} flexDirection="column" overflow="hidden">
      {rows.map((segs, r) => (
        <SegLine key={r} segs={segs} />
      ))}
    </Box>
  )
}
