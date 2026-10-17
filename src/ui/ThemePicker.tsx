import { useState } from 'react'
import { Box, useInput } from 'ink'
import { PILL_KINDS, THEMES, type Theme } from '../themes.js'
import { BandTitle } from './kit.js'
import { SegLine } from './SegLine.js'
import { fitSegs, keycap, type Seg } from './segs.js'
import { useTheme } from './theme.js'

interface Props {
  width: number
  height: number
  /** The saved theme's name: the cursor starts on it and Esc goes back to it. */
  current: string
  /** Called on every cursor move with the highlighted theme's name: the whole UI redraws in it. */
  onPreview(name: string): void
  /** Enter: keep the highlighted theme. */
  onPick(name: string): void
  /** Esc: leave the picker (the caller reverts the preview). */
  onCancel(): void
}

/** A theme's own swatch: its logo gradient and one block per pill kind, drawn in that theme's colors regardless of the active one. */
function swatch(t: Theme): Seg[] {
  return [
    ...t.gradient.map((color): Seg => ({ text: '██', color })),
    { text: ' ' },
    ...PILL_KINDS.filter((k) => k !== 'muted').map((k): Seg => ({ text: '▐▌', color: t.pill[k].bg })),
  ]
}

/**
 * `/theme` with no argument. Up/Down preview a theme live across the whole UI, Enter keeps it, Esc puts the saved one back.
 * There is no text field here, so nothing printable is bound.
 */
export function ThemePicker({ width, height, current, onPreview, onPick, onCancel }: Props) {
  const theme = useTheme()
  const [at, setAt] = useState(Math.max(0, THEMES.findIndex((t) => t.name === current)))
  const move = (delta: number): void => {
    const next = (at + delta + THEMES.length) % THEMES.length
    setAt(next)
    onPreview(THEMES[next]?.name ?? current)
  }
  useInput((_input, key) => {
    if (key.eventType === 'release') return
    if (key.upArrow) move(-1)
    else if (key.downArrow) move(1)
    else if (key.pageUp || key.home) {
      setAt(0)
      onPreview(THEMES[0]?.name ?? current)
    } else if (key.pageDown || key.end) {
      setAt(THEMES.length - 1)
      onPreview(THEMES[THEMES.length - 1]?.name ?? current)
    } else if (key.return) onPick(THEMES[at]?.name ?? current)
    else if (key.escape) onCancel()
  })
  const rowsShown = Math.max(1, height - 3)
  const first = Math.min(Math.max(0, at - Math.floor(rowsShown / 2)), Math.max(0, THEMES.length - rowsShown))
  const keys: Seg[] = [...keycap('↑↓', theme), { text: ' preview  ' }, ...keycap('Enter', theme), { text: ' keep  ' }, ...keycap('Esc', theme), { text: ' revert' }]
  return (
    <Box flexDirection="column" height={height} width={width}>
      <BandTitle title="THEMES" width={width} right={`${at + 1}/${THEMES.length}`} />
      {THEMES.slice(first, first + rowsShown).map((t, i) => {
        const selected = first + i === at
        const bg = selected ? theme.band.bg : undefined
        const lead: Seg = selected ? { text: '▎', color: theme.glow, bg, bold: true } : { text: ' ' }
        const name: Seg = { text: ` ${t.name === current ? '✓' : ' '} ${t.name.padEnd(9)}`, color: selected ? theme.band.fg : theme.text, bg, bold: selected }
        const note: Seg = { text: `  ${t.description}`, color: selected ? theme.band.fg : theme.dim, bg }
        const row = [lead, name, ...swatch(t).map((sw): Seg => (selected ? { ...sw, bg } : sw)), note]
        return <SegLine key={t.name} segs={fitSegs(row, width, bg === undefined ? {} : { bg })} />
      })}
      <Box flexGrow={1} />
      <SegLine segs={fitSegs(keys, width)} />
    </Box>
  )
}
