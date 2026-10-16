import { Box, Text } from 'ink'
import wrapAnsi from 'wrap-ansi'
import type { Toast, ToastKind } from '../engine.js'

export interface ToastItem extends Toast {
  id: number
}

export const MAX_VISIBLE_TOASTS = 3
const TOAST_WIDTH = 44
const INNER_WIDTH = TOAST_WIDTH - 4 // border (2) + paddingX (2)
const MAX_LINES = 2

export const TOAST_COLOR: Record<ToastKind, string> = { info: 'cyan', success: 'green', warn: 'yellow', error: 'red' }
export const TOAST_LIFETIME_MS: Record<ToastKind, number> = { info: 5000, success: 5000, warn: 7000, error: 8000 }

function clip(text: string): string {
  const rows = wrapAnsi(text, INNER_WIDTH, { hard: true, trim: false }).split('\n')
  if (rows.length <= MAX_LINES) return rows.join('\n')
  const kept = rows.slice(0, MAX_LINES)
  kept[MAX_LINES - 1] = (kept[MAX_LINES - 1] ?? '').slice(0, INNER_WIDTH - 1) + '…'
  return kept.join('\n')
}

/** Newest on top, at most MAX_VISIBLE_TOASTS. Render as the last child of the root box. */
export function Toasts({ toasts }: { toasts: ToastItem[] }) {
  const visible = toasts.slice(-MAX_VISIBLE_TOASTS).reverse()
  return (
    <Box position="absolute" top={1} right={1} flexDirection="column">
      {visible.map((t) => (
        <Box key={t.id} width={TOAST_WIDTH} borderStyle="round" borderColor={TOAST_COLOR[t.kind]} paddingX={1}>
          <Text>{clip(t.text)}</Text>
        </Box>
      ))}
    </Box>
  )
}
