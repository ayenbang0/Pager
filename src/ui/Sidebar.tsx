import { Box, Text } from 'ink'
import type { ConvView, PendingView } from '../engine.js'

export const SIDEBAR_WIDTH = 26

interface RowProps {
  label: string
  active: boolean
  color?: string
  dim?: boolean
  badge?: number
}

function Row({ label, active, color, dim, badge }: RowProps) {
  return (
    <Box justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end" inverse={active} color={color} dimColor={dim}>
          {label}
        </Text>
      </Box>
      {badge ? <Text color="yellow"> {badge}</Text> : null}
    </Box>
  )
}

interface Props {
  convs: ConvView[]
  pending: PendingView[]
  activeId: string | null
}

export function Sidebar({ convs, pending, activeId }: Props) {
  const dms = convs.filter((c) => c.kind === 'dm')
  const groups = convs.filter((c) => c.kind === 'group')
  return (
    <Box
      width={SIDEBAR_WIDTH}
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderDimColor
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
              color={c.online ? 'green' : undefined}
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
      {pending.length > 0 ? (
        <>
          <Text dimColor>PENDING</Text>
          {pending.map((p) => (
            <Row key={p.n} label={`${p.n} ${p.label} (${p.type})`} active={false} color="yellow" />
          ))}
        </>
      ) : null}
    </Box>
  )
}
