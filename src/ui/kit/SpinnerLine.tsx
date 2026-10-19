import { Box } from 'ink'
import { SegLine } from './SegLine.js'
import { splitSpinners } from './spinnerCells.js'
import { Spinner } from './Spinner.js'
import type { Seg } from './segs.js'

/** One row of segs where each `SPINNER_CELL` seg is drawn as a live `<Spinner />` in that seg's colors. Callers fit the segs to the width first. */
export function SpinnerLine({ segs }: { segs: readonly Seg[] }) {
  return (
    <Box>
      {splitSpinners(segs).map((part, i) =>
        part.kind === 'spinner' ? <Spinner key={i} color={part.seg.color} bg={part.seg.bg} /> : <SegLine key={i} segs={part.segs} />,
      )}
    </Box>
  )
}
