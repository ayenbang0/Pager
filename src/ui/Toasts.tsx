import { Box, Text, useAnimation } from 'ink'
import wrapAnsi from 'wrap-ansi'
import type { Toast, ToastKind } from '../engine.js'
import type { Theme } from '../themes.js'
import { REDUCED_MOTION } from './motion.js'
import { useTheme } from './theme.js'

export interface ToastItem extends Toast {
  id: number
  /** Date.now() when it appeared; drives the countdown bar. */
  born: number
}

export const MAX_VISIBLE_TOASTS = 3
const TOAST_WIDTH = 44
const INNER_WIDTH = TOAST_WIDTH - 4 // border (2) + paddingX (2)
const MAX_LINES = 2
const BAR_INTERVAL_MS = 200

export const TOAST_LIFETIME_MS: Record<ToastKind, number> = { info: 5000, success: 5000, warn: 7000, error: 8000 }

function toastColor(theme: Theme, kind: ToastKind): string {
  return { info: theme.info, success: theme.success, warn: theme.warning, error: theme.error }[kind]
}

function clip(text: string): string {
  const rows = wrapAnsi(text, INNER_WIDTH, { hard: true, trim: false }).split('\n')
  if (rows.length <= MAX_LINES) return rows.join('\n')
  const kept = rows.slice(0, MAX_LINES)
  kept[MAX_LINES - 1] = (kept[MAX_LINES - 1] ?? '').slice(0, INNER_WIDTH - 1) + '…'
  return kept.join('\n')
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const theme = useTheme()
  // Re-render on a timer; the bar length comes from the wall clock so it never drifts.
  useAnimation({ interval: BAR_INTERVAL_MS, isActive: !REDUCED_MOTION })
  const color = toastColor(theme, toast.kind)
  const left = Math.max(0, 1 - (Date.now() - toast.born) / TOAST_LIFETIME_MS[toast.kind])
  return (
    <Box width={TOAST_WIDTH} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text>{clip(toast.text)}</Text>
      {REDUCED_MOTION ? null : (
        <Text color={color} dimColor>
          {'▔'.repeat(Math.ceil(left * INNER_WIDTH))}
        </Text>
      )}
    </Box>
  )
}

/** Newest on top, at most MAX_VISIBLE_TOASTS. Render as the last child of the root box. */
export function Toasts({ toasts }: { toasts: ToastItem[] }) {
  const visible = toasts.slice(-MAX_VISIBLE_TOASTS).reverse()
  return (
    <Box position="absolute" top={1} right={1} flexDirection="column">
      {visible.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </Box>
  )
}
