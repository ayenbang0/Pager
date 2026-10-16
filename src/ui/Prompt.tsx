import { useRef, useState } from 'react'
import { Box, Text, useInput, usePaste } from 'ink'
import type { CommandSpec } from '../commands.js'
import { completion } from './palette.js'
import {
  backspace,
  deleteForward,
  deleteToEnd,
  deleteToStart,
  deleteWordBack,
  emptyInput,
  end,
  home,
  insert,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  setText,
  splitAtCursor,
  type InputBuffer,
} from './inputBuffer.js'
import { useTheme } from './theme.js'

const HISTORY_MAX = 100

interface Props {
  value: InputBuffer
  /** Functional update so keystrokes arriving before a re-render never overwrite each other. */
  onEdit(update: (prev: InputBuffer) => InputBuffer): void
  placeholder: string
  matches: CommandSpec[]
  /** False while an overlay owns the keyboard. */
  active: boolean
  onSubmit(text: string): void
  /** +1 = toward older messages (PageUp), -1 = toward newer. */
  onScroll(direction: 1 | -1): void
  /** -1 = previous conversation, +1 = next. */
  onSwitch(direction: 1 | -1): void
  onInterrupt(): void
  onPalette(): void
  onSidebar(): void
  onHelp(): void
  onQuit(): void
}

export function Prompt({
  value,
  onEdit,
  placeholder,
  matches,
  active,
  onSubmit,
  onScroll,
  onSwitch,
  onInterrupt,
  onPalette,
  onSidebar,
  onHelp,
  onQuit,
}: Props) {
  const theme = useTheme()
  const [selected, setSelected] = useState(0)
  const history = useRef<string[]>([])
  const historyPos = useRef<number | null>(null)
  const selectedRow = Math.min(selected, Math.max(0, matches.length - 1))

  usePaste((text) => onEdit((b) => insert(b, text)), { isActive: active })

  useInput(
    (input, key) => {
      if (key.eventType === 'release') return
      if (key.meta && key.upArrow) return onSwitch(-1)
      if (key.meta && key.downArrow) return onSwitch(1)
      if (key.ctrl && key.leftArrow) return onEdit(moveWordLeft)
      if (key.ctrl && key.rightArrow) return onEdit(moveWordRight)
      if (key.meta) {
        if (input === 'b') return onEdit(moveWordLeft)
        if (input === 'f') return onEdit(moveWordRight)
        return
      }
      if (key.ctrl) {
        switch (input) {
          case 'c':
            return onInterrupt()
          case 'd':
            if (value.text === '') onQuit()
            return
          case 'p':
            return onPalette()
          case 'b':
            return onSidebar()
          case 'a':
            return onEdit(home)
          case 'e':
            return onEdit(end)
          case 'w':
            return onEdit(deleteWordBack)
          case 'u':
            return onEdit(deleteToStart)
          case 'k':
            return onEdit(deleteToEnd)
          default:
            return
        }
      }
      if (key.return) {
        const text = value.text
        if (text.trim() !== '') {
          history.current = [...history.current.filter((h) => h !== text), text].slice(-HISTORY_MAX)
          historyPos.current = null
        }
        onEdit(() => emptyInput)
        setSelected(0)
        onSubmit(text)
        return
      }
      if (key.tab) {
        const spec = matches[selectedRow]
        if (spec) onEdit(() => setText(completion(value.text, spec)))
        return
      }
      if (key.upArrow || key.downArrow) {
        const dir = key.upArrow ? -1 : 1
        if (matches.length > 0) {
          setSelected((selectedRow + dir + matches.length) % matches.length)
          return
        }
        const past = history.current
        const next = (historyPos.current ?? past.length) + dir
        if (next < 0 || next > past.length) return
        historyPos.current = next === past.length ? null : next
        onEdit(() => setText(past[next] ?? ''))
        return
      }
      if (key.leftArrow) return onEdit(moveLeft)
      if (key.rightArrow) return onEdit(moveRight)
      if (key.home) return onEdit(home)
      if (key.end) return onEdit(end)
      if (key.backspace) return onEdit(backspace)
      if (key.delete) return onEdit(deleteForward)
      if (key.escape) return onEdit(() => emptyInput)
      if (key.pageUp) return onScroll(1)
      if (key.pageDown) return onScroll(-1)
      if (input === '?' && value.text === '') return onHelp()
      if (input !== '') onEdit((b) => insert(b, input))
    },
    { isActive: active },
  )

  const { before, at, after } = splitAtCursor(value)
  return (
    <Box flexDirection="column">
      {matches.map((m, i) => (
        <Box key={m.usage} paddingX={1}>
          <Text inverse={i === selectedRow}>{m.usage}</Text>
          <Text dimColor>  {m.summary}</Text>
        </Box>
      ))}
      <Box borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text wrap="truncate-start">
          <Text color={theme.accent}>❯ </Text>
          {value.text === '' ? (
            <>
              <Text inverse={active}> </Text>
              <Text dimColor>{placeholder}</Text>
            </>
          ) : (
            <>
              {before}
              <Text inverse={active}>{at === '' ? ' ' : at}</Text>
              {after}
            </>
          )}
        </Text>
      </Box>
    </Box>
  )
}
