import { useRef, useState } from 'react'
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink'
import { SegLine } from '../kit/SegLine.js'
import { clipSegs, keycap } from '../kit/segs.js'
import type { AnswerMap, QuestionView } from '../../agents/run/questions.js'
import { initPicker, PICKER_BORDER_ROWS, pickerKey, pickerRows, type PickerState } from './questionState.js'
import { useTheme } from '../theme/theme.js'

interface Props {
  view: QuestionView
  /** False while an overlay owns the keyboard. */
  active: boolean
  /** Rows to fill, from `pickerHeight`. */
  height: number
  /** The answers, or null when the user cancelled. */
  onAnswer(answers: AnswerMap | null): void
  /** Ctrl/Alt chords that still work while the prompt is replaced by the picker. */
  onSwitch(direction: 1 | -1): void
  onPalette(): void
  onHelp(): void
  onSidebar(): void
}

/** An agent's question, in place of the prompt. Printable keys only type while the Other (text) row is focused. */
export function QuestionPicker({ view, active, height, onAnswer, onSwitch, onPalette, onHelp, onSidebar }: Props) {
  const theme = useTheme()
  const { columns } = useWindowSize()
  const [state, setState] = useState<PickerState>(() => initPicker(view))
  const latest = useRef(state)

  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.meta && key.upArrow) return onSwitch(-1)
    if (key.meta && key.downArrow) return onSwitch(1)
    if (key.ctrl) {
      if (input === 'c') return onAnswer(null)
      if (input === 'p') return onPalette()
      if (input === 'g') return onHelp()
      if (input === 'b') return onSidebar()
      if (input === 'n') return onSwitch(1)
      if (input === 'o') return onSwitch(-1)
    }
    const out = pickerKey(view, latest.current, { input, ...key })
    latest.current = out.state
    setState(out.state)
    if (out.effect?.kind === 'submit') onAnswer(out.effect.answers)
    else if (out.effect?.kind === 'cancel') onAnswer(null)
  }, { isActive: active })
  usePaste((text) => {
    const f = view.fields[latest.current.field]
    const cursor = latest.current.row[latest.current.field] ?? 0
    if (f === undefined || !(f.kind === 'text' || (f.allowOther && cursor === f.options.length))) return
    const joined = text.replace(/[\r\n]+/g, ' ')
    const at = latest.current.field
    latest.current = { ...latest.current, text: latest.current.text.map((t, i) => (i === at ? t + joined : t)) }
    setState(latest.current)
  }, { isActive: active })

  const rows = pickerRows(view, state, height - PICKER_BORDER_ROWS)
  const pill = theme.pill.warning
  const width = Math.max(10, columns - 6)
  return (
    <Box height={height} flexDirection="column" overflow="hidden" paddingX={1} borderStyle="round" borderColor={theme.accent}>
      {rows.map((row, i) => {
        switch (row.kind) {
          case 'head':
            return (
              <Box key={i}>
                <Text color={pill.fg} backgroundColor={pill.bg} bold>{` ? ${row.agent} asks `}</Text>
                <Text bold color={theme.text} wrap="truncate-end">{` ${row.message}`}</Text>
              </Box>
            )
          case 'field': {
            const mark = row.status === 'done' ? '✓' : row.status === 'current' ? '▶' : '○'
            return (
              <Text key={i} wrap="truncate-end" bold={row.status === 'current'} dimColor={row.status === 'todo'}>
                <Text color={row.status === 'done' ? theme.success : theme.accent}>{mark} </Text>
                {row.total > 1 ? `${row.index}/${row.total} ` : ''}
                {row.label}
                {row.answer === '' ? '' : <Text color={theme.glow}>{`  ${row.answer}`}</Text>}
              </Text>
            )
          }
          case 'option':
            return (
              <Text key={i} wrap="truncate-end">
                <Text color={theme.accent} bold>{row.here ? ' ▎' : '  '}</Text>
                <Text color={row.here ? theme.glow : undefined} bold={row.here} inverse={row.here}>{` ${row.marker} ${row.label} `}</Text>
                {row.recommended ? <Text color={theme.success} bold> ★ recommended</Text> : null}
                {row.description === '' ? null : <Text color={theme.dim}>{`  ${row.description}`}</Text>}
              </Text>
            )
          case 'other':
            return (
              <Text key={i} wrap="truncate-start">
                <Text color={theme.accent} bold>{row.here ? ' ▎' : '  '}</Text>
                <Text color={row.here ? theme.glow : undefined} bold={row.here}>{` ${row.marker} ${row.label}: `}</Text>
                {row.text}
                {row.here ? <Text inverse> </Text> : row.text === '' ? <Text color={theme.dim}>type here</Text> : null}
              </Text>
            )
          case 'hint':
            return (
              <Box key={i}>
                <SegLine segs={clipSegs([{ text: row.lead === '' ? '' : `${row.lead}  `, color: theme.dim }, ...row.keys.flatMap((k) => [...keycap(k.key, theme), { text: ` ${k.label}  `, color: theme.dim }])], width)} />
              </Box>
            )
        }
      })}
    </Box>
  )
}
