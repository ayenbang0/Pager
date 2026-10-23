/** Set PAGER_REDUCE_MOTION=1 to turn every animation into a static glyph. */
export const REDUCED_MOTION = process.env.PAGER_REDUCE_MOTION === '1'

/** The standard braille dots spinner (the same ten frames as the window title), one column wide per frame. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
export const SPINNER_INTERVAL_MS = 80
