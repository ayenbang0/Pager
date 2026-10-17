import stringWidth from 'string-width'
import { gradientAt, mix } from '../colors.js'
import type { HomeStats } from '../engine.js'
import type { Theme } from '../themes.js'
import { chipPillKind, ctxTone, stateColor, stateWord } from './agentChrome.js'
import { LOGO, LOGO_WIDTH, REVEAL_FRAMES, sparkline, tagline, TAGLINE } from './banner.js'
import type { HomeAgentRow, HomeAgents } from './homeAgents.js'
import { agentTint, type Look } from './look.js'
import { bandLabel, clipSegs, fitSegs, gradientRule, gradientText, keycap, mergeSegs, pillSeg, segsWidth, type Seg } from './segs.js'

/** Fewest pane rows the banner is worth drawing in: the mark, the greeting and a wrapped contact code. */
export const BANNER_ROWS = 6
/** The five-letter block logo needs this much pane width and height; below either, a one-line mark. */
export const BIG_LOGO_MIN_WIDTH = 60
export const BIG_LOGO_MIN_ROWS = 24
/** Two columns of cards from this pane width; narrower panes stack them. */
export const TWO_COLUMN_MIN_WIDTH = 84
/** The cards never spread wider than this, however wide the pane. */
const MAX_INNER = 104
const COLUMN_GAP = 2
const LEFT_MIN = 30
const LEFT_MAX = 38
/** Agent rows shown before `+N more`. */
const AGENT_ROWS_MAX = 4
const MODEL_MAX = 12
const NAME_MAX = 10

const BLANK: Seg[] = [{ text: ' ' }]
/** The name Look carries before the user has chosen one; the welcome lines may know better. */
const DEFAULT_ME = 'you'

export interface HomeInput {
  /** Pane width and height in cells. */
  width: number
  height: number
  /** Animation frame; ignored when `animate` is false. */
  frame: number
  animate: boolean
  /** Local hour 0-23, for the greeting. */
  hour: number
  theme: Theme
  look: Look
  stats: HomeStats
  agents: HomeAgents
  /** The engine's welcome lines after the title: name, contact code, getting-started steps. */
  info: readonly string[]
}

export interface HomeInfo {
  name?: string
  code?: string
  steps: string[]
  /** Lines this parser does not know, kept so nothing the engine says is lost. */
  extra: string[]
}

/** The engine's welcome lines (`You  name`, `Contact code`, `  pgr1-…`, `Get started`, `  1. …`) as parts. */
export function parseInfo(info: readonly string[]): HomeInfo {
  const out: HomeInfo = { steps: [], extra: [] }
  for (const raw of info) {
    const line = raw.trim()
    const step = /^\d+\.\s+(.*)$/.exec(line)
    const you = /^You\s+(.+)$/.exec(line)
    if (line === '' || line === 'Contact code' || line === 'Get started') continue
    if (line.startsWith('pgr1-')) out.code = line
    else if (step?.[1] !== undefined) out.steps.push(step[1])
    else if (you?.[1] !== undefined) out.name = you[1]
    else out.extra.push(line)
  }
  return out
}

/** `text` cut to `n` columns with an ellipsis when it is longer; never padded. */
export function clipText(text: string, n: number): string {
  if (stringWidth(text) <= n) return text
  const cut = clipSegs([{ text }], Math.max(0, n - 1))[0]?.text ?? ''
  return `${cut}…`
}

/** `text` clipped (with an ellipsis) or padded to exactly `n` columns. */
export function fitText(text: string, n: number): string {
  const out = clipText(text, n)
  return out + ' '.repeat(Math.max(0, n - stringWidth(out)))
}

/** Word-wraps `text` to `width` display columns; a word longer than a line is broken. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter((x) => x !== '')) {
    let rest = word
    while (stringWidth(rest) > w) {
      if (cur !== '') lines.push(cur)
      cur = ''
      const part = clipSegs([{ text: rest }], w)[0]?.text || ([...rest][0] ?? rest)
      lines.push(part)
      rest = rest.slice(part.length)
    }
    const next = cur === '' ? rest : `${cur} ${rest}`
    if (stringWidth(next) <= w) cur = next
    else {
      lines.push(cur)
      cur = rest
    }
  }
  if (cur !== '') lines.push(cur)
  return lines.length > 0 ? lines : ['']
}

/** `items` laid out left to right, `gap` columns apart, starting a new row when the next one would not fit. */
export function flowSegs(items: readonly (readonly Seg[])[], width: number, gap = 2): Seg[][] {
  const rows: Seg[][] = []
  let cur: Seg[] = []
  for (const item of items) {
    if (cur.length > 0 && segsWidth(cur) + gap + segsWidth(item) > width) {
      rows.push(cur)
      cur = []
    }
    cur = cur.length === 0 ? [...item] : [...cur, { text: ' '.repeat(gap) }, ...item]
  }
  if (cur.length > 0) rows.push(cur)
  return rows.map((r) => clipSegs(r, width))
}

/** `segs` with `n` spaces in front. */
const indent = (segs: readonly Seg[], n: number): Seg[] => (n > 0 ? [{ text: ' '.repeat(n) }, ...segs] : [...segs])

/** `rows` shifted together so the widest is centered in `width` columns. */
export function centerBlock(rows: readonly (readonly Seg[])[], width: number): Seg[][] {
  const widest = Math.max(0, ...rows.map((r) => segsWidth(r)))
  const pad = Math.max(0, Math.floor((width - widest) / 2))
  return rows.map((r) => clipSegs(indent(r, pad), width))
}

/** A section heading as one row, drawn like `BandTitle`: `▌ TITLE ` on the band, then a gradient rule to the edge. */
export function bandTitleSegs(title: string, width: number, theme: Theme): Seg[] {
  const left = bandLabel(title, theme)
  const rule = Math.max(0, width - segsWidth(left) - 1)
  return clipSegs([...left, { text: ' ' }, ...gradientRule(rule, theme.gradient, '━')], width)
}

/** A glitch burst starts this often (in frames) after the logo has been revealed, and lasts GLITCH_FRAMES. About every 2.5 s at 70 ms a frame. */
export const GLITCH_EVERY = 36
export const GLITCH_FRAMES = 2
/** Cells that flicker to a pixel glyph in one burst, and how far a sliced strip slides. Small on purpose: a hint of static, not a show. */
const GLITCH_CELLS = 5
const GLITCH_SLIDE = 1
const PIXEL_GLYPHS = ['▀', '▄', '▌', '▐', '░', '▒', '▖', '▗', '▘', '▝'] as const

/** A repeatable pseudo-random number in [0, 1) for `seed`, so a given frame always glitches the same way. */
export function rand01(seed: number): number {
  let x = (seed ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  return ((x ^ (x >>> 16)) >>> 0) / 2 ** 32
}

/** The burst number and step within it for `frame`, or undefined while the logo is calm (or still being revealed). */
export function glitchAt(frame: number): { burst: number; step: number } | undefined {
  const since = frame - REVEAL_FRAMES
  if (since < 0 || since % GLITCH_EVERY >= GLITCH_FRAMES) return undefined
  return { burst: Math.floor(since / GLITCH_EVERY), step: since % GLITCH_EVERY }
}

/** Frames after which the tagline is fully typed. */
const TYPED_FRAMES = REVEAL_FRAMES + 14

/**
 * The frame number that draws exactly what `frame` draws. Once the logo is revealed and the tagline typed, only the cursor's blink
 * phase and a glitch burst change the picture, so every other frame maps onto one of two calm ones and the banner need not re-render.
 */
export function visualFrame(frame: number): number {
  if (frame < TYPED_FRAMES || glitchAt(frame) !== undefined) return frame
  return Math.floor(frame / 6) % 2 === 0 ? TYPED_FRAMES + 10 : TYPED_FRAMES + 4
}

/**
 * The block logo in the theme gradient, revealed left to right. Afterwards it sits still except for a rare, brief glitch: one thin strip
 * slides a column sideways and a few cells flicker to pixel glyphs in the second brand color. `animate: false` is the calm final frame.
 */
export function logoRows(frame: number, theme: Theme, animate: boolean): Seg[][] {
  const revealed = animate ? Math.floor(LOGO_WIDTH * Math.min(1, frame / REVEAL_FRAMES)) : LOGO_WIDTH
  const chars = LOGO.map((row) => [...row])
  const flicker = new Map<string, string>()
  const g = animate ? glitchAt(frame) : undefined
  if (g !== undefined) {
    const seed = g.burst * 131 + g.step * 17
    const row = Math.floor(rand01(seed) * chars.length)
    const from = Math.floor(rand01(seed + 1) * (LOGO_WIDTH - 14))
    const strip = chars[row]?.slice(from, from + 12) ?? []
    const slide = rand01(seed + 2) < 0.5 ? -GLITCH_SLIDE : GLITCH_SLIDE
    const shifted = strip.map((_, i) => strip[(i - slide + strip.length) % strip.length] ?? ' ')
    chars[row]?.splice(from, shifted.length, ...shifted)
    for (let k = 0; k < GLITCH_CELLS; k++) {
      const r = Math.floor(rand01(seed + 10 + k * 3) * chars.length)
      const c = Math.floor(rand01(seed + 11 + k * 3) * LOGO_WIDTH)
      if (chars[r]?.[c] !== undefined && chars[r]?.[c] !== ' ') flicker.set(`${r}:${c}`, PIXEL_GLYPHS[Math.floor(rand01(seed + 12 + k * 3) * PIXEL_GLYPHS.length)] ?? '▒')
    }
  }
  return chars.map((row, r) =>
    mergeSegs(
      row.map((ch, c): Seg => {
        if (c >= revealed || ch === ' ') return { text: ' ' }
        const base = gradientAt(theme.gradient, c / Math.max(1, LOGO_WIDTH - 1))
        const pixel = flicker.get(`${r}:${c}`)
        if (pixel !== undefined) return { text: pixel, color: theme.accent2, bold: true }
        const edge = animate && frame < REVEAL_FRAMES && c === revealed - 1
        if (ch === '█') return { text: ch, color: edge ? theme.text : base, bold: true }
        return { text: ch, color: mix(base, theme.surface, 0.45), dim: !base.startsWith('#') }
      }),
    ),
  )
}

/** The one-line mark: `◆ P A G E R ◆` in the gradient, then the tagline when it fits. */
export function markRow(frame: number, theme: Theme, animate: boolean, width: number): Seg[] {
  const mark = gradientText('◆ P A G E R ◆', theme.gradient, { bold: true })
  const tag = gradientText(tagline(frame, animate).padEnd(TAGLINE.length + 1), theme.gradient)
  const both = [...mark, { text: '   ' }, ...tag]
  return segsWidth(both) <= width ? both : mark
}

/** Time-of-day opener. */
export function greetingWord(hour: number): string {
  if (hour < 5) return 'Up late'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/** `Good evening, name ◆`: the name in the gradient, your badge in the glow color. */
export function greetingSegs(name: string, badge: string, hour: number, theme: Theme): Seg[] {
  const tail: Seg[] = badge === '' ? [] : [{ text: ` ${badge}`, color: theme.glow, bold: true }]
  return [{ text: `${greetingWord(hour)}, `, color: theme.text }, ...gradientText(name, theme.gradient, { bold: true }), ...tail]
}

/** The contact code behind a `CODE` pill, wrapped to `width` columns so none of it is cut, the block centered. */
export function codeRows(code: string, width: number, theme: Theme): Seg[][] {
  const label = pillSeg('CODE', theme.pill.accent)
  const room = Math.max(8, width - segsWidth([label]) - 1)
  const rows: Seg[][] = []
  for (let at = 0; at < code.length; at += room) {
    const lead: Seg = at === 0 ? label : { text: ' '.repeat(segsWidth([label])) }
    rows.push([lead, { text: ' ' }, { text: code.slice(at, at + room), color: theme.glow, bold: true }])
  }
  return centerBlock(rows, width)
}

export const bigLogo = (width: number, height: number): boolean => width >= BIG_LOGO_MIN_WIDTH && height >= BIG_LOGO_MIN_ROWS

/** Logo (or one-line mark), tagline, greeting, contact code and a spacer, all centered. */
export function headerRows(i: HomeInput, info: HomeInfo): Seg[][] {
  const { theme, width } = i
  const rows: Seg[][] = []
  if (bigLogo(width, i.height)) {
    rows.push(...centerBlock(logoRows(i.frame, theme, i.animate), width))
    const tag = gradientText(tagline(i.frame, i.animate).padEnd(TAGLINE.length + 1), theme.gradient, { italic: true })
    const wing = gradientRule(6, theme.gradient, '━')
    rows.push(...centerBlock([[...wing, { text: ' ' }, ...tag, { text: ' ' }, ...wing]], width))
  } else {
    rows.push(...centerBlock([markRow(i.frame, theme, i.animate, width)], width))
  }
  const name = i.look.me !== DEFAULT_ME ? i.look.me : (info.name ?? i.look.me)
  rows.push(...centerBlock([greetingSegs(name, i.look.badge, i.hour, theme)], width))
  if (info.code !== undefined) rows.push(...codeRows(info.code, width, theme))
  rows.push(BLANK)
  return rows
}

export type CardId = 'start' | 'people' | 'agents' | 'activity'

/** A titled block of rows. `tail` rows (the next step) survive when the card is cut short. */
export interface Card {
  title: string
  lines: Seg[][]
  tail?: Seg[][]
}

const KEY_HINTS: readonly (readonly [string, string])[] = [
  ['Ctrl+P', 'palette'],
  ['Ctrl+G', 'help'],
  ['Alt+↑↓', 'tabs'],
  ['/agent setup', 'agents'],
]

export function startCard(width: number, info: HomeInfo, theme: Theme): Card {
  const keys = flowSegs(
    KEY_HINTS.map(([key, label]): Seg[] => [...keycap(key, theme), { text: ` ${label}`, color: theme.text }]),
    width,
  )
  const lines: Seg[][] = [...keys]
  info.steps.forEach((step, n) => {
    wrapText(step, width - 4).forEach((text, row) => {
      const lead: Seg = row === 0 ? pillSeg(String(n + 1), theme.pill.accent) : { text: '    ' }
      lines.push([lead, { text: ' ' }, { text, color: theme.text }])
    })
  })
  for (const extra of info.extra) for (const text of wrapText(extra, width)) lines.push([{ text, color: theme.text }])
  return { title: 'START', lines }
}

export function peopleCard(width: number, stats: HomeStats, theme: Theme): Card {
  const online = stats.online > 0
  const first: Seg[] = [
    pillSeg(`${online ? '●' : '○'} ${stats.online} online`, theme.pill[online ? 'success' : 'muted']),
    { text: ` of ${stats.contacts} contacts`, color: theme.text },
  ]
  const pills = flowSegs(
    [
      [pillSeg(`# ${stats.groups} group${stats.groups === 1 ? '' : 's'}`, theme.pill[stats.groups > 0 ? 'info' : 'muted'])],
      [pillSeg(`${stats.pending} pending`, theme.pill[stats.pending > 0 ? 'warning' : 'muted'])],
      [pillSeg(`${stats.unread} unread`, theme.pill[stats.unread > 0 ? 'accent2' : 'muted'])],
    ],
    width,
    1,
  )
  return { title: 'PEOPLE', lines: [clipSegs(first, width), ...pills] }
}

export function activityCard(width: number, stats: HomeStats, theme: Theme): Card {
  const week = stats.week.reduce((a, b) => a + b, 0)
  const totals = flowSegs([[pillSeg(`↑ ${stats.sent} sent`, theme.pill.accent)], [pillSeg(`↓ ${stats.received} received`, theme.pill.accent2)]], width, 1)
  const spark: Seg[] = [...gradientText(sparkline(stats.week), theme.gradient, { bold: true }), { text: ` ${week} in 7d`, color: theme.text }]
  const top: Seg[] =
    stats.busiest === null
      ? [{ text: 'no chats yet', color: theme.dim }]
      : [{ text: 'top ', color: theme.dim }, { text: clipText(stats.busiest.title, Math.max(1, width - 12)), color: theme.text, bold: true }, { text: ` ${stats.busiest.count}`, color: theme.glow, bold: true }]
  return { title: 'ACTIVITY', lines: [...totals, clipSegs(spark, width), clipSegs(top, width)] }
}

interface Columns {
  name: number
  state: number
  model: number
  ctx: number
  turns: number
  approved: number
  changes: number
}

/** The text of each cell of an agent row, before padding. */
export function agentCells(row: HomeAgentRow): { ctx: string; model: string; turns: string; approved: string; changes: string } {
  return {
    ctx: row.ctx === undefined ? 'ctx —' : `ctx ${row.ctx}%`,
    model: row.model ?? row.cli,
    turns: `${row.turns}t ${row.files}f`,
    approved: `${row.approved}✓`,
    changes: `${row.changes}↻`,
  }
}

const widest = (texts: readonly string[], cap: number): number => Math.min(cap, Math.max(0, ...texts.map((t) => stringWidth(t))))

/** Column widths shared by every agent row, so state words, pills and counts line up. */
export function agentColumns(rows: readonly HomeAgentRow[]): Columns {
  const cells = rows.map(agentCells)
  return {
    name: widest(rows.map((r) => r.name), NAME_MAX),
    state: widest(rows.map((r) => stateWord(r.state)), 12),
    model: widest(cells.map((c) => c.model), MODEL_MAX),
    ctx: widest(cells.map((c) => c.ctx), 12),
    turns: widest(cells.map((c) => c.turns), 12),
    approved: widest(cells.map((c) => c.approved), 8),
    changes: rows.some((r) => r.changes > 0) ? widest(cells.map((c) => c.changes), 8) : 0,
  }
}

interface Part {
  /** Lower is more important; rank 0 is never dropped. */
  rank: number
  segs: Seg[]
}

/** The parts in order, dropping the least important (highest rank, last first) until the row fits `width`. */
export function dropToFit(parts: readonly Part[], width: number): Seg[] {
  const kept = [...parts]
  const total = (): number => kept.reduce((sum, p) => sum + segsWidth(p.segs), 0)
  while (total() > width) {
    let worst = -1
    kept.forEach((p, idx) => {
      if (p.rank > 0 && p.rank >= (kept[worst]?.rank ?? 0)) worst = idx
    })
    if (worst < 0) break
    kept.splice(worst, 1)
  }
  return clipSegs(
    kept.flatMap((p) => p.segs),
    width,
  )
}

/**
 * `● name  state  model  ctx 41%  5t 7f 2✓ 1↻`. The dot and name wear the agent's own color, the state word the state's color,
 * model and counts are pills, context is a pressure-colored pill. Narrow rows drop counts, then the model, then context, then the state word.
 */
export function agentRow(row: HomeAgentRow, cols: Columns, width: number, theme: Theme, tint: string): Seg[] {
  const cell = agentCells(row)
  const ctxKind = row.ctx === undefined ? 'muted' : chipPillKind(2, ctxTone(row.ctx))
  const counts: Seg[] = [pillSeg(fitText(cell.turns, cols.turns), theme.pill.muted), { text: ' ' }, pillSeg(fitText(cell.approved, cols.approved), theme.pill[row.approved > 0 ? 'success' : 'muted'])]
  if (cols.changes > 0) counts.push({ text: ' ' }, pillSeg(fitText(cell.changes, cols.changes), theme.pill[row.changes > 0 ? 'warning' : 'muted']))
  return dropToFit(
    [
      { rank: 0, segs: [{ text: '● ', color: tint, bold: true }, { text: `${fitText(row.name, cols.name)} `, color: tint, bold: true }] },
      { rank: 1, segs: [{ text: `${fitText(stateWord(row.state), cols.state)} `, color: stateColor(row.state, theme), bold: row.state !== 'idle' }] },
      { rank: 3, segs: [pillSeg(fitText(cell.model, cols.model), theme.pill[row.model === undefined ? 'muted' : 'accent']), { text: ' ' }] },
      { rank: 2, segs: [pillSeg(fitText(cell.ctx, cols.ctx), theme.pill[ctxKind]), { text: ' ' }] },
      { rank: 4, segs: counts },
    ],
    width,
  )
}

function agentSummaryLines(width: number, stats: HomeStats, agents: HomeAgents, theme: Theme): Seg[][] {
  const lines: Seg[][] = []
  const running = stats.agentsRunning
  const chips: Seg[][] = [
    [pillSeg(`⌁ ${running} running`, theme.pill[running > 0 ? 'accent' : 'muted'])],
    [pillSeg(`${stats.mergeable} to merge`, theme.pill[stats.mergeable > 0 ? 'success' : 'muted'])],
  ]
  if (agents.unadded > 0 && !agents.hint.includes('installed')) chips.push([pillSeg(`${agents.unadded} not added`, theme.pill.info)])
  lines.push(...flowSegs(chips, width, 1))
  lines.push(clipSegs([...gradientText(sparkline(agents.week), theme.gradient, { bold: true }), { text: ` ${agents.weekTotal} turns in 14d`, color: theme.text }], width))
  const quiet = agents.approved + agents.changes === 0
  const review: Seg[][] = [
    [{ text: '⚑ reviews', color: theme.text }],
    [pillSeg(`✓ ${agents.approved}`, theme.pill[quiet ? 'muted' : 'success'])],
    [pillSeg(`↻ ${agents.changes}`, theme.pill[agents.changes > 0 ? 'warning' : 'muted'])],
  ]
  if (agents.reviewsPending > 0) review.push([pillSeg(`${agents.reviewsPending} running`, theme.pill.info)])
  if (agents.questions > 0) review.push([pillSeg(`${agents.questions} asking`, theme.pill.warning)])
  lines.push(...flowSegs(review, width, 1))
  if (agents.usage !== undefined) {
    const text = `${agents.usage.agent}: ${agents.usage.line}`
    const age = ` · ${agents.usage.age}`
    lines.push(clipSegs([{ text: 'usage ', color: theme.dim }, { text: clipText(text, Math.max(1, width - 6 - stringWidth(age))), color: theme.text }, { text: age, color: theme.dim }], width))
  }
  return lines
}

export function agentsCard(width: number, stats: HomeStats, agents: HomeAgents, look: Look, theme: Theme): Card {
  const urgent = agents.rows.length === 0 || agents.questions > 0
  const hint = wrapText(agents.hint, Math.max(1, width - 2)).map(
    (text, n): Seg[] => (urgent ? [{ text: n === 0 ? '▸ ' : '  ', color: theme.glow, bold: true }, { text, color: theme.glow, bold: true }] : [{ text: '  ' }, { text, color: theme.dim }]),
  )
  if (agents.rows.length === 0) {
    const none = wrapText('coding agents you @mention in any chat', width).map((text): Seg[] => [{ text, color: theme.text }])
    return { title: 'AGENTS', lines: none, tail: hint }
  }
  const cols = agentColumns(agents.rows)
  const lines: Seg[][] = agents.rows.slice(0, AGENT_ROWS_MAX).map((row) => agentRow(row, cols, width, theme, agentTint(theme, look, row.name)))
  if (agents.rows.length > AGENT_ROWS_MAX) lines.push([{ text: `+${agents.rows.length - AGENT_ROWS_MAX} more`, color: theme.dim }])
  lines.push(...agentSummaryLines(width, stats, agents, theme))
  return { title: 'AGENTS', lines, tail: hint }
}

/** The card's rows cut to `maxRows` (title included), losing lines from the bottom but keeping the tail. */
export function renderCard(card: Card, width: number, maxRows: number, theme: Theme): Seg[][] {
  const tail = card.tail ?? []
  const avail = Math.max(0, maxRows - 1)
  const lines = card.lines.slice(0, Math.max(0, avail - tail.length))
  const room = avail - lines.length
  return [bandTitleSegs(card.title, width, theme), ...lines, ...tail.slice(0, room)]
}

/** Cards one under another with a blank row between, whole cards only once fewer than three rows are left, cut from the bottom. */
export function stackCards(cards: readonly Card[], width: number, room: number, theme: Theme): Seg[][] {
  const rows: Seg[][] = []
  for (const card of cards) {
    const left = room - rows.length - (rows.length > 0 ? 1 : 0)
    if (left < 3) break
    if (rows.length > 0) rows.push(BLANK)
    rows.push(...renderCard(card, width, left, theme))
  }
  return rows
}

function buildCard(id: CardId, width: number, i: HomeInput, info: HomeInfo): Card {
  if (id === 'start') return startCard(width, info, i.theme)
  if (id === 'people') return peopleCard(width, i.stats, i.theme)
  if (id === 'agents') return agentsCard(width, i.stats, i.agents, i.look, i.theme)
  return activityCard(width, i.stats, i.theme)
}

/** A brand-new pager (no messages, no agents) sees START first; everyone else sees their agents first. */
export function stackedOrder(stats: HomeStats, agents: HomeAgents): CardId[] {
  return stats.sent + stats.received === 0 && agents.rows.length === 0 ? ['start', 'people', 'agents', 'activity'] : ['agents', 'people', 'activity', 'start']
}

/** The cards under the header: two columns on wide panes (START and PEOPLE | AGENTS and ACTIVITY), one stack otherwise, centered, at most `room` rows. */
export function bodyRows(i: HomeInput, info: HomeInfo, room: number): Seg[][] {
  if (room < 3) return []
  const inner = Math.max(1, Math.min(i.width - 2, MAX_INNER))
  const offset = Math.max(0, Math.floor((i.width - inner) / 2))
  if (i.width < TWO_COLUMN_MIN_WIDTH) {
    const cards = stackedOrder(i.stats, i.agents).map((id) => buildCard(id, inner, i, info))
    return stackCards(cards, inner, room, i.theme).map((r) => indent(r, offset))
  }
  const leftW = Math.max(LEFT_MIN, Math.min(LEFT_MAX, Math.floor(inner * 0.34)))
  const rightW = inner - leftW - COLUMN_GAP
  const left = stackCards((['start', 'people'] as const).map((id) => buildCard(id, leftW, i, info)), leftW, room, i.theme)
  const right = stackCards((['agents', 'activity'] as const).map((id) => buildCard(id, rightW, i, info)), rightW, room, i.theme)
  const count = Math.max(left.length, right.length)
  return Array.from({ length: count }, (_, r) => indent([...fitSegs(left[r] ?? [], leftW), { text: ' '.repeat(COLUMN_GAP) }, ...fitSegs(right[r] ?? [], rightW)], offset))
}

/**
 * The whole Home screen as rows, at most `height` rows of at most `width` columns: header, then cards cut from the bottom
 * when the pane is short. With spare height the block sits a little below the top.
 */
export function homeRows(i: HomeInput): Seg[][] {
  const info = parseInfo(i.info)
  const header = headerRows(i, info)
  const body = bodyRows(i, info, i.height - header.length)
  const content = [...header, ...body].slice(0, i.height).map((r) => clipSegs(r, i.width))
  const pad = Math.floor((i.height - content.length) / 3)
  return [...Array.from({ length: pad }, () => BLANK), ...content]
}
