import stringWidth from 'string-width'
import { readableOn } from '../theme/colors.js'
import type { Theme } from '../theme/themes.js'
import type { PromptChip } from '../chrome/chrome.js'
import { clipSegs, fitSegs, segsWidth, spread, type Seg } from '../kit/segs.js'
import { cardBottom, cardTop, raisedFill } from '../kit/tern.js'

/** Rows the composer card takes: the top edge, the text row, the chip row and the bottom edge. */
export const COMPOSER_ROWS = 4

/** A quiet chip after the recipient: the agent's model, or the folder it works in. */
export interface ComposerExtra {
  text: string
  kind: 'model' | 'cwd'
}

export interface ComposerInput {
  /** Columns of the whole card. */
  width: number
  /** Who the message goes to (or that it is a command). */
  chip: PromptChip
  extras: readonly ComposerExtra[]
  /** Contextual keys on the right of the bottom edge. */
  hint: string
  /** The prompt has the keyboard: the card's edge turns accent. */
  active: boolean
  /** There is text to send: the send chip is lit. */
  typed: boolean
}

export interface ComposerRows {
  top: Seg[]
  /** The chip row's content, `width - 4` columns: the card's sides and padding are drawn around it. */
  chips: Seg[]
  bottom: Seg[]
}

/** `cwd` for a chip: your home folder as `~`, forward slashes, and the tail kept (`…/Products/pager`) when it exceeds `max` columns. */
export function cwdLabel(cwd: string, home: string, max: number): string {
  const flat = cwd.replaceAll('\\', '/')
  const h = home.replaceAll('\\', '/').replace(/\/$/, '')
  const shown = h !== '' && (flat === h || flat.startsWith(`${h}/`)) ? `~${flat.slice(h.length)}` : flat
  if (stringWidth(shown) <= max) return shown
  if (max <= 1) return max === 1 ? '…' : ''
  let tail = ''
  for (const ch of [...shown].reverse()) {
    if (stringWidth(tail) + stringWidth(ch) > max - 1) break
    tail = ch + tail
  }
  return `…${tail}`
}

/**
 * The composer as a Tern card: a rounded hairline that turns accent while the prompt has focus, the text row, and a chip row with
 * the recipient chip, the model and folder chips and the send affordance at the right. Narrow cards drop the folder, then the model.
 */
export function composerRows(i: ComposerInput, theme: Theme): ComposerRows {
  const inner = Math.max(0, i.width - 4)
  const fill = raisedFill(theme)
  const to = i.chip.color === undefined ? theme.pill.accent : { fg: readableOn(i.chip.color), bg: i.chip.color }
  const recipient: Seg = { text: ` ${i.chip.text} `, color: to.fg, bg: to.bg, bold: true }
  const extra = (e: ComposerExtra): Seg[] => [{ text: ' ' }, { text: ` ${e.text} `, color: e.kind === 'model' ? theme.accent : theme.dim, bg: fill }]
  const send: Seg = i.typed ? { text: ' ⏎ send ', color: theme.pill.accent.fg, bg: theme.pill.accent.bg, bold: true } : { text: ' ⏎ ', color: theme.dim }
  // The recipient with every chip, then with the last one fewer, down to the recipient alone.
  const options = Array.from({ length: i.extras.length + 1 }, (_, n): Seg[] => [recipient, ...i.extras.slice(0, i.extras.length - n).flatMap(extra)])
  const left = options.find((l) => segsWidth(l) + 1 + segsWidth([send]) <= inner)
  const chips = left === undefined ? clipSegs([recipient], inner) : spread(left, [send], inner)
  const hintRoom = i.width - 8
  const hint = i.hint === '' || hintRoom < 4 ? [] : [{ text: stringWidth(i.hint) > hintRoom ? `${clipSegs([{ text: i.hint }], hintRoom - 1)[0]?.text ?? ''}…` : i.hint, color: theme.dim }]
  return {
    top: cardTop(i.width, theme, { focused: i.active }),
    chips,
    bottom: cardBottom(i.width, theme, { right: hint, focused: i.active }),
  }
}

/** A completion row above the card: the command bold, its summary dim; the chosen row sits on the soft raised fill with an accent command. */
export function menuRow(item: { label: string; summary: string }, chosen: boolean, width: number, theme: Theme): Seg[] {
  const fill = chosen ? { bg: raisedFill(theme) } : {}
  const row: Seg[] = [
    { ...fill, text: ' ' },
    { ...fill, text: item.label, color: chosen ? theme.accent : theme.text, bold: true },
    { ...fill, text: item.summary === '' ? '' : '  ' + item.summary, color: theme.dim },
  ]
  return fitSegs(row, width, fill)
}
