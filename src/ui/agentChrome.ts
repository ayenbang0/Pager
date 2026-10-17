import stringWidth from 'string-width'
import type { QuestionView } from '../agents/questions.js'
import type { RunView } from '../agents/orchestrator.js'
import type { AgentView } from '../agents/types.js'
import { readableOn } from '../colors.js'
import type { Pill, PillKind, Theme } from '../themes.js'
import { pillSeg, type Seg } from './segs.js'

export type ChipTone = 'ok' | 'warn' | 'bad' | 'dim'

/** Context pressure as a percentage: green below 60, yellow below 85, red from 85. */
export function ctxTone(pct: number): ChipTone {
  if (pct >= 85) return 'bad'
  if (pct >= 60) return 'warn'
  return 'ok'
}

/** Theme colour for a chip tone; undefined (the default colour, dimmed by the caller) for `dim`. */
export function toneColor(tone: ChipTone, theme: Theme): string | undefined {
  if (tone === 'ok') return theme.success
  if (tone === 'warn') return theme.warning
  if (tone === 'bad') return theme.error
  return undefined
}

/** Dot colour of an agent state: working is the badge colour, asking warns, reviewing is info, idle is online-green. */
export function stateColor(state: AgentView['state'], theme: Theme): string {
  if (state === 'working') return theme.badge
  if (state === 'asking') return theme.warning
  if (state === 'reviewing') return theme.info
  return theme.online
}

export interface ChipPart {
  text: string
  tone: ChipTone
}

/** The agent tab header chip: `model · effort · ctx NN%`. A setting nobody chose reads `default`, so the chip never has holes. */
export function agentChip(a: AgentView): ChipPart[] {
  const pct = a.contextPct === undefined ? undefined : Math.round(a.contextPct * 100)
  return [
    { text: a.model ?? 'default model', tone: a.model === undefined ? 'dim' : 'ok' },
    { text: a.effort ?? 'default effort', tone: a.effort === undefined ? 'dim' : 'ok' },
    { text: pct === undefined ? 'ctx —' : `ctx ${pct}%`, tone: pct === undefined ? 'dim' : ctxTone(pct) },
  ]
}

/** Pill meaning of chip part `index` (model, effort, context): accent, accent2, and the context pressure tone; a default is a muted pill. */
export function chipPillKind(index: number, tone: ChipTone): PillKind {
  if (tone === 'dim') return 'muted'
  if (index === 0) return 'accent'
  if (index === 1) return 'accent2'
  return tone === 'bad' ? 'error' : tone === 'warn' ? 'warning' : 'success'
}

/** The chip as pills (` gpt-5 ` ` high ` ` ctx 40% `, then ` ⚑ review on `), one space between them and none after the last. */
export function chipSegs(parts: readonly ChipPart[], review: boolean, theme: Theme): Seg[] {
  const pills = parts.map((p, i) => pillSeg(p.text, theme.pill[chipPillKind(i, p.tone)]))
  if (review) pills.push(pillSeg(REVIEW_MARK, theme.pill.success))
  return pills.flatMap((p, i) => (i === 0 ? [p] : [{ text: ' ' }, p]))
}

/** Display width of `chipSegs` (each pill padded by a space each side, one space between), for hit-testing a click on the chip. */
export function chipWidth(parts: readonly ChipPart[], review: boolean): number {
  const texts = review ? [...parts.map((p) => p.text), REVIEW_MARK] : parts.map((p) => p.text)
  return texts.reduce((sum, t) => sum + stringWidth(t) + 2, 0) + Math.max(0, texts.length - 1)
}

/** Shown after the chip while automatic peer review is on. */
export const REVIEW_MARK = '⚑ review on'

const STATE_WORDS: Record<AgentView['state'], string> = { idle: 'idle', working: 'working', asking: 'asking you', reviewing: 'reviewing' }

export function stateWord(state: AgentView['state']): string {
  return STATE_WORDS[state]
}

/** Files the agent's latest run changed, or 0 before it has run. */
export function filesChanged(runs: readonly RunView[], agent: string): number {
  return runs.findLast((r) => r.agent === agent)?.files ?? 0
}

/** Hub header: who is doing what, as one line. */
export function whoDoesWhat(agents: readonly AgentView[]): string {
  if (agents.length === 0) return 'no agents ready — /agent setup'
  return agents
    .map((a) => {
      if (a.state === 'asking') return `${a.name} asks`
      if (a.state === 'reviewing') return `${a.name} reviews`
      return a.task === '' ? `${a.name} ${stateWord(a.state)}` : `${a.name} ▸ ${a.task}`
    })
    .join(' · ')
}

/**
 * The banner above the prompt in any tab when a question waits elsewhere; undefined when there is nothing to say.
 * `shown` is the question the picker already displays, which needs no banner.
 */
export function questionBanner(views: readonly QuestionView[], shown: QuestionView | undefined): string | undefined {
  const others = views.filter((v) => v.id !== shown?.id)
  const first = others[0]
  if (first === undefined) return undefined
  return `${first.agent} has a question — Alt+Q${others.length > 1 ? ` (+${others.length - 1} more)` : ''}`
}

/** The question the active tab shows inline: an agent's own, or the oldest one in the hub. */
export function questionFor(views: readonly QuestionView[], agentTab: string | undefined, inHub: boolean): QuestionView | undefined {
  if (agentTab !== undefined) return views.find((v) => v.agent === agentTab)
  return inHub ? views[0] : undefined
}

/** Where Alt+Q goes: the oldest question not already on screen, else the oldest. */
export function questionTarget(views: readonly QuestionView[], shown: QuestionView | undefined): QuestionView | undefined {
  return views.find((v) => v.id !== shown?.id) ?? views[0]
}

/** The animated cell inside the state pill: a spinner while working, a blinking `?` while asking. */
export type HeaderCell = 'spinner' | 'blink'

/** The left side of an agent title row, split around the state pill's animated cell (which needs a hook, so the component draws it). */
export interface HeaderLeft {
  before: Seg[]
  /** Drawn between `before` and `after`, one column wide, on `pill`. */
  cell?: { kind: HeaderCell; pill: Pill }
  after: Seg[]
}

/**
 * Identity pill in the agent's color, its CLI, the state (a pill while working, asking or reviewing, a dim `● idle` otherwise),
 * then the task and a muted `N files changed` pill.
 */
export function agentHeaderLeft(view: AgentView, files: number, theme: Theme, tint: string): HeaderLeft {
  const before: Seg[] = [{ text: ' ' }, { text: ` ◆ ${view.name} `, color: readableOn(tint), bg: tint, bold: true }]
  if (view.cli !== view.name) before.push({ text: ` ${view.cli}`, color: theme.dim })
  before.push({ text: ' ' })
  const after: Seg[] = []
  let cell: HeaderLeft['cell']
  if (view.state === 'idle') {
    before.push({ text: '●', color: theme.online }, { text: ` ${stateWord('idle')}`, color: theme.dim })
  } else if (view.state === 'reviewing') {
    before.push(pillSeg(stateWord('reviewing'), theme.pill.info))
  } else {
    const pill = view.state === 'working' ? theme.pill.accent2 : theme.pill.warning
    cell = { kind: view.state === 'working' ? 'spinner' : 'blink', pill }
    before.push({ text: ' ', color: pill.fg, bg: pill.bg, bold: true })
    after.push({ text: ` ${stateWord(view.state)} `, color: pill.fg, bg: pill.bg, bold: true })
  }
  if (view.task !== '') after.push({ text: ` ${view.task}`, color: theme.dim })
  if (files > 0) after.push({ text: ' ' }, pillSeg(`${files} file${files === 1 ? '' : 's'} changed`, theme.pill.muted))
  return cell === undefined ? { before: [...before, ...after], after: [] } : { before, cell, after }
}

/** The hub title row, unclipped: `⌁ AGENTS` pill, the goal as an accent2 pill (at most `maxGoal` columns), then who is doing what. */
export function hubHeaderSegs(agents: readonly AgentView[], goal: string, maxGoal: number, theme: Theme): Seg[] {
  const segs: Seg[] = [{ text: ' ' }, pillSeg('⌁ AGENTS', theme.pill.accent)]
  if (goal !== '') {
    const room = Math.max(1, maxGoal - 8)
    const chars = [...goal]
    const shown = stringWidth(goal) <= room ? goal : `${chars.slice(0, Math.max(0, room - 1)).join('')}…`
    segs.push({ text: ' ' }, pillSeg(`goal: ${shown}`, theme.pill.accent2))
  }
  segs.push({ text: ` ${whoDoesWhat(agents)}`, color: theme.dim })
  return segs
}
