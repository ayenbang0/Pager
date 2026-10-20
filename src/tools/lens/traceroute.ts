import type { LensData } from './lens.js'

interface Hop {
  n: number
  host: string
  ms: number | undefined
}

const TIME = /(<?)(\d+(?:\.\d+)?)\s*ms/g
/** Windows lines start with the probe times; Unix lines start with the host. */
const STARTS_WITH_TIME = /^(?:<?\d+(?:\.\d+)?\s*ms|\*)/

/** Unix: ` 1  host (ip)  1.2 ms  1.1 ms`, ` 2  * * *`. Windows: `  1    <1 ms    <1 ms    <1 ms  host [ip]`, `Request timed out.`. */
function parseHop(line: string): Hop | null {
  const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line)
  if (m === null) return null
  const n = Number.parseInt(m[1] ?? '', 10)
  const rest = m[2] ?? ''
  const times = [...rest.matchAll(TIME)].map((t) => (t[1] === '<' ? 0.5 : Number.parseFloat(t[2] ?? '')))
  if (times.length === 0) return /^(\*\s*)+$|timed out/i.test(rest) ? { n, host: '*', ms: undefined } : null
  const ms = times.reduce((a, b) => a + b, 0) / times.length
  const host = STARTS_WITH_TIME.test(rest) ? rest.replace(TIME, '').replaceAll('*', '').replace(/\s+/g, ' ').trim() : rest.slice(0, rest.search(/\s<?\d+(?:\.\d+)?\s*ms/)).trim()
  return { n, host: host === '' ? '*' : host, ms }
}

/** traceroute / tracert: one row per hop with the mean round trip. Needs at least two hop lines. */
export function parseTraceroute(args: readonly string[], output: string): LensData | null {
  const hops = output.split('\n').map(parseHop).filter((h): h is Hop => h !== null)
  if (hops.length < 2) return null
  const target = args.findLast((a) => !a.startsWith('-')) ?? ''
  const last = hops[hops.length - 1]
  const reached = last !== undefined && last.ms !== undefined && target !== '' && last.host.includes(target)
  return {
    title: `traceroute ${target}`.trimEnd(),
    badges: [{ text: reached ? 'reached' : 'incomplete', tone: reached ? 'good' : 'warn' }],
    kv: [['hops', String(hops.length)]],
    table: { head: ['hop', 'host', 'avg ms'], rows: hops.map((h) => [String(h.n), h.host, h.ms === undefined ? '*' : String(Math.round(h.ms * 10) / 10)]), right: [0, 2] },
  }
}
