import { ctrlH } from './ctrlH.js'
import { useRef, useState } from 'react'
import { Box, Text, useInput, usePaste } from 'ink'
import { readClipboard } from '../../platform/clipboard.js'
import type { MenuItem } from '../overlays/palette.js'
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
  replaceRange,
  setText,
  splitAtCursor,
  type InputBuffer,
} from './inputBuffer.js'
import { promptBorders, type PromptChip } from '../chrome/chrome.js'
import { SegLine } from '../kit/SegLine.js'
import { fitSegs, selectedBar } from '../kit/segs.js'
import { useTheme } from '../theme/theme.js'

interface Props {
  value: InputBuffer
  /** Functional update so keystrokes arriving before a re-render never overwrite each other. */
  onEdit(update: (prev: InputBuffer) => InputBuffer): void
  placeholder: string
  /** Rows of the menu above the prompt: command completions, or emoji for a `:name` before the cursor. */
  menu: MenuItem[]
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
  /** Columns the whole box (menu, borders) may use. */
  width: number
  /** Mode label on the top border: who the message goes to, or that it is a command. */
  chip: PromptChip
  /** Contextual keys, on the right of the bottom border. */
  hint: string
  /** Draws the text as dots (a secret being typed). */
  mask?: boolean
  /** When set, Esc calls this instead of clearing the input. */
  onEscape?: () => void
}

export function Prompt({
  value,
  onEdit,
  placeholder,
  menu,
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
  width,
  chip,
  hint,
  mask = false,
  onEscape,
}: Props) {
  const theme = useTheme()
  const [selected, setSelected] = useState(0)
  const historyPos = useRef<number | null>(null)
  const selectedRow = Math.min(selected, Math.max(0, menu.length - 1))
  // Dim completion learned from the user's own messages, offered only when the cursor is at the end and no menu is open.
  const ghost = menu.length === 0 && value.cursor === value.text.length ? suggest(value.text) : ''

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
          case 'v':
            return void readClipboard().then((text) => onEdit((b) => insert(b, text)))
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
        const item = menu[selectedRow]
        if (item) onEdit(() => replaceRange(value, item.from, item.to, item.insert))
        else if (ghost !== '') onEdit(() => setText(value.text + ghost))
        return
      }
      if (key.upArrow || key.downArrow) {
        const dir = key.upArrow ? -1 : 1
        if (menu.length > 0) {
          setSelected((selectedRow + dir + menu.length) % menu.length)
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
      if (key.backspace) return ctrlH.pending ? undefined : onEdit(backspace)
      if (key.delete) return onEdit(deleteForward)
      if (key.escape) return onEscape !== undefined ? onEscape() : onEdit(() => emptyInput)
      if (key.pageUp) return onScroll(1)
      if (key.pageDown) return onScroll(-1)
      if (input !== '') onEdit((b) => insert(b, input))
    },
    { isActive: active },
  )

  const split = splitAtCursor(value)
  const dots = (t: string): string => (mask ? '•'.repeat([...t].length) : t)
  const before = dots(split.before)
  const at = dots(split.at)
  const after = dots(split.after)
  // The first suggested character sits under the cursor block so the suggestion reads as one word.
  const ghostChars = [...ghost]
  const ghostHead = ghostChars[0]
  const ghostTail = ghostChars.slice(1).join('')

  const borders = promptBorders(width, chip, hint, active, theme)
  const stops = active ? theme.gradient : [theme.border]
  const slash = value.text.startsWith('/')

  return (
    <Box flexDirection="column" width={width}>
      {menu.map((m, i) => {
        const row = [{ text: ` ${m.label}`, color: theme.text, bold: true }, { text: m.summary === '' ? '' : `  ${m.summary}`, color: theme.dim }]
        return <SegLine key={m.label} segs={i === selectedRow ? selectedBar(row, width, theme) : fitSegs(row, width)} />
      })}
      <SegLine segs={borders.top} />
      <Box width={width} borderStyle="bold" borderTop={false} borderBottom={false} borderLeftColor={stops[0]} borderRightColor={stops.at(-1)} paddingX={1}>
        <Text wrap="truncate-start">
          <Text color={slash ? theme.accent2 : theme.glow} bold>
            ❯{' '}
          </Text>
          {value.text === '' ? (
            <>
              <Text inverse={active}> </Text>
              <Text color={theme.dim}>{placeholder}</Text>
            </>
          ) : (
            <>
              {before}
              <Text inverse={active} dimColor={at === '' && ghostHead !== undefined}>
                {at !== '' ? at : (ghostHead ?? ' ')}
              </Text>
              {after}
              <Text color={theme.dim}>{ghostTail}</Text>
            </>
          )}
        </Text>
      </Box>
      <SegLine segs={borders.bottom} />
    </Box>
  )
}
