import type { LensData } from './lens.js'

/** dig: status, server, query time and the answer records. Needs the header's `status:` field. */
export function parseDig(args: readonly string[], output: string): LensData | null {
  const status = /;; ->>HEADER<<-.*?status: (\w+)/.exec(output)?.[1]
  if (status === undefined) return null
  const name = args.find((a) => !a.startsWith('-') && !a.startsWith('+') && !a.startsWith('@')) ?? ''
  const kv: [string, string][] = []
  const server = /;; SERVER: (\S+)/.exec(output)?.[1]
  const query = /;; Query time: (\d+) msec/.exec(output)?.[1]
  if (server !== undefined) kv.push(['server', server])
  if (query !== undefined) kv.push(['query time', `${query} ms`])
  const rows: string[][] = []
  const lines = output.split('\n')
  const at = lines.findIndex((l) => l.startsWith(';; ANSWER SECTION:'))
  if (at >= 0) {
    for (const line of lines.slice(at + 1)) {
      if (line.trim() === '') break
      const m = /^(\S+)\s+(\d+)\s+IN\s+(\S+)\s+(.*)$/.exec(line)
      if (m !== null) rows.push([m[1] ?? '', m[2] ?? '', m[3] ?? '', (m[4] ?? '').trim()])
    }
  }
  const data: LensData = { title: `dig ${name}`.trimEnd(), badges: [{ text: status, tone: status === 'NOERROR' ? 'good' : 'bad' }], kv }
  if (rows.length > 0) data.table = { head: ['name', 'ttl', 'type', 'value'], rows, right: [1] }
  return data
}
