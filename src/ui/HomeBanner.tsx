import { Box, Text, useAnimation } from 'ink'
import type { ReactNode } from 'react'
import type { HomeStats } from '../engine.js'
import { bannerRows, LOGO_WIDTH, sparkline, tagline } from './banner.js'
import { REDUCED_MOTION } from './motion.js'
import { useTheme } from './theme.js'

const FRAME_MS = 70
/** Logo + blank + tagline + blank. */
export const BANNER_ROWS = 9
const COMPACT_MIN_COLUMNS = LOGO_WIDTH + 2
/** Three summary cards need this much width; narrower panes get a one-line summary. */
const CARDS_MIN_COLUMNS = 66
const CARD_MAX_WIDTH = 30
/** Border + four lines + gap. */
const CARD_ROWS = 7
/** Rows kept for the name and contact code before any summary is drawn. */
const INFO_FIRST_ROWS = 4

interface Props {
  width: number
  height: number
  stats: HomeStats
  /** Detail lines under the logo (name, contact code, getting started); trimmed to fit. */
  info: string[]
}

interface CardProps {
  title: string
  width: number
  children: ReactNode
}

function Card({ title, width, children }: CardProps) {
  const theme = useTheme()
  return (
    <Box width={width} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent} wrap="truncate-end">
        {title}
      </Text>
      {children}
    </Box>
  )
}

/** Animated PAGER logo, centered in the pane, with a summary of the user's activity and the welcome details beneath. */
export function HomeBanner({ width, height, stats, info }: Props) {
  const theme = useTheme()
  const { frame } = useAnimation({ interval: FRAME_MS, isActive: !REDUCED_MOTION })
  const animate = !REDUCED_MOTION
  const spare = height - BANNER_ROWS
  const cards = width >= CARDS_MIN_COLUMNS && spare >= CARD_ROWS + INFO_FIRST_ROWS
  const summary = !cards && spare >= INFO_FIRST_ROWS + 2
  const shown = info.slice(0, Math.max(0, spare - (cards ? CARD_ROWS : summary ? 2 : 0)))
  const cardWidth = Math.min(CARD_MAX_WIDTH, Math.floor((width - 2) / 3))
  const week = stats.week.reduce((a, b) => a + b, 0)
  return (
    <Box height={height} width={width} flexDirection="column" justifyContent="center" alignItems="center" overflow="hidden">
      {width >= COMPACT_MIN_COLUMNS ? (
        bannerRows(frame, theme.accent, animate).map((segs, r) => (
          <Text key={r} wrap="truncate-end">
            {segs.map((s, i) => (
              <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim}>
                {s.text}
              </Text>
            ))}
          </Text>
        ))
      ) : (
        <Text bold color={theme.accent}>
          P A G E R
        </Text>
      )}
      <Text> </Text>
      <Text color={theme.accent}>{tagline(frame, animate)}</Text>
      <Text> </Text>
      {cards ? (
        <>
          <Box>
            <Card title="People" width={cardWidth}>
              <Text wrap="truncate-end">
                <Text color={stats.online > 0 ? theme.online : undefined} dimColor={stats.online === 0}>
                  {stats.online > 0 ? '●' : '○'} {stats.online} online
                </Text>
                <Text dimColor> of {stats.contacts}</Text>
              </Text>
              <Text wrap="truncate-end" dimColor>
                # {stats.groups} group{stats.groups === 1 ? '' : 's'}
              </Text>
              <Text wrap="truncate-end" color={stats.pending > 0 ? theme.badge : undefined} dimColor={stats.pending === 0}>
                {stats.pending} pending
              </Text>
              <Text wrap="truncate-end" color={stats.unread > 0 ? theme.badge : undefined} dimColor={stats.unread === 0}>
                {stats.unread} unread
              </Text>
            </Card>
            <Card title="Messages" width={cardWidth}>
              <Text wrap="truncate-end">↑ {stats.sent} sent</Text>
              <Text wrap="truncate-end">↓ {stats.received} received</Text>
              <Text wrap="truncate-end" color={theme.accent}>
                {sparkline(stats.week)} <Text dimColor>{week} in 7d</Text>
              </Text>
              <Text wrap="truncate-end" dimColor>
                {stats.busiest ? `top: ${stats.busiest.title} (${stats.busiest.count})` : 'no chats yet'}
              </Text>
            </Card>
            <Card title="Agents" width={cardWidth}>
              <Text wrap="truncate-end" color={stats.agentsRunning > 0 ? theme.badge : undefined} dimColor={stats.agentsRunning === 0}>
                ⌁ {stats.agentsRunning} running
              </Text>
              <Text wrap="truncate-end" color={stats.mergeable > 0 ? theme.success : undefined} dimColor={stats.mergeable === 0}>
                {stats.mergeable} to merge
              </Text>
              <Text wrap="truncate-end" dimColor>
                {stats.agentRuns} run{stats.agentRuns === 1 ? '' : 's'} total
              </Text>
              <Text wrap="truncate-end" dimColor>
                {stats.agentRuns === 0 ? '/agent omp <task>' : '▸ terminal in sidebar'}
              </Text>
            </Card>
          </Box>
          <Text> </Text>
        </>
      ) : null}
      {summary ? (
        <>
          <Text wrap="truncate-end" dimColor>
            {stats.contacts} contacts · {stats.online} online · {stats.sent} sent · {stats.received} received · {sparkline(stats.week)}
          </Text>
          <Text> </Text>
        </>
      ) : null}
      <Box flexDirection="column">
        {shown.map((line, i) => {
          const isCode = line.trim().startsWith('pgr1-')
          return (
            <Text key={i} color={isCode ? theme.accent : undefined} dimColor={!isCode}>
              {line}
            </Text>
          )
        })}
      </Box>
    </Box>
  )
}
