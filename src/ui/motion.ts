/** Set PAGER_REDUCE_MOTION=1 to turn every animation into a static glyph. */
export const REDUCED_MOTION = process.env.PAGER_REDUCE_MOTION === '1'

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
export const SPINNER_INTERVAL_MS = 80
