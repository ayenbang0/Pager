import stringWidth from 'string-width'
import { readableOn } from '../colors.js'
import type { VimState } from '../docs/vim.js'
import { rowPieces, type LineKind, type Row } from '../docs/view.js'
import type { PillKind, Theme } from '../themes.js'
import { clipSegs, fitSegs, gradientRule, keycap, pillSeg, segsWidth, selectedBar, spread, type Seg } from './segs.js'

export const MODE_LABEL: Record<VimState['mode'], string> = {
  normal: 'NORMAL',
  insert: 'INSERT',
  visual: 'VISUAL',
  vline: 'V-LINE',
  command: 'COMMAND',
  search: 'SEARCH',
}

const MODE_PILL: Record<VimState['mode'], PillKind> = {
  normal: 'accent',
  insert: 'success',
  visual: 'accent2',
  vline: 'accent2',
  command: 'warning',
  search: 'info',
}

/** The pill of a vim mode: normal is the accent, insert success, visual accent2, so the mode reads at a glance from across the room. */
export const modePill = (mode: VimState['mode'], theme: Theme): Seg => pillSeg(MODE_LABEL[mode], theme.pill[MODE_PILL[mode]])

/** How long ago `ms` was; 0 means the document has never been edited. */
export function ago(ms: number, now: number): string {
  if (ms === 0) return 'new'
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** `812`, `1.2k`, `15k`: a character count short enough for a pill. */
export function charCount(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`
}

/** A collaborator editing the document right now, with the color their messages use. */
export interface Peer {
  name: string
  color: string
}

/** A pill filled with a collaborator's author color, its text chosen to read on it. */
export const peerPill = (peer: Peer): Seg => pillSeg(`● ${peer.name}`, { fg: readableOn(peer.color), bg: peer.color })

/** Up to `max` tinted peer pills, then a muted `+N` for the rest. */
export function peerPills(peers: readonly Peer[], max: number, theme: Theme): Seg[] {
  const shown = peers.slice(0, max).flatMap((p): Seg[] => [peerPill(p), { text: ' ' }])
  const rest = peers.length - max
  return rest > 0 ? [...shown, pillSeg(`+${rest}`, theme.pill.muted), { text: ' ' }] : shown
}

/** `✓ synced` once every local edit has gone out, `● unsent` while some still wait for the flush. */
export const syncPill = (unsent: boolean, theme: Theme): Seg => (unsent ? pillSeg('● unsent', theme.pill.warning) : pillSeg('✓ synced', theme.pill.success))

export interface DocRowInput {
  name: string
  /** The chat the document lives in. */
  where: string
  length: number
  lastEdit: number
  peers: readonly Peer[]
  unsent: boolean
}

/** Shortest name column worth showing before the right-hand pills give way. */
const MIN_NAME_COLUMNS = 14

/** Right-hand runs of a list row, richest first: each next one drops something. */
function rightTiers(d: DocRowInput, now: number, theme: Theme): Seg[][] {
  const state: Seg[] = d.unsent ? [pillSeg('● unsent', theme.pill.warning), { text: ' ' }] : []
  const where = [pillSeg(d.where, theme.pill.accent2), { text: ' ' }]
  const age = { text: `${ago(d.lastEdit, now)} `, color: theme.text }
  const chars = { text: `${charCount(d.length)} chars · `, color: theme.dim }
  return [
    [...state, ...peerPills(d.peers, 2, theme), ...where, chars, age],
    [...state, ...peerPills(d.peers, 1, theme), ...where, age],
    [...state, ...where],
    [...state, age],
    state,
  ]
}

/**
 * One row of the document list, exactly `width` columns: a glyph and the name on the left; on the right the live-editor pills, the chat,
 * size and age, dropping parts (never the name) as the row narrows. The selected row is the accent bar.
 */
export function docRowSegs(d: DocRowInput, selected: boolean, width: number, now: number, theme: Theme): Seg[] {
  const left: Seg[] = [{ text: '▤ ', color: theme.accent2, bold: true }, { text: d.name, color: theme.text, bold: true }]
  const inner = Math.max(0, width - 1)
  const need = Math.min(MIN_NAME_COLUMNS, segsWidth(left))
  const right = rightTiers(d, now, theme).find((r) => inner - segsWidth(r) >= need) ?? []
  const row = spread(left, right, inner)
  return selected ? selectedBar(row, width, theme) : fitSegs([{ text: ' ' }, ...row], width)
}

export interface ListSummary {
  docs: number
  live: number
  unsent: number
}

/** The row under the list title: how many documents, how many have someone editing, how many have unsent edits. */
export function listSummary(s: ListSummary, width: number, theme: Theme): Seg[] {
  const segs: Seg[] = [{ text: ' ' }, pillSeg(`${s.docs} ${s.docs === 1 ? 'doc' : 'docs'}`, theme.pill.accent)]
  if (s.live > 0) segs.push({ text: ' ' }, pillSeg(`● ${s.live} live`, theme.pill.success))
  if (s.unsent > 0) segs.push({ text: ' ' }, pillSeg(`${s.unsent} unsent`, theme.pill.warning))
  segs.push({ text: '  shared Markdown, edited live with everyone in the chat', color: theme.dim })
  return fitSegs(segs, width)
}

/** The rows shown when there are no documents. */
export function emptyListRows(width: number, theme: Theme): Seg[][] {
  return [
    [{ text: ' ' }, pillSeg('no documents yet', theme.pill.muted)],
    [{ text: ' ' }, { text: '/doc new <name>', color: theme.glow, bold: true }, { text: '  starts a private one', color: theme.text }],
    [{ text: ' ' }, { text: '/doc new <name> in <chat>', color: theme.glow, bold: true }, { text: '  shares it with that chat', color: theme.text }],
  ].map((row) => fitSegs(row, width))
}

/** The hint row at the foot of the list, as keycaps. */
export function listFooter(width: number, theme: Theme): Seg[] {
  const label = (text: string): Seg => ({ text, color: theme.dim })
  const segs: Seg[] = [
    { text: ' ' },
    ...keycap('PgUp', theme),
    ...keycap('PgDn', theme),
    label(' pick  '),
    ...keycap('click', theme),
    label(' open  '),
    ...keycap('Enter', theme),
    label(' opens on an empty prompt  '),
    { text: '/doc rm name', color: theme.glow },
    label(' deletes'),
  ]
  return fitSegs(segs, width)
}

/** The top border of the editor frame: `╭─ NORMAL ━━━━━━━━ ✓ synced ─╮`, the rule fading across the theme gradient. Exactly `width` columns. */
export function frameTop(width: number, mode: Seg, right: Seg, theme: Theme): Seg[] {
  const first = theme.gradient[0] ?? theme.accent
  const last = theme.gradient.at(-1) ?? theme.accent
  const head: Seg[] = [{ text: '╭─', color: first }, mode, { text: ' ' }]
  const tail: Seg[] = [{ text: ' ' }, right, { text: '─╮', color: last }]
  const rule = width - segsWidth(head) - segsWidth(tail)
  if (rule < 0) return clipSegs([...head, ...tail], width)
  return [...head, ...gradientRule(rule, theme.gradient, '─'), ...tail]
}

/** The bottom border of the editor frame, exactly `width` columns. */
export function frameBottom(width: number, theme: Theme): Seg[] {
  const first = theme.gradient[0] ?? theme.accent
  const last = theme.gradient.at(-1) ?? theme.accent
  if (width < 2) return clipSegs([{ text: '╰╯', color: first }], width)
  return [{ text: '╰', color: first }, ...gradientRule(width - 2, theme.gradient, '─'), { text: '╯', color: last }]
}

export interface EditorRowInput {
  gutter: number
  /** The cursor is on this row's logical line. */
  onCursorLine: boolean
  kind: LineKind | undefined
  cursor: number
  sel: { start: number; end: number } | null
}

type RunStyle = Pick<Seg, 'bold' | 'color' | 'italic'>

/** Markdown styling of one logical line. */
function kindStyle(kind: LineKind | undefined, theme: Theme): RunStyle {
  switch (kind) {
    case 'heading':
      return { bold: true, color: theme.accent }
    case 'code':
      return { color: theme.info }
    case 'quote':
      return { color: theme.dim, italic: true }
    case 'rule':
      return { color: theme.dim }
    default:
      return {}
  }
}

/**
 * One visual row of the editor: the line number (dim, `glow` and bold on the cursor line; only a logical line's first row carries one),
 * then the text styled by Markdown kind. The cursor cell is inverse; a visual selection is the accent band.
 */
export function editorRowSegs(text: string, row: Row, i: EditorRowInput, theme: Theme): Seg[] {
  const number = row.first ? `${row.line + 1}`.padStart(i.gutter - 1) + ' ' : ' '.repeat(i.gutter)
  const gutter: Seg = i.onCursorLine ? { text: number, color: theme.glow, bold: true } : { text: number, color: theme.dim }
  const base = kindStyle(i.kind, theme)
  const pieces = rowPieces(text, row, i.cursor, i.sel)
  if (pieces.length === 0) return [gutter, { text: ' ' }]
  const runs = pieces.map((p): Seg => {
    if (p.cursor) return { ...base, text: p.text, bold: true, inverse: true }
    if (p.selected) return { ...base, text: p.text, color: theme.band.fg, bg: theme.band.bg }
    return { ...base, text: p.text }
  })
  return [gutter, ...runs]
}

export interface StatusInput {
  line: number
  col: number
  name: string
  peers: readonly Peer[]
  message: string
  pending: string
}

/** The row under the editor frame: position, document and live collaborators as pills; the last message (or the pending keys) at the right. */
export function statusRow(s: StatusInput, width: number, theme: Theme): Seg[] {
  const left: Seg[] = [{ text: ' ' }, pillSeg(`${s.line}:${s.col}`, theme.pill.accent2), { text: ' ' }, pillSeg(`▤ ${s.name}`, theme.pill.accent)]
  for (const p of s.peers) left.push({ text: ' ' }, peerPill(p))
  const right: Seg[] =
    s.message !== '' ? [{ text: `${s.message} `, color: theme.text, italic: true }] : s.pending === '' ? [] : [pillSeg(s.pending, theme.pill.muted), { text: ' ' }]
  const limit = Math.floor(width / 2)
  return spread(left, segsWidth(right) > limit ? clipSegs(right, limit) : right, width)
}

/** The row that replaces the status row while a `:` command or `/` search is typed: the prefix, the text (its tail when long) and a cursor block. */
export function commandRow(prefix: ':' | '/', typed: string, width: number, theme: Theme): Seg[] {
  const room = Math.max(0, width - 4)
  const chars = [...typed]
  let shown = chars.join('')
  while (chars.length > 0 && stringWidth(shown) > room) {
    chars.shift()
    shown = chars.join('')
  }
  return fitSegs([{ text: ' ' }, { text: prefix, color: theme.accent2, bold: true }, { text: shown, color: theme.text }, { text: ' ', inverse: true }], width)
}
