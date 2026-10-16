import fs from 'node:fs'
import path from 'node:path'

export const HISTORY_MAX = 500

/** Tolerant: a missing, unreadable or malformed file yields an empty history; non-string entries are dropped. */
export function loadHistory(dir: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((h): h is string => typeof h === 'string' && h !== '').slice(-HISTORY_MAX)
}

/** Atomic: written beside the target, then renamed over it. */
export function saveHistory(dir: string, list: readonly string[]): void {
  const file = path.join(dir, 'history.json')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(list.slice(-HISTORY_MAX)) + '\n')
  fs.renameSync(tmp, file)
}
