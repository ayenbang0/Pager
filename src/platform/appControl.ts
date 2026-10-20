const BLOCKED = /Application Control policy has blocked this file\.?\s*(\S.*)$/m
const MAX_DEPTH = 3

/** The file Windows Smart App Control / App Control refused to load, when `err` (or one of its causes) says so. */
export function blockedFile(err: unknown): string | undefined {
  let e: unknown = err
  for (let depth = 0; depth <= MAX_DEPTH && e instanceof Error; depth++) {
    const m = BLOCKED.exec(e.message)
    if (m?.[1] !== undefined) return m[1].trim().replace(/^\\\\\?\\/, '')
    e = e.cause
  }
  return undefined
}

/** A start-up failure as one line for the terminal; a blocked native file is named and explained. */
export function startError(err: unknown): string {
  const file = blockedFile(err)
  if (file !== undefined) {
    return `Windows Smart App Control blocked ${file}. It blocks unsigned native files it does not trust; this file needs a signature or an exception.`
  }
  return err instanceof Error ? err.message : String(err)
}
