import type { Theme } from '../theme/themes.js'
import type { ColumnRow, ColumnSpec } from './modelState.js'
import { fieldSegs, wrapWords } from './overlayRows.js'
import { bandLabel, clipSegs, fitSegs, gradientRule, pillSeg, segsWidth, selectedBar, type Seg } from '../kit/segs.js'
import { truncateWidth } from '../kit/truncate.js'

/** `▌ MODEL ● gpt-5 ━━━━`: a band sub-header. The focused column wears the accent band and a gradient rule, the other a muted band and a plain rule. */
export function columnHeader(title: string, spec: ColumnSpec, focused: boolean, width: number, theme: Theme): Seg[] {
  const label: Seg[] = focused ? bandLabel(title, theme) : [{ text: '▌', color: theme.pill.muted.bg, bold: true }, pillSeg(title, theme.pill.muted)]
  const value = truncateWidth(spec.current ?? 'default', Math.max(4, width - segsWidth(label) - 3))
  const left: Seg[] = [...label, { text: ` ${value} `, color: focused ? theme.text : theme.dim, bold: focused }]
  const room = Math.max(0, width - segsWidth(left))
  const rule: Seg[] = focused ? gradientRule(room, theme.gradient, '━') : room > 0 ? [{ text: '─'.repeat(room), color: theme.border }] : []
  return clipSegs([...left, ...rule], width)
}

/** Where a column row sits: its column has focus, and the cursor is on it. */
export interface RowFocus {
  focused: boolean
  cursor: boolean
}

/** Whether `row` is the value in effect. */
export function isCurrent(row: ColumnRow, spec: ColumnSpec): boolean {
  if (row.kind === 'default') return spec.current === undefined
  return row.kind === 'choice' && row.value === spec.current
}

/**
 * One column row of exactly `width` columns: `●` (success) on the value in effect, `○` elsewhere, the free-text row as an input
 * with an underline cursor. The cursor row of the focused column is the accent bar; the other column only shows a `›` marker there.
 */
export function columnRowSegs(row: ColumnRow, spec: ColumnSpec, text: string, at: RowFocus, placeholder: string, width: number, theme: Theme): Seg[] {
  const here = at.focused && at.cursor
  if (row.kind === 'text') {
    const lead: Seg = here ? { text: '▎', color: theme.glow, bold: true } : { text: ' ' }
    const prefix: Seg[] = [lead, { text: '✎ ', color: theme.accent2, bold: true, bg: theme.surface }]
    return fieldSegs(prefix, { before: text, at: '', after: '' }, here ? placeholder : 'none advertised', here, width, theme)
  }
  const on = isCurrent(row, spec)
  const label = row.kind === 'default' ? 'default' : row.label
  const body: Seg[] = [
    { text: on ? '●' : '○', color: on ? theme.success : theme.dim, bold: on },
    { text: ` ${truncateWidth(label, Math.max(1, width - 4))}`, color: on ? theme.success : theme.text, bold: on },
  ]
  if (here) return selectedBar(body, width, theme)
  const lead: Seg = at.cursor ? { text: '›', color: theme.accent2, bold: true } : { text: ' ' }
  return fitSegs([lead, ...body], width)
}

/** Why a column cannot be changed, as info pills wrapped to `width`; cut with `…` after `maxLines`. */
export function explainLines(cli: string, title: string, width: number, maxLines: number, theme: Theme): Seg[][] {
  const model = title.toLowerCase() === 'model'
  const text = `Not settable: ${cli} advertises no ${title.toLowerCase()} option and its CLI has no flag for it.${model ? ' Options appear once the agent has answered a message.' : ''}`
  const lines = wrapWords(text, Math.max(4, width - 3))
  const cut = lines.length > maxLines
  return lines.slice(0, Math.max(1, maxLines)).map((line, i, shown): Seg[] => [{ text: ' ' }, pillSeg(cut && i === shown.length - 1 ? truncateWidth(`${line}…`, Math.max(4, width - 3)) : line, theme.pill.info)])
}

/** The agent chooser row: its tint dot, name, cli pill and what is set. The selected row is the accent bar. */
export function chooserRowSegs(agent: { name: string; cli: string; model?: string; effort?: string }, tint: string, selected: boolean, width: number, theme: Theme): Seg[] {
  const set = [agent.model, agent.effort].filter((v): v is string => v !== undefined && v !== '')
  const body: Seg[] = [
    { text: '●', color: tint, bold: true },
    { text: ` ${agent.name} `, color: tint, bold: true },
    pillSeg(agent.cli, theme.pill.muted, false),
    ...(set.length === 0 ? [] : [{ text: ` ${set.join(' · ')}`, color: theme.dim }]),
  ]
  return selected ? selectedBar(body, width, theme) : fitSegs([{ text: ' ' }, ...body], width)
}

/** The line under the title once an agent is chosen: its name and cli, and when a change lands. */
export function agentBanner(name: string, cli: string, theme: Theme): Seg[] {
  return [{ text: ' ' }, pillSeg(name, theme.pill.accent), { text: ` ${cli}`, color: theme.text }, { text: '  applies to its next message', color: theme.dim }]
}
