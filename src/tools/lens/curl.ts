import type { LensData } from './lens.js'

/** Only commands that print response headers have anything to show. */
const SHOWS_HEADERS = /^(--include|--head|--verbose|-[A-Za-z]*[iIv][A-Za-z]*)$/

const SUMMARY = ['content-type', 'content-length', 'server', 'location']

/** curl -i/-I/-v: the first HTTP status line and its headers. Needs a status line. */
export function parseCurl(args: readonly string[], output: string): LensData | null {
  if (!args.some((a) => SHOWS_HEADERS.test(a))) return null
  const lines = output.split('\n').map((l) => l.replace(/^< /, ''))
  const at = lines.findIndex((l) => /^HTTP\/[\d.]+ \d{3}/.test(l))
  if (at < 0) return null
  const m = /^HTTP\/[\d.]+ (\d{3})\s*(.*)$/.exec(lines[at] ?? '')
  const code = Number.parseInt(m?.[1] ?? '', 10)
  const headers: string[][] = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') break
    const h = /^([^:\s]+):\s*(.*)$/.exec(line)
    if (h !== null) headers.push([h[1] ?? '', (h[2] ?? '').trim()])
  }
  const url = args.findLast((a) => /^https?:\/\//.test(a)) ?? args.findLast((a) => !a.startsWith('-')) ?? ''
  const kv: [string, string][] = []
  for (const key of SUMMARY) {
    const found = headers.find((h) => h[0]?.toLowerCase() === key)
    if (found !== undefined) kv.push([key, found[1] ?? ''])
  }
  const data: LensData = {
    title: `curl ${url}`.trimEnd(),
    badges: [{ text: `${code} ${m?.[2] ?? ''}`.trim(), tone: code < 300 ? 'good' : code < 400 ? 'warn' : 'bad' }],
    kv,
  }
  if (headers.length > 0) data.table = { head: ['header', 'value'], rows: headers }
  return data
}
