import { useRef, useState } from 'react'
import { Box, useInput, usePaste } from 'ink'
import type { Engine } from '../engine.js'
import { agentTint } from './look.js'
import { columnRows, initModelPicker, modelPickerKey, pickAgentKey, type ColumnSpec, type ModelPickerState, type PickerPair, type SettingKind } from './modelState.js'
import { agentBanner, chooserRowSegs, columnHeader, columnRowSegs, explainLines } from './modelSegs.js'
import { OverlayCard } from './OverlayCard.js'
import { CARD_CHROME_ROWS, footerSegs, listWindow, moreSegs, type KeyHint } from './overlayRows.js'
import { SegLine } from './SegLine.js'
import { keycap, pillSeg } from './segs.js'
import { useLook, useTheme } from './theme.js'

interface Props {
  engine: Engine
  /** The agent to configure, or null to choose one first. */
  agent: string | null
  /** Rows available, including the card border and title. */
  height: number
  onClose(): void
}

/** Card chrome, the agent line, the column sub-headers and the footer. */
const CHROME_ROWS = CARD_CHROME_ROWS + 3

const PICK_HINTS: readonly KeyHint[] = [
  ['↑↓', 'select'],
  ['Enter', 'choose'],
  ['Esc', 'close'],
]
const COLUMN_HINTS: readonly KeyHint[] = [
  ['Tab', 'column'],
  ['↑↓', 'move'],
  ['Enter', 'apply both'],
  ['Esc', 'close'],
]

function specOf(engine: Engine, name: string, kind: SettingKind, current: string | undefined): ColumnSpec {
  return {
    kind,
    settable: engine.agentSettable(name, kind),
    choices: engine.agentChoices(name, kind).map((c) => ({ value: c.value, label: c.name })),
    ...(current === undefined ? {} : { current }),
  }
}

/** Replaces the message pane: Model | Effort for one agent. Tab switches column, Up/Down move, Enter applies, Esc closes. */
export function ModelPicker({ engine, agent, height, onClose }: Props) {
  const theme = useTheme()
  const look = useLook()
  const agents = engine.agentRoom().agents
  const [chosen, setChosen] = useState<string | null>(agent)
  const [pickRow, setPickRow] = useState(0)
  const view = agents.find((a) => a.name === chosen)
  const pair: PickerPair | undefined =
    view === undefined ? undefined : { model: specOf(engine, view.name, 'model', view.model), effort: specOf(engine, view.name, 'effort', view.effort) }
  const [state, setState] = useState<ModelPickerState | undefined>(undefined)
  const current = state ?? (pair === undefined ? undefined : initModelPicker(pair))
  const latest = useRef(current)
  latest.current = current

  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (pair === undefined || latest.current === undefined) {
      const out = pickAgentKey(
        agents.map((a) => a.name),
        pickRow,
        { input, ...key },
      )
      setPickRow(out.row)
      if (out.close === true) return onClose()
      if (out.pick !== undefined) setChosen(out.pick)
      return
    }
    const out = modelPickerKey(pair, latest.current, { input, ...key })
    latest.current = out.state
    setState(out.state)
    if (out.effect?.kind === 'close') return onClose()
    if (out.effect?.kind === 'apply') {
      for (const change of out.effect.changes) engine.setAgentSetting(view?.name ?? '', change.kind, change.value)
      onClose()
    }
  })
  usePaste((text) => {
    if (pair === undefined || latest.current === undefined) return
    const col = latest.current.col
    const rows = columnRows(col === 0 ? pair.model : pair.effort)
    if (rows[latest.current.row[col]]?.kind !== 'text') return
    const next: [string, string] = [...latest.current.text]
    next[col] += text.replace(/[\r\n]+/g, ' ')
    latest.current = { ...latest.current, text: next }
    setState(latest.current)
  })

  if (pair === undefined || view === undefined || current === undefined) {
    const at = Math.min(pickRow, Math.max(0, agents.length - 1))
    const listRows = Math.max(1, height - CARD_CHROME_ROWS - 1)
    const { start, end, above, below } = listWindow(agents.length, at, listRows)
    return (
      <OverlayCard title="MODEL & EFFORT" height={height}>
        {(inner) => (
          <>
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              {agents.length === 0 ? (
                <SegLine segs={[{ text: ' ' }, pillSeg('no agents are ready', theme.pill.info), { text: ' run ', color: theme.dim }, ...keycap('/agent setup', theme)]} />
              ) : null}
              {agents.slice(start, end).map((a, i) => (
                <SegLine key={a.name} segs={chooserRowSegs(a, agentTint(theme, look, a.name), start + i === at, inner, theme)} />
              ))}
            </Box>
            <SegLine segs={footerSegs(PICK_HINTS, moreSegs(above, below, theme), inner, theme)} />
          </>
        )}
      </OverlayCard>
    )
  }

  const listRows = Math.max(1, height - CHROME_ROWS)
  const columns: { spec: ColumnSpec; title: string }[] = [
    { spec: pair.model, title: 'MODEL' },
    { spec: pair.effort, title: 'EFFORT' },
  ]
  return (
    <OverlayCard title="MODEL & EFFORT" height={height}>
      {(inner) => {
        const left = Math.floor(inner / 2)
        const shown = columns.map(({ spec }, c) => {
          const rows = columnRows(spec)
          const cursor = Math.min(current.row[c] ?? 0, Math.max(0, rows.length - 1))
          return { rows, cursor, win: listWindow(rows.length, cursor, listRows) }
        })
        const focusWin = shown[current.col]?.win
        return (
          <>
            <SegLine segs={agentBanner(view.name, view.cli, theme)} />
            <Box flexGrow={1} overflow="hidden">
              {columns.map(({ spec, title }, c) => {
                const { rows, cursor, win } = shown[c] ?? { rows: [], cursor: 0, win: listWindow(0, 0, listRows) }
                const focused = current.col === c
                // The first column leaves one cell as the gutter between the two.
                const width = c === 0 ? left - 1 : inner - left
                return (
                  <Box key={title} width={c === 0 ? left : inner - left} flexDirection="column" overflow="hidden">
                    <SegLine segs={columnHeader(title, spec, focused, width, theme)} />
                    {spec.settable ? null : explainLines(view.cli, title, width, listRows, theme).map((segs, i) => <SegLine key={i} segs={segs} />)}
                    {rows.slice(win.start, win.end).map((row, i) => (
                      <SegLine
                        key={win.start + i}
                        segs={columnRowSegs(row, spec, current.text[c] ?? '', { focused, cursor: win.start + i === cursor }, c === 0 ? 'type a model id' : 'type a level', width, theme)}
                      />
                    ))}
                  </Box>
                )
              })}
            </Box>
            <SegLine segs={footerSegs(COLUMN_HINTS, moreSegs(focusWin?.above ?? 0, focusWin?.below ?? 0, theme), inner, theme)} />
          </>
        )
      }}
    </OverlayCard>
  )
}
