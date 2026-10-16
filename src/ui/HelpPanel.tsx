import { Box, Text, useInput } from 'ink'
import { KEY_SECTIONS } from './keymap.js'
import { useTheme } from './theme.js'

const KEY_COLUMN = 26

interface Props {
  height: number
  onClose(): void
}

/** Replaces the message pane. Any of Esc, Enter, q or Ctrl+G closes it. Rows are never squeezed; a short terminal clips the bottom. */
export function HelpPanel({ height, onClose }: Props) {
  const theme = useTheme()
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.escape || key.return || input === 'q' || (key.ctrl && (input === 'g' || input === 'c'))) onClose()
  })
  return (
    <Box height={height} flexDirection="column" overflow="hidden" paddingX={1}>
      <Box flexShrink={0}>
        <Text bold color={theme.accent}>
          Keyboard shortcuts
        </Text>
        <Text dimColor> · Esc to close</Text>
      </Box>
      {KEY_SECTIONS.map((section) => (
        <Box key={section.title} flexDirection="column" flexShrink={0}>
          <Text dimColor>{section.title.toUpperCase()}</Text>
          {section.rows.map(([keys, action]) => (
            <Text key={keys} wrap="truncate-end">
              <Text color={theme.accent}>{keys.padEnd(KEY_COLUMN)}</Text>
              {action}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}
