import { useRef, useState } from 'react'
import { Box, useInput, usePaste } from 'ink'
import type { Engine, Toast } from '../../app/engine.js'
import { OverlayCard } from './OverlayCard.js'
import { CARD_CHROME_ROWS, footerSegs, listWindow, moreSegs, type KeyHint } from './overlayRows.js'
import { SpinnerLine } from '../kit/SpinnerLine.js'
import { clipSegs } from '../kit/segs.js'
import { setupKey, type SetupEffect, type SetupState } from './setupRows.js'
import { customHelp, customRowSegs, detailLines, readyPill, setupRowSegs } from './setupSegs.js'
import { useTheme } from '../theme/theme.js'

interface Props {
  engine: Engine
  /** Rows available, including the card border and title. */
  height: number
  onClose(): void
}

/** Card chrome, the detail block (four lines), the custom row and the footer. */
const DETAIL_ROWS = 4
const CHROME_ROWS = CARD_CHROME_ROWS + DETAIL_ROWS + 2

const LIST_HINTS: readonly KeyHint[] = [
  ['↑↓', 'select'],
  ['Enter', 'add'],
  ['r', 'recheck'],
  ['x', 'remove'],
  ['Esc', 'close'],
]
const TEXT_HINTS: readonly KeyHint[] = [
  ['Enter', 'add custom'],
  ['↑↓', 'select'],
  ['Esc', 'close'],
]

/** Replaces the message pane: every known agent with its readiness; Enter adds an instance, `r` rechecks, `x` removes one, Esc closes. */
export function AgentSetup({ engine, height, onClose }: Props) {
  const theme = useTheme()
  const rows = engine.agentSetup()
  const [state, setState] = useState<SetupState>({ row: 0, text: '' })
  const latest = useRef(state)
  const toast = (kind: Toast['kind'], text: string): void => void engine.emit('toast', { kind, text } satisfies Toast)
  const run = (effect: SetupEffect): void => {
    switch (effect.kind) {
      case 'close':
        return onClose()
      case 'add':
        onClose()
        return void engine.addAgent(effect.cli).then((problem) => {
          if (problem !== undefined) toast('error', problem)
        })
      case 'install':
        return toast('info', effect.text)
      case 'recheck':
        toast('info', `checking ${effect.cli}…`)
        return void engine.recheckAgent(effect.cli)
      case 'remove':
        return void engine.removeAgentOf(effect.cli)
      case 'custom':
        return void engine.submit(effect.command)
      case 'usage':
        return toast('error', 'Type: custom: <id> <command…>, e.g. mine node my-agent.js --acp')
    }
  }
  useInput((input, key) => {
    if (key.eventType === 'release') return
    const out = setupKey(latest.current, engine.agentSetup(), { input, ...key })
    latest.current = out.state
    setState(out.state)
    if (out.effect !== undefined) run(out.effect)
  })
  usePaste((text) => {
    if (latest.current.row !== engine.agentSetup().length) return
    latest.current = { ...latest.current, text: latest.current.text + text.replace(/[\r\n]+/g, ' ') }
    setState(latest.current)
  })

  const row = Math.min(state.row, rows.length)
  const onText = row === rows.length
  const selected = rows[row]
  const listRows = Math.max(1, height - CHROME_ROWS)
  const { start, end, above, below } = listWindow(rows.length, Math.min(row, rows.length - 1), listRows)
  const ready = rows.filter((r) => r.readiness.state === 'ready').length

  return (
    <OverlayCard title="AGENT SETUP" height={height}>
      {(inner) => {
        const more = moreSegs(above, below, theme)
        const right = [readyPill(ready, rows.length, theme), ...(more.length > 0 ? [{ text: ' ' }, ...more] : [])]
        const detail = selected === undefined ? customHelp(theme) : detailLines(selected, theme)
        return (
          <>
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              {rows.slice(start, end).map((r, i) => (
                <SpinnerLine key={r.id} segs={setupRowSegs(r, start + i === row, inner, theme)} />
              ))}
            </Box>
            <Box flexDirection="column" height={DETAIL_ROWS} overflow="hidden">
              {detail.map((segs, i) => (
                <SpinnerLine key={i} segs={clipSegs(segs, inner)} />
              ))}
            </Box>
            <SpinnerLine segs={customRowSegs(state.text, onText, inner, theme)} />
            <SpinnerLine segs={footerSegs(onText ? TEXT_HINTS : LIST_HINTS, right, inner, theme)} />
          </>
        )
      }}
    </OverlayCard>
  )
}
