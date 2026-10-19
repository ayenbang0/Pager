import path from 'node:path'
import type { TermState } from '../../tools/terminal/terminal.js'
import type { PillKind, Theme } from '../theme/themes.js'
import { bandLabel, clipSegs, gradientRule, pillSeg, segsWidth, type Seg } from '../kit/segs.js'

/** What the header needs of the terminal: whether a command runs, where, and how the latest one ended. */
export interface TermInfo {
  running: boolean
  cwd: string
  last: { command: string; state: TermState; code: number | null } | null
}

/** The shell a command runs in, as a short name: `cmd`, `pwsh`, `bash`, `zsh`. */
export function shellLabel(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const raw = platform === 'win32' ? (env.ComSpec ?? 'cmd.exe') : (env.SHELL ?? '/bin/sh')
  const base = raw.split(/[\\/]/).pop() ?? raw
  return path.parse(base).name.toLowerCase() || 'sh'
}

/** The state pill: running, the exit code of the latest command (success or error), stopped, or idle before any command. */
export function termStatus(t: TermInfo): { text: string; kind: PillKind } {
  if (t.running) return { text: '● running', kind: 'info' }
  const last = t.last
  if (last === null) return { text: 'idle', kind: 'muted' }
  if (last.state === 'stopped') return { text: '■ stopped', kind: 'warning' }
  if (last.state === 'done') return { text: `✓ exit ${last.code ?? 0}`, kind: 'success' }
  return { text: last.code === null ? '✗ failed' : `✗ exit ${last.code}`, kind: 'error' }
}

/**
 * The Terminal tab's title row, exactly `width` columns: the `▸ terminal` band, the shell as a pill, then the running command (or the
 * working directory) on the left; the status pill at the right with a gradient rule between. The status pill outranks the left side.
 */
export function terminalTitle(t: TermInfo, shell: string, width: number, theme: Theme): Seg[] {
  const status = termStatus(t)
  const right: Seg[] = [pillSeg(status.text, theme.pill[status.kind])]
  const detail: Seg[] =
    t.running && t.last !== null
      ? [{ text: '❯ ', color: theme.accent, bold: true }, { text: t.last.command, color: theme.text, bold: true }]
      : [{ text: t.cwd, color: theme.dim }]
  const avail = Math.max(0, width - segsWidth(right) - 1)
  const left = clipSegs([...bandLabel('▸ terminal', theme), { text: ' ' }, pillSeg(shell, theme.pill.accent2), { text: ' ' }, ...detail], avail)
  const gap = avail - segsWidth(left)
  const middle: Seg[] = gap >= 3 ? [{ text: ' ' }, ...gradientRule(gap - 1, theme.gradient, '━')] : [{ text: ' '.repeat(gap) }]
  return clipSegs([...left, ...middle, { text: ' ' }, ...right], width)
}
