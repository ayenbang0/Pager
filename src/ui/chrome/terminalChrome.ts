import type { TermInfo } from '../../tools/terminal/sessions.js'
import type { PillKind, Theme } from '../theme/themes.js'
import { bandLabel, clipSegs, gradientRule, pillSeg, segsWidth, type Seg } from '../kit/segs.js'

/** The state pill: unavailable, the shell's exit, running, the latest command's exit code, or idle before any command. */
export function termStatus(t: TermInfo): { text: string; kind: PillKind } {
  if (t.unavailable !== null) return { text: '✗ unavailable', kind: 'error' }
  if (t.exited !== null) return { text: `exit ${t.exited}`, kind: t.exited === 0 ? 'muted' : 'error' }
  if (t.running !== null) return { text: '● running', kind: 'info' }
  if (t.last === null) return { text: 'idle', kind: 'muted' }
  return t.last.exit === 0 ? { text: '✓ exit 0', kind: 'success' } : { text: `✗ exit ${t.last.exit}`, kind: 'error' }
}

/**
 * A Terminal tab's title row, exactly `width` columns: the `▸ terminal` band (numbered after the first tab), the shell as a pill, then the
 * running command (or working directory and window title) on the left; the status pill at the right with a gradient rule between.
 * The status pill outranks the left side.
 */
export function terminalTitle(t: TermInfo, width: number, theme: Theme, n = 1): Seg[] {
  const status = termStatus(t)
  const right: Seg[] = [pillSeg(status.text, theme.pill[status.kind])]
  const where = t.title !== '' && t.title !== t.cwd ? `${t.cwd} · ${t.title}` : t.cwd
  const detail: Seg[] =
    t.running === null ? [{ text: where, color: theme.dim }] : [{ text: '❯ ', color: theme.accent, bold: true }, { text: t.running.command, color: theme.text, bold: true }]
  const avail = Math.max(0, width - segsWidth(right) - 1)
  const shell: Seg[] = t.shell === '' ? [] : [pillSeg(t.shell, theme.pill.accent2), { text: ' ' }]
  const left = clipSegs([...bandLabel(n === 1 ? '▸ terminal' : `▸ terminal ${n}`, theme), { text: ' ' }, ...shell, ...detail], avail)
  const gap = avail - segsWidth(left)
  const middle: Seg[] = gap >= 3 ? [{ text: ' ' }, ...gradientRule(gap - 1, theme.gradient, '━')] : [{ text: ' '.repeat(gap) }]
  return clipSegs([...left, ...middle, { text: ' ' }, ...right], width)
}
