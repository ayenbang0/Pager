import fs from 'node:fs'
import path from 'node:path'
import { isRecord } from '../../util/guards.js'
import { parseColor } from './colors.js'
import { customTheme, DEFAULT_THEME, setCustomThemes, THEMES, type Theme } from './themes.js'

/** The color tokens a custom theme may set; the rest come from its `base`. */
const TOKENS = ['accent', 'accent2', 'glow', 'border', 'dim', 'text', 'surface', 'success', 'warning', 'error', 'info', 'online', 'badge', 'mine', 'userBubble'] as const
const NAME_RE = /^[a-z][a-z0-9_-]{1,23}$/

export const themesFile = (dir: string): string => path.join(dir, 'themes.json')

/**
 * Reads `<dir>/themes.json` and makes its themes selectable. Each entry: `name`, optional `description`, `base` (a built-in
 * theme to start from, default omp), any color token, `authors` (2+ colors), `gradient` (1-4 colors; one means flat) or
 * `flat: true`. Returns what was wrong (nothing when the file is fine or absent); broken entries are skipped.
 */
export function loadCustomThemes(dir: string): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(themesFile(dir), 'utf8'))
  } catch (err) {
    setCustomThemes([])
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : [`themes.json is not valid JSON: ${(err as Error).message}`]
  }
  const problems: string[] = []
  const themes: Theme[] = []
  for (const e of isRecord(raw) && Array.isArray(raw.themes) ? raw.themes : []) {
    const name = isRecord(e) && typeof e.name === 'string' ? e.name.trim().toLowerCase() : ''
    if (!isRecord(e) || !NAME_RE.test(name) || [...THEMES, ...themes].some((t) => t.name === name)) {
      problems.push(`themes.json: skipped "${name.slice(0, 24)}": a theme needs a new name of 2-24 lowercase letters, digits, - or _`)
      continue
    }
    const base = typeof e.base === 'string' ? THEMES.find((t) => t.name === e.base) : DEFAULT_THEME
    const color = (v: unknown): string | undefined => (typeof v === 'string' ? parseColor(v) : undefined)
    const over: Partial<Record<(typeof TOKENS)[number], string>> & { authors?: string[]; gradient?: string[]; description?: string; name: string } = { name }
    const bad: string[] = base === undefined ? ['base'] : []
    for (const token of TOKENS) {
      if (e[token] === undefined) continue
      const c = color(e[token])
      if (c === undefined) bad.push(token)
      else over[token] = c
    }
    for (const key of ['authors', 'gradient'] as const) {
      if (e[key] === undefined) continue
      const list = Array.isArray(e[key]) ? (e[key] as unknown[]).map(color) : []
      const ok = list.every((c) => c !== undefined) && (key === 'authors' ? list.length >= 2 : list.length >= 1 && list.length <= 4)
      if (!ok) bad.push(key)
      else over[key] = list as string[]
    }
    if (typeof e.description === 'string') over.description = e.description.replace(/\p{Cc}/gu, ' ').slice(0, 80)
    if (bad.length > 0) {
      problems.push(`themes.json: skipped ${name}: bad ${bad.join(', ')}`)
      continue
    }
    const accent = over.accent ?? (base ?? DEFAULT_THEME).accent
    if (e.flat === true) over.gradient = [accent, accent]
    else if (over.gradient?.length === 1) over.gradient = [over.gradient[0] ?? accent, over.gradient[0] ?? accent]
    themes.push(customTheme(base ?? DEFAULT_THEME, { description: `Custom (${(base ?? DEFAULT_THEME).name} base)`, ...over }))
  }
  setCustomThemes(themes)
  return problems
}

/** Writes `from` (every token spelled out, ready to edit) into themes.json as `name`. Returns why it could not, or undefined. */
export function saveCustomTheme(dir: string, name: string, from: Theme): string | undefined {
  if (!NAME_RE.test(name)) return 'A theme name is 2-24 lowercase letters, digits, - or _, starting with a letter'
  let doc: { themes: unknown[] } = { themes: [] }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(themesFile(dir), 'utf8'))
    if (isRecord(raw) && Array.isArray(raw.themes)) doc = { ...raw, themes: raw.themes }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'themes.json is not valid JSON: fix or remove it first'
  }
  if (doc.themes.some((t) => isRecord(t) && t.name === name) || THEMES.some((t) => t.name === name)) return `A theme named ${name} already exists`
  const flat = from.gradient.every((g) => g === from.gradient[0])
  const tokens = Object.fromEntries(TOKENS.map((t) => [t, from[t]]))
  doc.themes.push({ name, description: `My theme (from ${from.name})`, ...tokens, authors: from.authors, ...(flat ? { flat: true } : { gradient: from.gradient }) })
  const tmp = `${themesFile(dir)}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`)
  fs.renameSync(tmp, themesFile(dir))
  return undefined
}
