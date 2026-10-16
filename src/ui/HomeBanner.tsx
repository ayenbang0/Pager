import { Box, Text, useAnimation } from 'ink'
import { bannerRows, LOGO_WIDTH, tagline } from './banner.js'
import { REDUCED_MOTION } from './motion.js'
import { useTheme } from './theme.js'

const FRAME_MS = 70
/** Logo + blank + tagline + blank. */
export const BANNER_ROWS = 9
const COMPACT_MIN_COLUMNS = LOGO_WIDTH + 2

interface Props {
  width: number
  height: number
  /** Detail lines under the logo (name, contact code, getting started); trimmed to fit. */
  info: string[]
}

/** Animated PAGER logo, centered in the pane, with the welcome details beneath. */
export function HomeBanner({ width, height, info }: Props) {
  const theme = useTheme()
  const { frame } = useAnimation({ interval: FRAME_MS, isActive: !REDUCED_MOTION })
  const animate = !REDUCED_MOTION
  const shown = info.slice(0, Math.max(0, height - BANNER_ROWS))
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
