import { useEffect, useRef, useState, type RefObject } from 'react'
import { Box, useInput } from 'ink'
import type { Engine, Toast } from '../../app/engine.js'
import { applySettingEdit, applySettingSet, runSettingAction, type FieldRequest } from '../../app/settingsActions.js'
import type { Chords } from '../input/chords.js'
import { SegLine } from '../kit/SegLine.js'
import { listWindow, moreSegs, footerSegs, type KeyHint } from '../overlays/overlayRows.js'
import { useTheme } from '../theme/theme.js'
import { buildSettingsRows } from './settingsModel.js'
import { firstCursor, settingsKey, settingsRowSegs, type SettingsEffect, type SettingsRow, type SettingsSection, type SettingsState } from './settingsRows.js'

/** What the app forwards to the panel: the mouse is owned by the app, not by components. */
export interface SettingsCtl {
  click(x: number, y: number): void
  wheel(direction: 1 | -1): void
}

interface Props extends Chords {
  engine: Engine
  width: number
  /** Rows available, including the footer. */
  height: number
  /** 1-based screen row of the panel's first row (for mouse mapping). */
  top: number
  active: boolean
  ctl: RefObject<SettingsCtl | null>
  /** Opens the one-shot text field in place of the prompt. */
  onField(field: FieldRequest): void
  onInterrupt(): void
}

const HINTS: readonly KeyHint[] = [
  ['↑↓', 'move'],
  ['←→', 'change'],
  ['Enter', 'edit / run'],
  ['Esc', 'home'],
]

const WHEEL_STEPS = 3

/** The Settings tab: sections of toggles, choices, text fields and actions driven by `settingsKey`. */
export function SettingsPanel({ engine, width, height, top, active, ctl, onField, onInterrupt, onPalette, onSidebar, onSwitch, onHelp, onQuit }: Props) {
  const theme = useTheme()
  const view = engine.settingsView()
  const rows = buildSettingsRows(view)
  const [state, setState] = useState<SettingsState>({ cursor: 0, confirming: null })
  const stateRef = useRef(state)
  stateRef.current = state
  const rowsRef = useRef<SettingsRow[]>(rows)
  rowsRef.current = rows
  const cursor = Math.min(state.cursor, Math.max(0, rows.length - 1))

  // `/settings <section>` and Alt+S ask for a section; jump to it once the panel is showing.
  useEffect(() => {
    const wanted = engine.takeSettingsFocus() as SettingsSection | undefined
    if (wanted === undefined) return
    const at = rowsRef.current.findIndex((r) => r.kind === 'section' && r.section === wanted)
    if (at >= 0) setState({ cursor: firstCursor(rowsRef.current, at), confirming: null })
  })
  // The agent rows include the verify command, which is read from the repository.
  useEffect(() => void engine.refreshAgentSettings(), [engine])
  // The first selectable row on entry (the list starts with a section header).
  useEffect(() => {
    if (stateRef.current.cursor === 0) setState({ cursor: firstCursor(rowsRef.current, 0), confirming: null })
  }, [])

  const toast = (kind: Toast['kind'], text: string): void => void engine.emit('toast', { kind, text } satisfies Toast)

  const perform = (effect: SettingsEffect): void => {
    const all = rowsRef.current
    try {
      switch (effect.kind) {
        case 'set':
          return applySettingSet(engine, effect.id, effect.value)
        case 'locked':
          return toast('error', `Locked by ${effect.source}`)
        case 'run':
          return runSettingAction(engine, effect.id, onField)
        case 'edit': {
          if (effect.id === 'theme') return engine.openThemePicker()
          const row = all.find((r) => (r.kind === 'text' || r.kind === 'choice') && r.id === effect.id)
          if (row === undefined || (row.kind !== 'text' && row.kind !== 'choice')) return
          const masked = row.kind === 'text' && row.masked === true
          return onField({
            label: row.label,
            initial: masked ? '' : row.kind === 'text' ? (row.initial ?? row.value) : row.value,
            masked,
            onSubmit: (text) => applySettingEdit(engine, effect.id, text),
          })
        }
      }
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err))
    }
  }

  const press = (p: Parameters<typeof settingsKey>[2]): void => {
    const next = settingsKey(stateRef.current, rowsRef.current, p)
    stateRef.current = next.state
    setState(next.state)
    if (next.effect !== undefined) perform(next.effect)
  }

  const body = Math.max(1, height - 1)
  const win = listWindow(rows.length, cursor, body)

  ctl.current = {
    click: (_x, y) => {
      const at = win.start + (y - top)
      const row = rows[at]
      if (row === undefined || row.kind === 'section' || row.kind === 'info') return
      stateRef.current = { cursor: at, confirming: null }
      setState(stateRef.current)
      press({ input: '', return: true })
    },
    wheel: (dir) => {
      for (let i = 0; i < WHEEL_STEPS; i++) press({ input: '', upArrow: dir === 1, downArrow: dir === -1 })
    },
  }

  useInput(
    (input, key) => {
      if (key.eventType === 'release') return
      if (/\[<\d*;?\d*;?\d*[Mm]?/.test(input) && input.includes('[<')) return
      if (key.meta && key.upArrow) return onSwitch(-1)
      if (key.meta && key.downArrow) return onSwitch(1)
      if (key.ctrl) {
        switch (input) {
          case 'p':
            return onPalette()
          case 'b':
            return onSidebar()
          case 'g':
            return onHelp()
          case 'n':
            return onSwitch(1)
          case 'o':
            return onSwitch(-1)
          case 'c':
            return onInterrupt()
          case 'd':
            return onQuit()
          default:
            return
        }
      }
      if (key.escape) return engine.activate(null)
      if (key.meta) return
      press({
        input,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        leftArrow: key.leftArrow,
        rightArrow: key.rightArrow,
        return: key.return,
        pageUp: key.pageUp,
        pageDown: key.pageDown,
        home: key.home,
        end: key.end,
      })
    },
    { isActive: active },
  )

  return (
    <Box height={height} width={width} flexDirection="column" overflow="hidden">
      {rows.slice(win.start, win.end).map((row, i) => {
        const at = win.start + i
        const key = row.kind === 'section' ? `s:${row.section}` : row.kind === 'info' ? `i:${row.label}` : `r:${row.id}`
        return <SegLine key={key} segs={settingsRowSegs(row, at === cursor && active, width, theme, row.kind === 'action' && state.confirming === row.id)} />
      })}
      <Box flexGrow={1} />
      <SegLine segs={footerSegs(HINTS, moreSegs(win.above, win.below, theme), width, theme)} />
    </Box>
  )
}
