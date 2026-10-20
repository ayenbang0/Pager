import { fitSegs, bandLabel, pillSeg, segsWidth, type Seg } from '../../ui/kit/segs.js'
import type { Theme } from '../../ui/theme/themes.js'
import { parseCurl } from './curl.js'
import { parseDig } from './dig.js'
import { parsePing } from './ping.js'
import { parseTraceroute } from './traceroute.js'

export type Tone = 'good' | 'warn' | 'bad' | 'muted'

export interface LensData {
  title: string
  badges: { text: string; tone: Tone }[]
  kv: [string, string][]
  table?: { head: string[]; rows: string[][]; /** Column indexes drawn right-aligned. */ right?: number[] }
  spark?: { label: string; values: number[] }
}

type Parser = (words: readonly string[], output: string) => LensData | null

const PARSERS: Readonly<Record<string, Parser>> = {
  ping: parsePing,
  dig: parseDig,
  curl: parseCurl,
  traceroute: parseTraceroute,
  tracert: parseTraceroute,
}

/** The program a simple command line runs, with its arguments; null for pipes, chains, redirects and anything else compound. */
export function programOf(command: string): { name: string; args: string[] } | null {
  if (/[|&;>]/.test(command)) return null
  const words = command.trim().split(/\s+/)
  while (words[0] !== undefined && (words[0] === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift()
  const first = words.shift()
  if (first === undefined || first === '') return null
  const name = (first.split(/[\\/]/).pop() ?? first).replace(/\.exe$/i, '').toLowerCase()
  return { name, args: words }
}

/** Structured view of a finished command's output, or null when the command or its output is not recognised (the raw output stays). */
export function lensFor(command: string, output: string): LensData | null {
  const prog = programOf(command)
  const parse = prog === null ? undefined : PARSERS[prog.name]
  if (prog === null || parse === undefined) return null
  try {
    return parse(prog.args, output.replaceAll('\r', ''))
  } catch {
    return null
  }
}

const SPARK = '▁▂▃▄▅▆▇█'

/** One bar glyph per value, scaled between the smallest and the largest. */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return ''
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  return values.map((v) => SPARK[hi === lo ? 0 : Math.round(((v - lo) / (hi - lo)) * (SPARK.length - 1))] ?? '▁').join('')
}

const pillOf = (tone: Tone, theme: Theme) => (tone === 'good' ? theme.pill.success : tone === 'warn' ? theme.pill.warning : tone === 'bad' ? theme.pill.error : theme.pill.muted)

/** A small fixed layout: title band with badges, key/value rows, a table, a sparkline. Every row is exactly `width` columns. */
export function renderLens(data: LensData, width: number, theme: Theme): Seg[][] {
  const rows: Seg[][] = []
  const head: Seg[] = [...bandLabel(data.title, theme)]
  for (const b of data.badges) head.push({ text: ' ' }, pillSeg(b.text, pillOf(b.tone, theme)))
  rows.push(fitSegs(head, width))
  const keyWidth = Math.max(0, ...data.kv.map(([k]) => k.length))
  for (const [k, v] of data.kv) rows.push(fitSegs([{ text: `  ${k.padEnd(keyWidth)}  `, color: theme.dim }, { text: v, color: theme.text }], width))
  if (data.table !== undefined) {
    const { head: cols, rows: body, right = [] } = data.table
    const widths = cols.map((c, i) => Math.max(c.length, ...body.map((r) => (r[i] ?? '').length)))
    const cell = (text: string, i: number): string => (right.includes(i) ? text.padStart(widths[i] ?? 0) : text.padEnd(widths[i] ?? 0))
    rows.push(fitSegs([{ text: `  ${cols.map(cell).join('  ')}`, color: theme.dim, bold: true }], width))
    for (const r of body) rows.push(fitSegs([{ text: `  ${cols.map((_, i) => cell(r[i] ?? '', i)).join('  ')}`, color: theme.text }], width))
  }
  if (data.spark !== undefined) {
    const label = `  ${data.spark.label}  `
    rows.push(fitSegs([{ text: label, color: theme.dim }, { text: sparkline(data.spark.values), color: theme.accent }], width))
  }
  return rows.map((r) => (segsWidth(r) === width ? r : fitSegs(r, width)))
}
