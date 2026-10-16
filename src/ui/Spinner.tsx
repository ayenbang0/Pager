import { Text, useAnimation } from 'ink'
import { REDUCED_MOTION, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from './motion.js'

/** One braille spinner cell; static `…` under reduced motion. Ink shares one timer across all animations. */
export function Spinner({ color }: { color?: string }) {
  const { frame } = useAnimation({ interval: SPINNER_INTERVAL_MS, isActive: !REDUCED_MOTION })
  return <Text color={color}>{REDUCED_MOTION ? '…' : SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>
}
