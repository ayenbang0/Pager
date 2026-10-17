import type { AgentState } from './types.js'

export const BOARD_TASK_CHARS = 200
export const BOARD_PURPOSE_CHARS = 300
export const BOARD_FILES = 8

/** What one teammate shows on the shared board. */
export interface BoardEntry {
  name: string
  state: AgentState
  task: string
  purpose: string
  files: string[]
  branch: string
}

/** One line, whitespace collapsed, cut to `max` characters including the ellipsis. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function line(e: BoardEntry): string {
  const shown = e.files.slice(0, BOARD_FILES)
  const extra = e.files.length - shown.length
  const files = shown.length === 0 ? 'none' : `${shown.join(', ')}${extra > 0 ? `, +${extra}` : ''}`
  const task = oneLine(e.task, BOARD_TASK_CHARS)
  const fits = oneLine(e.purpose, BOARD_PURPOSE_CHARS)
  return `${e.name} (${e.state}) task: ${task === '' ? '(none)' : task} | fits: ${fits === '' ? '?' : fits} | files: ${files} | branch ${e.branch}`
}

/** The text every agent sees at the top of its prompt: the goal, its own task and everyone else's. */
export function renderBoard(entries: BoardEntry[], goal: string, forName: string): string {
  const goalText = oneLine(goal, BOARD_PURPOSE_CHARS)
  const out = ['--- BOARD ---', `GOAL: ${goalText === '' ? '(not set)' : goalText}`]
  const me = entries.find((e) => e.name === forName)
  if (me !== undefined) out.push(`YOU: ${line(me)}`)
  out.push('OTHERS:')
  const others = entries.filter((e) => e.name !== forName)
  if (others.length === 0) out.push('- none')
  else for (const e of others) out.push(`- ${line(e)}`)
  return out.join('\n')
}
