import { Box, Text } from 'ink'
import type { ConvView, PendingView } from '../engine.js'
import { ROOM_ID, type RoomView, type RunView } from '../agents/orchestrator.js'
import { Spinner } from './Spinner.js'
import { useTheme } from './theme.js'

export const SIDEBAR_WIDTH = 26

interface RowProps {
  label: string
  active: boolean
  color?: string
  dim?: boolean
  badge?: number
}

function Row({ label, active, color, dim, badge }: RowProps) {
  const theme = useTheme()
  return (
    <Box justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end" inverse={active} color={color} dimColor={dim}>
          {label}
        </Text>
      </Box>
      {badge ? <Text color={theme.badge}> {badge}</Text> : null}
    </Box>
  )
}

/** One agent run: a spinner while active, a state glyph otherwise. */
function RunRow({ run }: { run: RunView }) {
  const theme = useTheme()
  const mark =
    run.state === 'running' ? (
      <Spinner color={theme.badge} />
    ) : run.state === 'queued' ? (
      <Text dimColor>·</Text>
    ) : run.state === 'done' ? (
      <Text color={theme.success}>✓</Text>
    ) : run.state === 'failed' ? (
      <Text color={theme.error}>✗</Text>
    ) : (
      <Text dimColor>■</Text>
    )
  return (
    <Box>
      {mark}
      <Text> </Text>
      <Text wrap="truncate-end" dimColor={run.state === 'cancelled'}>
        {run.id}
      </Text>
    </Box>
  )
}

interface Props {
  convs: ConvView[]
  pending: PendingView[]
  room: RoomView
  activeId: string | null
}

export function Sidebar({ convs, pending, room, activeId }: Props) {
  const theme = useTheme()
  const dms = convs.filter((c) => c.kind === 'dm')
  const groups = convs.filter((c) => c.kind === 'group')
  return (
    <Box
      width={SIDEBAR_WIDTH}
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderColor={theme.border}
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
    >
      <Row label="⌂ home" active={activeId === null} />
      {dms.length > 0 ? (
        <>
          <Text dimColor>DIRECT</Text>
          {dms.map((c) => (
            <Row
              key={c.id}
              label={`${c.online ? '●' : '○'} ${c.title}`}
              active={activeId === c.id}
              color={c.online ? theme.online : undefined}
              dim={!c.online}
              badge={c.unread}
            />
          ))}
        </>
      ) : null}
      {groups.length > 0 ? (
        <>
          <Text dimColor>GROUPS</Text>
          {groups.map((c) => (
            <Row key={c.id} label={`# ${c.title}`} active={activeId === c.id} badge={c.unread} />
          ))}
        </>
      ) : null}
      <Text dimColor>AGENTS</Text>
      <Row label="⌁ agents" active={activeId === ROOM_ID} badge={room.unread} />
      {room.runs.slice(-5).map((r) => (
        <RunRow key={r.id} run={r} />
      ))}
      {pending.length > 0 ? (
        <>
          <Text dimColor>PENDING</Text>
          {pending.map((p) => (
            <Row key={p.n} label={`${p.n} ${p.label} (${p.type})`} active={false} color={theme.badge} />
          ))}
        </>
      ) : null}
    </Box>
  )
}
