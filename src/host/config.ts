import fs from 'node:fs'

export type Material = 'glass' | 'mica' | 'solid'

/** What the own-window host remembers between runs (`desktop.json` in its user data folder). */
export interface HostConfig {
  material: Material
  /** Percent of the window background that covers the desktop behind it (Tern's default is 60). */
  opacity: number
  /** Font size in px. */
  fontSize: number
}

export const DEFAULT_CONFIG: HostConfig = { material: 'glass', opacity: 55, fontSize: 14 }

const MATERIALS: readonly Material[] = ['glass', 'mica', 'solid']
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)))
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

export function loadConfig(file: string): HostConfig {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    material: MATERIALS.find((m) => m === o.material) ?? DEFAULT_CONFIG.material,
    opacity: clamp(num(o.opacity, DEFAULT_CONFIG.opacity), 10, 100),
    fontSize: clamp(num(o.fontSize, DEFAULT_CONFIG.fontSize), 10, 28),
  }
}

export function saveConfig(file: string, c: HostConfig): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

export const nextMaterial = (m: Material): Material => MATERIALS[(MATERIALS.indexOf(m) + 1) % MATERIALS.length]!

export const stepOpacity = (opacity: number, delta: number): number => clamp(opacity + delta, 10, 100)

export const stepFont = (size: number, delta: number): number => clamp(size + delta, 10, 28)
