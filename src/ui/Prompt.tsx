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
  /** Earlier submitted lines, oldest first. */
  history: readonly string[]
  /** What to append after the typed text, or ''. */
  suggest(text: string): string
  onToggleFolds(): void
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
  history,
  suggest,
  onToggleFolds,
}: Props) {
  const theme = useTheme()
  const [selected, setSelected] = useState(0)
  const historyPos = useRef<number | null>(null)
  const selectedRow = Math.min(selected, Math.max(0, matches.length - 1))
  // Dim completion learned from the user's own messages, offered only when the cursor is at the end and no command menu is open.
  const ghost = matches.length === 0 && value.cursor === value.text.length ? suggest(value.text) : ''

  usePaste((text) => onEdit((b) => insert(b, text)), { isActive: active })

  useInput(
    (input, key) => {
      if (key.eventType === 'release') return
      if (key.meta && key.upArrow) return onSwitch(-1)
      if (key.meta && key.downArrow) return onSwitch(1)
      // Option+Arrow / Option+Backspace (macOS), Ctrl+Arrow (Windows/Linux)
      if ((key.ctrl || key.meta) && key.leftArrow) return onEdit(moveWordLeft)
      if ((key.ctrl || key.meta) && key.rightArrow) return onEdit(moveWordRight)
      if (key.meta && key.backspace) return onEdit(deleteWordBack)
      // Cmd (kitty-protocol terminals): line start / end / delete to line start
      if (key.super && key.leftArrow) return onEdit(home)
      if (key.super && key.rightArrow) return onEdit(end)
      if (key.super && key.backspace) return onEdit(deleteToStart)
      // macOS Terminal types these when Option is not set up as Meta (US layout: Option+B, Option+F)
      if (input === '∫') return onEdit(moveWordLeft)
      if (input === 'ƒ') return onEdit(moveWordRight)
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
          case 'n':
            return onSwitch(1)
          case 'o':
            return onSwitch(-1)
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
          case 't':
            return onToggleFolds()
          case 'g':
            return onHelp()
          default:
            return
        }
      }
      if (key.return) {
        const text = value.text
        if (text.trim() !== '') historyPos.current = null
        onEdit(() => emptyInput)
        setSelected(0)
        onSubmit(text)
        return
      }
      if (key.tab) {
        const spec = matches[selectedRow]
        if (spec) onEdit(() => setText(completion(value.text, spec)))
        else if (ghost !== '') onEdit(() => setText(value.text + ghost))
        return
      }
      if (key.upArrow || key.downArrow) {
        const dir = key.upArrow ? -1 : 1
        if (matches.length > 0) {
          setSelected((selectedRow + dir + matches.length) % matches.length)
          return
        }
        const next = (historyPos.current ?? history.length) + dir
        if (next < 0 || next > history.length) return
        historyPos.current = next === history.length ? null : next
        onEdit(() => setText(history[next] ?? ''))
        return
      }
      if (key.leftArrow) return onEdit(moveLeft)
      if (key.rightArrow) return ghost === '' ? onEdit(moveRight) : onEdit(() => setText(value.text + ghost))
      if (key.home) return onEdit(home)
      if (key.end) return ghost === '' ? onEdit(end) : onEdit(() => setText(value.text + ghost))
      if (key.backspace) return onEdit(backspace)
      if (key.delete) return onEdit(deleteForward)
      if (key.escape) return onEdit(() => emptyInput)
      if (key.pageUp) return onScroll(1)
      if (key.pageDown) return onScroll(-1)
      if (input !== '') onEdit((b) => insert(b, input))
    },
    { isActive: active },
  )

  const { before, at, after } = splitAtCursor(value)
  // The first suggested character sits under the cursor block so the suggestion reads as one word.
  const ghostChars = [...ghost]
  const ghostHead = ghostChars[0]
  const ghostTail = ghostChars.slice(1).join('')

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
              <Text inverse={active} dimColor={at === '' && ghostHead !== undefined}>
                {at !== '' ? at : (ghostHead ?? ' ')}
              </Text>
              {after}
              <Text dimColor>{ghostTail}</Text>
            </>
          )}
        </Text>
      </Box>
    </Box>
  )
}
