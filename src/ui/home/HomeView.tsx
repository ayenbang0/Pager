import { Box } from 'ink'
import { useEffect, useState } from 'react'
import type { HomeStats } from '../../app/engine.js'
import type { HomeAgents } from './homeAgents.js'
import { homeRows, type HomeChat, type WhatsNew } from './homeRows.js'
import { SegLine } from '../kit/SegLine.js'
import { useLook, useTheme } from '../theme/theme.js'

/** Relative times and the greeting are re-read this often, so a pane left open does not show `3m` for an hour. */
const REFRESH_MS = 30_000

interface Props {
  /** The pane's inner width (without its one column of padding on each side) and its height. */
  width: number
  height: number
  stats: HomeStats
  /** The agent rows: ready agents with their numbers, activity, reviews, usage and the next step. */
  agents: HomeAgents
  /** False in a run without agents. */
  agentsOn?: boolean
  chats: readonly HomeChat[]
  /** Detail lines after the title (name, contact code, getting started). */
  info: readonly string[]
  recap?: string | undefined
  news?: WhatsNew | undefined
}

/**
 * The Home screen: a greeting with what the chats and agents are doing, then agents, recent chats, quick actions, the contact code
 * and What's new. Rows are built in `homeRows.ts`; it sits in the pane like any other screen, one column in from each side.
 */
export function HomeView({ width, height, stats, agents, agentsOn = true, chats, info, recap, news }: Props) {
  const theme = useTheme()
  const look = useLook()
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
  const now = Date.now()
  const rows = homeRows({ width, height, hour: new Date(now).getHours(), now, theme, look, stats, agents, agentsOn, chats, info, ...(recap === undefined ? {} : { recap }), ...(news === undefined ? {} : { news }) })
  return (
    <Box height={height} width={width + 2} flexDirection="column" overflow="hidden" paddingX={1}>
      {rows.map((segs, r) => (
        <SegLine key={r} segs={segs} />
      ))}
    </Box>
  )
}
