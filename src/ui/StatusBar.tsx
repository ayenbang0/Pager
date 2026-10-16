import { Box, Text } from 'ink'
import { Spinner } from './Spinner.js'
import { useTheme } from './theme.js'

/** Below this width the hint is dropped so the counters never wrap. */
const HINT_MIN_COLUMNS = 80

interface Props {
  columns: number
  listening: boolean
  online: number
  unread: number
  pending: number
  hint: string
}

export function StatusBar({ columns, listening, online, unread, pending, hint }: Props) {
  const theme = useTheme()
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text wrap="truncate-end">
        {listening ? (
          <Text color={theme.online}>● connected</Text>
        ) : (
          <Text color={theme.warning}>
            <Spinner color={theme.warning} /> connecting…
          </Text>
        )}
        <Text dimColor> · {online} online</Text>
        {unread > 0 ? <Text color={theme.badge}> · {unread} unread</Text> : null}
        {pending > 0 ? <Text color={theme.badge}> · {pending} pending</Text> : null}
      </Text>
      {columns >= HINT_MIN_COLUMNS ? <Text dimColor>{hint}</Text> : null}
    </Box>
  )
}
