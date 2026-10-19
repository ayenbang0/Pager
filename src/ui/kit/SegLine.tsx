import { Text } from 'ink'
import type { Seg } from './segs.js'

/** One row of styled segs. Callers clip or fit them to the width first, so `wrap="truncate"` is only a safety net. */
export function SegLine({ segs }: { segs: readonly Seg[] }) {
  return (
    <Text wrap="truncate-end">
      {segs.map((s, i) => (
        <Text key={i} color={s.color} backgroundColor={s.bg} bold={s.bold} dimColor={s.dim} italic={s.italic} inverse={s.inverse}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}
