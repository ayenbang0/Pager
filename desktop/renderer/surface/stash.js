// "Open in a pane" hands a surface block to a block pane. The payload (up to 1 MB) must not travel through the daemon's
// layout (a pane's `command` is stored and replayed), so the pane gets only a key into this window-local stash.
const MAX_STASH = 24
const stash = new Map()
let seq = 0

export function stashSurface(msg) {
  const key = `s${Date.now().toString(36)}${(++seq).toString(36)}`
  stash.set(key, msg)
  while (stash.size > MAX_STASH) stash.delete(stash.keys().next().value)
  return key
}

export const takeSurface = (key) => stash.get(key) || null
