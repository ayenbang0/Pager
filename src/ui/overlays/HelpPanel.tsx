import { useEffect, useMemo, useState, type RefObject } from 'react'
import { Box, useInput } from 'ink'
import { readableOn } from '../theme/colors.js'
import { helpKeyColumn, helpRows, scrollThumb, type HelpRow } from './helpRows.js'
import { COMMAND_SECTION, KEY_SECTIONS, type KeySection } from '../input/keymap.js'
import { agentTint } from '../theme/look.js'
import { BandTitle } from '../kit/kit.js'
import { SegLine } from '../kit/SegLine.js'
import { bandLabel, fitSegs, gradientRule, keycap, segsWidth, type Seg } from '../kit/segs.js'
import { useLook, useTheme } from '../theme/theme.js'

/** Lines per wheel notch, as in the message pane. */
const WHEEL_LINES = 3

/** What the app forwards to the panel: the mouse is owned by the app, not by components. */
export interface HelpCtl {
  /** +1 = wheel up (toward the top), -1 = wheel down. */
  wheel(direction: 1 | -1): void
}

interface Props {
  width: number
  height: number
  ctl: RefObject<HelpCtl | null>
  /** One section per ready agent, shown between the key sections and the command list. */
  agents: readonly KeySection[]
  onClose(): void
}

/**
 * Replaces the message pane. Any of Esc, Enter, q or Ctrl+G closes it; Up/Down, PgUp/PgDn and the wheel scroll it.
 * Long keys and actions wrap onto continuation rows, so nothing is cut at the right edge.
 */
export function HelpPanel({ width, height, ctl, agents, onClose }: Props) {
  const theme = useTheme()
  const look = useLook()
  // One column of left margin, one before the scrollbar, one for the scrollbar itself.
  const inner = Math.max(1, width - 3)
  const rows = useMemo(() => helpRows([...KEY_SECTIONS, ...agents, COMMAND_SECTION], inner), [inner, agents])
  const body = Math.max(1, height - 1)
  const maxTop = Math.max(0, rows.length - body)
  const [top, setTop] = useState(0)
  const first = Math.min(top, maxTop)
  // Functional, so a burst of wheel events inside one render all count.
  const scroll = (delta: number): void => setTop((t) => Math.max(0, Math.min(maxTop, Math.min(t, maxTop) + delta)))

  ctl.current = { wheel: (direction) => scroll(-direction * WHEEL_LINES) }
  useEffect(
    () => () => {
      ctl.current = null
    },
    [ctl],
  )

  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.escape || key.return || input === 'q' || (key.ctrl && (input === 'g' || input === 'c'))) return onClose()
    if (key.upArrow) scroll(-1)
    else if (key.downArrow) scroll(1)
    else if (key.pageUp) scroll(-Math.max(1, body - 1))
    else if (key.pageDown) scroll(Math.max(1, body - 1))
  })

  const keyColumn = helpKeyColumn(inner)
  const thumb = scrollThumb(rows.length, body, first)

  const sectionSegs = (row: Extract<HelpRow, { kind: 'section' }>): Seg[] => {
    const tint = row.agent === undefined ? undefined : agentTint(theme, look, row.agent)
    const label: Seg[] =
      tint === undefined
        ? bandLabel(row.text, theme)
        : [{ text: '▌', color: tint, bold: true }, { text: ` ◆ ${row.text} `, color: readableOn(tint), bg: tint, bold: true }]
    const rule = Math.max(0, inner - segsWidth(label) - 1)
    return [...label, { text: ' ' }, ...gradientRule(rule, [tint ?? theme.accent, theme.border], '━')]
  }
  const bodySegs = (row: HelpRow): Seg[] => {
    if (row.kind === 'gap') return []
    if (row.kind === 'section') return sectionSegs(row)
    const keys = row.pieces.flatMap((p): Seg[] => {
      if (p.style === 'cap') return keycap(p.text, theme)
      return [{ text: p.text, color: p.style === 'sep' ? theme.dim : theme.accent }]
    })
    const pad = { text: ' '.repeat(Math.max(0, keyColumn - row.keyWidth)) }
    const main = row.text.slice(0, row.detailFrom)
    const detail = row.text.slice(row.detailFrom)
    return [...keys, pad, { text: main, color: theme.text }, { text: detail, color: theme.dim }]
  }
  const bar = (i: number): Seg => {
    if (thumb === undefined) return { text: ' ' }
    return i >= thumb.start && i < thumb.start + thumb.size ? { text: '▐', color: theme.accent, bold: true } : { text: '▕', color: theme.border }
  }

  const last = Math.min(rows.length, first + body)
  return (
    <Box height={height} width={width} flexDirection="column" overflow="hidden">
      <BandTitle title="HELP" width={width} right={maxTop > 0 ? `${first + 1}-${last}/${rows.length} · Esc closes` : 'Esc closes'} />
      {rows.slice(first, first + body).map((row, i) => (
        <SegLine key={first + i} segs={[{ text: ' ' }, ...fitSegs(bodySegs(row), inner), { text: ' ' }, bar(i)]} />
      ))}
    </Box>
  )
}
