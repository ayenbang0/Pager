import { Box, Text, useAnimation, useWindowSize } from 'ink'
import wrapAnsi from 'wrap-ansi'
import type { Toast, ToastKind } from '../../app/engine.js'
import type { Theme } from '../theme/themes.js'
import { REDUCED_MOTION } from '../theme/motion.js'
import { useTheme } from '../theme/theme.js'

export interface ToastItem extends Toast {
  id: number
  /** Date.now() when it appeared; drives the countdown bar. */
  born: number
}

export const MAX_VISIBLE_TOASTS = 3
const TOAST_WIDTH = 44
const MIN_TOAST_WIDTH = 20
/** Border (2) + paddingX (2) + the kind pill and its gap (4). */
const CHROME_COLUMNS = 8
const MAX_LINES = 2
const BAR_INTERVAL_MS = 200

export const TOAST_LIFETIME_MS: Record<ToastKind, number> = { info: 5000, success: 5000, warn: 7000, error: 8000 }

const KIND_ICON: Record<ToastKind, string> = { info: 'ℹ', success: '✓', warn: '⚠', error: '✗' }

function kindColors(theme: Theme, kind: ToastKind): { color: string; pill: { fg: string; bg: string } } {
  const color = { info: theme.info, success: theme.success, warn: theme.warning, error: theme.error }[kind]
  return { color, pill: theme.pill[kind === 'warn' ? 'warning' : kind] }
}

function clip(text: string, inner: number): string[] {
  const rows = wrapAnsi(text, inner, { hard: true, trim: false }).split('\n')
  if (rows.length <= MAX_LINES) return rows
  const kept = rows.slice(0, MAX_LINES)
  kept[MAX_LINES - 1] = `${(kept[MAX_LINES - 1] ?? '').slice(0, inner - 1)}…`
  return kept
}

function ToastCard({ toast, width }: { toast: ToastItem; width: number }) {
  const theme = useTheme()
  // Re-render on a timer; the bar length comes from the wall clock so it never drifts.
  useAnimation({ interval: BAR_INTERVAL_MS, isActive: !REDUCED_MOTION })
  const { color, pill } = kindColors(theme, toast.kind)
  const inner = width - CHROME_COLUMNS
  const left = Math.max(0, 1 - (Date.now() - toast.born) / TOAST_LIFETIME_MS[toast.kind])
  return (
    <Box width={width} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      {clip(toast.text, inner).map((row, i) => (
        <Box key={i}>
          <Text color={pill.fg} backgroundColor={pill.bg} bold>
            {i === 0 ? ` ${KIND_ICON[toast.kind]} ` : '   '}
          </Text>
          <Text color={color}> ▍</Text>
          <Text color={theme.text}>{row}</Text>
        </Box>
      ))}
      {REDUCED_MOTION ? null : <Text color={color}>{'▔'.repeat(Math.ceil(left * (width - 4)))}</Text>}
    </Box>
  )
}

/** Newest on top, at most MAX_VISIBLE_TOASTS. Render as the last child of the root box. */
export function Toasts({ toasts }: { toasts: ToastItem[] }) {
  const { columns } = useWindowSize()
  const width = Math.max(MIN_TOAST_WIDTH, Math.min(TOAST_WIDTH, columns - 2))
  const visible = toasts.slice(-MAX_VISIBLE_TOASTS).reverse()
  return (
    <Box position="absolute" top={1} right={1} flexDirection="column">
      {visible.map((t) => (
        <ToastCard key={t.id} toast={t} width={width} />
      ))}
    </Box>
  )
}
