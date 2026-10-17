import { Text, useAnimation } from 'ink'
import { REDUCED_MOTION, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from './motion.js'
import { useTheme } from './theme.js'

const BLINK_INTERVAL_MS = 500

/**
 * One spinner cell: a rotating braille dot whose color pulses between the accent and its glow (static `…` under reduced motion).
 * Pass `color` to pin one color; `bg` when it sits on a band or pill. Ink shares one timer across all animations.
 */
export function Spinner({ color, bg }: { color?: string; bg?: string }) {
  const theme = useTheme()
  const { frame } = useAnimation({ interval: SPINNER_INTERVAL_MS, isActive: !REDUCED_MOTION })
  const tint = color ?? (Math.floor(frame / 4) % 2 === 0 ? theme.accent : theme.glow)
  return (
    <Text color={tint} backgroundColor={bg} bold>
      {REDUCED_MOTION ? '…' : SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}
    </Text>
  )
}

/** True on every other half second, for a `?` that asks for attention. Always true under reduced motion. */
export function useBlink(): boolean {
  const { frame } = useAnimation({ interval: BLINK_INTERVAL_MS, isActive: !REDUCED_MOTION })
  return REDUCED_MOTION || frame % 2 === 0
}

/** The current spinner glyph, for surfaces that build their row as segs (static `…` under reduced motion). */
export function useSpinnerGlyph(): string {
  const { frame } = useAnimation({ interval: SPINNER_INTERVAL_MS, isActive: !REDUCED_MOTION })
  return REDUCED_MOTION ? '…' : (SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '…')
}
