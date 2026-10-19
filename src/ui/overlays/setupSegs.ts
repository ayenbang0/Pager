import type { SetupRow } from '../../agents/orchestrator.js'
import type { Pill, Theme } from '../theme/themes.js'
import { setupDetail, setupLine } from './setupRows.js'
import { fieldSegs } from './overlayRows.js'
import { fitSegs, keycap, pillSeg, selectedBar, type Seg } from '../kit/segs.js'
import { spinnerCell } from '../kit/spinnerCells.js'

/** Columns of the agent id and (from `WIDE_FROM` on) of the status pill, so the rows line up. */
const NAME_COLUMN = 12
const STATUS_COLUMN = 15
const WIDE_FROM = 60

function statePill(row: SetupRow, theme: Theme): Pill {
  switch (row.readiness.state) {
    case 'ready':
      return theme.pill.success
    case 'checking':
      return theme.pill.accent
    case 'missing':
      return theme.pill.error
    case 'failed':
      return theme.pill.warning
    default:
      return theme.pill.muted
  }
}

/** The readiness pill: `● ready`, a live spinner while checking, `✗ missing`, `! failed` or `◌ not checked`. The word is always there, so colour is never the only signal. */
export function statusSegs(row: SetupRow, theme: Theme): Seg[] {
  const line = setupLine(row)
  const p = statePill(row, theme)
  if (row.readiness.state !== 'checking') return [pillSeg(`${line.glyph} ${line.word}`, p)]
  const face = { color: p.fg, bg: p.bg, bold: true }
  return [{ ...face, text: ' ' }, spinnerCell(face), { ...face, text: ` ${line.word} ` }]
}

/** One agent row of exactly `width` columns: status pill, id, instance count and `custom` chips, then the reason dim. The selected row is the accent bar. */
export function setupRowSegs(row: SetupRow, selected: boolean, width: number, theme: Theme): Seg[] {
  const line = setupLine(row)
  const wide = width >= WIDE_FROM
  const pill = statusSegs(row, theme)
  const chips: Seg[] = [
    ...(row.instances > 0 ? [{ text: ' ' }, pillSeg(`×${row.instances}`, theme.pill.muted)] : []),
    ...(row.custom ? [{ text: ' ' }, pillSeg('custom', theme.pill.accent2, false)] : []),
  ]
  const reason: Seg[] = line.reason === undefined || line.reason === '' ? [] : [{ text: ` ${line.reason}`, color: theme.dim }]
  const name: Seg = { text: wide ? row.id.padEnd(NAME_COLUMN) : row.id, color: theme.text, bold: true }
  const body: Seg[] = [...(wide ? fitSegs(pill, STATUS_COLUMN) : pill), { text: ' ' }, name, ...chips, ...reason]
  return selected ? selectedBar(body, width, theme) : fitSegs([{ text: ' ' }, ...body], width)
}

const DETAIL_LABELS = ['runs', 'install', 'sign in']

/** A detail line: `runs:`, `install:` and `sign in:` become a keycap-style chip before their value; anything else is the failure reason. */
export function detailSegs(line: string, row: SetupRow, theme: Theme): Seg[] {
  const colon = line.indexOf(': ')
  const label = colon === -1 ? '' : line.slice(0, colon)
  if (DETAIL_LABELS.includes(label)) {
    const color = label === 'runs' ? theme.text : theme.accent2
    return [{ text: ' ' }, ...keycap(label, theme), { text: ` ${line.slice(colon + 2)}`, color }]
  }
  const color = row.readiness.state === 'failed' ? theme.warning : theme.error
  return [{ text: ' ' }, { text: line, color }]
}

/** The (up to four) detail lines under the selected row. */
export function detailLines(row: SetupRow, theme: Theme): Seg[][] {
  return setupDetail(row)
    .slice(0, 4)
    .map((line) => detailSegs(line, row, theme))
}

/** The detail block while the `custom:` field is selected: what it accepts. */
export function customHelp(theme: Theme): Seg[][] {
  return [
    [{ text: ' ' }, pillSeg('custom agent', theme.pill.accent2), { text: ' register any agent that speaks ACP over stdio', color: theme.dim }],
    [{ text: ' ' }, ...keycap('<id> <command…>', theme), { text: ' e.g. ', color: theme.dim }, { text: 'mine node my-agent.js --acp', color: theme.text }],
  ]
}

/** The `custom:` input row of `width` columns; focused it carries the bar marker, the accent pill and the underline cursor. */
export function customRowSegs(text: string, focused: boolean, width: number, theme: Theme): Seg[] {
  const lead: Seg = focused ? { text: '▎', color: theme.glow, bold: true } : { text: ' ' }
  const prefix: Seg[] = [lead, pillSeg('custom', focused ? theme.pill.accent : theme.pill.muted), { text: ' ', bg: theme.surface }]
  return fieldSegs(prefix, { before: text, at: '', after: '' }, '<id> <command…>', focused, width, theme)
}

/** `3/12 ready`: the footer's count, green once anything is ready. */
export const readyPill = (ready: number, total: number, theme: Theme): Seg => pillSeg(`${ready}/${total} ready`, ready > 0 ? theme.pill.success : theme.pill.muted)
