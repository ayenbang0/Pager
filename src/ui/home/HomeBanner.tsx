import { Box } from 'ink'
import { useEffect, useState } from 'react'
import type { HomeStats } from '../../app/engine.js'
import type { HomeAgents } from './homeAgents.js'
import { BANNER_ROWS, homeRows, visualFrame } from './homeRows.js'
import { REDUCED_MOTION } from '../theme/motion.js'
import { SegLine } from '../kit/SegLine.js'
import { useLook, useTheme } from '../theme/theme.js'

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
 * The animation frame, advanced from the wall clock. State changes only when the picture does (see `visualFrame`): a tick that
 * draws the same thing would still make Ink lay out and measure the whole screen, which at idle kept a core busy.
 */
function useBannerFrame(active: boolean): number {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const start = Date.now()
    const timer = setInterval(() => {
      const next = visualFrame(Math.floor((Date.now() - start) / FRAME_MS))
      setFrame((prev) => (prev === next ? prev : next))
    }, FRAME_MS)
    return () => clearInterval(timer)
  }, [active])
  return frame
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
  const frame = useBannerFrame(animate)
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
