import { useState } from 'react'
import { Box, Text, useInput, usePaste } from 'ink'
import { fuzzyFilter } from './fuzzy.js'
import { backspace, deleteWordBack, emptyInput, insert, moveLeft, moveRight, splitAtCursor, type InputBuffer } from './inputBuffer.js'
import { useTheme } from './theme.js'

export interface PaletteItem {
  label: string
  hint?: string
  run(): void
}

interface Props {
  items: readonly PaletteItem[]
  /** Rows available, including the title and query lines. */
  height: number
  onClose(): void
}

const CHROME_ROWS = 3 // title + query + footer

/** Replaces the message pane. Enter runs the selection and closes; Esc closes. */
export function CommandPalette({ items, height, onClose }: Props) {
  const theme = useTheme()
  const [query, setQuery] = useState<InputBuffer>(emptyInput)
  const [selected, setSelected] = useState(0)
  const matches = fuzzyFilter(items, query.text)
  const row = Math.min(selected, Math.max(0, matches.length - 1))
  const listRows = Math.max(1, height - CHROME_ROWS)
  const start = Math.max(0, Math.min(row - Math.floor(listRows / 2), matches.length - listRows))
  const shown = matches.slice(start, start + listRows)

  const edit = (update: (prev: InputBuffer) => InputBuffer): void => {
    setQuery(update)
    setSelected(0)
  }
  usePaste((text) => edit((b) => insert(b, text)))
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.escape || (key.ctrl && (input === 'p' || input === 'c'))) return onClose()
    if (key.return) {
      const item = matches[row]
      onClose()
      item?.run()
      return
    }
    if (key.upArrow || (key.ctrl && input === 'k')) return setSelected(Math.max(0, row - 1))
    if (key.downArrow || (key.ctrl && input === 'n')) return setSelected(Math.min(matches.length - 1, row + 1))
    if (key.pageUp) return setSelected(Math.max(0, row - listRows))
    if (key.pageDown) return setSelected(Math.min(matches.length - 1, row + listRows))
    if (key.leftArrow) return setQuery(moveLeft)
    if (key.rightArrow) return setQuery(moveRight)
    if (key.backspace) return edit(backspace)
    if (key.ctrl && input === 'w') return edit(deleteWordBack)
    if (key.ctrl && input === 'u') return edit(() => emptyInput)
    if (input !== '' && !key.ctrl && !key.meta) edit((b) => insert(b, input))
  })

  const { before, at, after } = splitAtCursor(query)
  return (
    <Box height={height} flexDirection="column" overflow="hidden" paddingX={1}>
      <Text bold color={theme.accent}>
        Command palette
      </Text>
      <Text wrap="truncate-start">
        <Text color={theme.accent}>❯ </Text>
        {before}
        <Text inverse>{at === '' ? ' ' : at}</Text>
        {after}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {matches.length === 0 ? <Text dimColor>No matches</Text> : null}
        {shown.map((item, i) => (
          <Box key={`${start + i}:${item.label}`} justifyContent="space-between">
            <Box flexShrink={1}>
              <Text wrap="truncate-end" inverse={start + i === row}>
                {item.label}
              </Text>
            </Box>
            {item.hint ? <Text dimColor> {item.hint}</Text> : null}
          </Box>
        ))}
      </Box>
      <Text dimColor>Up/Down select · Enter run · Esc close</Text>
    </Box>
  )
}
