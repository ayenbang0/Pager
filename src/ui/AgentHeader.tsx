import { Box, Text, useWindowSize } from 'ink'
import type { AgentView } from '../agents/types.js'
import type { Pill } from '../themes.js'
import { agentChip, agentHeaderLeft, chipSegs, hubHeaderSegs, inviteChipSegs } from './agentChrome.js'
import { agentTint } from './look.js'
import type { Seg } from './segs.js'
import { Spinner, useBlink } from './Spinner.js'
import { useLook, useTheme } from './theme.js'

interface AgentProps {
  view: AgentView
  /** Files the agent's latest run changed. */
  files: number
  review: boolean
}

/** The styled runs of `segs` as nested Text, for rows that mix segs with animated cells. */
function Runs({ segs }: { segs: readonly Seg[] }) {
  return segs.map((s, i) => (
    <Text key={i} color={s.color} backgroundColor={s.bg} bold={s.bold} dimColor={s.dim} italic={s.italic} inverse={s.inverse}>
      {s.text}
    </Text>
  ))
}

/** The `?` of an asking pill, blinking. */
function BlinkMark({ pill }: { pill: Pill }) {
  const on = useBlink()
  return (
    <Text color={pill.fg} backgroundColor={pill.bg} bold>
      {on ? '?' : ' '}
    </Text>
  )
}

/**
 * Title row of an agent's own tab, a band on the surface color: the agent's identity pill, its CLI, a state pill, the task and a
 * files-changed pill on the left; `model`, `effort` and `ctx NN%` pills (Alt+M or a click changes them) and `⚑ review on` on the right.
 * The right end is exactly `chipWidth(...)` columns plus one column of margin, which is what a click on the chip is tested against.
 */
export function AgentHeader({ view, files, review }: AgentProps) {
  const theme = useTheme()
  const look = useLook()
  const tint = view.color ?? agentTint(theme, look, view.name)
  const left = agentHeaderLeft(view, files, theme, tint)
  const { cell } = left
  return (
    <Box height={1} backgroundColor={theme.surface}>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Runs segs={left.before} />
          {cell === undefined ? null : cell.kind === 'spinner' ? <Spinner color={cell.pill.fg} bg={cell.pill.bg} /> : <BlinkMark pill={cell.pill} />}
          <Runs segs={left.after} />
        </Text>
      </Box>
      <Box flexShrink={0} paddingRight={1}>
        <Text>
          <Runs segs={chipSegs(agentChip(view), review, theme)} />
        </Text>
      </Box>
    </Box>
  )
}

interface HubProps {
  agents: readonly AgentView[]
  goal: string
  /** Guests who have joined your agent session. */
  guests: number
}

/**
 * Title row of the all-agents hub, a band: `⌁ AGENTS` pill, the shared goal as a pill, then who is working on what; the invite chip
 * sits at the right end (exactly `inviteChipWidth(guests)` columns plus one of margin, which is what a click is tested against).
 */
export function HubHeader({ agents, goal, guests }: HubProps) {
  const theme = useTheme()
  const { columns } = useWindowSize()
  return (
    <Box height={1} backgroundColor={theme.surface}>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Runs segs={hubHeaderSegs(agents, goal, Math.floor(columns / 2), theme)} />
        </Text>
      </Box>
      <Box flexShrink={0} paddingRight={1}>
        <Text>
          <Runs segs={inviteChipSegs(guests, theme)} />
        </Text>
      </Box>
    </Box>
  )
}
