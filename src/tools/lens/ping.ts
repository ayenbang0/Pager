import type { LensData, Tone } from './lens.js'

const num = (s: string | undefined): number => Number.parseFloat(s ?? '')

const HOST_FLAGS_WITH_VALUE = new Set(['-c', '-n', '-t', '-w', '-W', '-i', '-s', '-l', '-S', '-I', '-M', '-m', '-p', '-Q', '-q'])

/** Target host: the last argument that is not a flag or a flag's value. */
function target(args: readonly string[]): string {
  let host = ''
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (HOST_FLAGS_WITH_VALUE.has(a)) i++
    else if (!a.startsWith('-')) host = a
  }
  return host
}

/** ping (Unix and Windows): replies, loss and round-trip times. Needs the summary line. */
export function parsePing(args: readonly string[], output: string): LensData | null {
  const times = [...output.matchAll(/time[=<]\s*([\d.]+)\s*ms/gi)].map((m) => num(m[1]))
  let sent: number
  let received: number
  let loss: number
  let min: number | undefined
  let avg: number | undefined
  let max: number | undefined
  const unix = /(\d+) packets transmitted, (\d+) (?:packets )?received.*?([\d.]+)% packet loss/s.exec(output)
  const win = /Sent = (\d+), Received = (\d+), Lost = \d+ \((\d+)% loss\)/.exec(output)
  if (unix !== null) {
    sent = num(unix[1])
    received = num(unix[2])
    loss = num(unix[3])
    const rtt = /(?:rtt|round-trip)[^=]*= ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(output)
    if (rtt !== null) [min, avg, max] = [num(rtt[1]), num(rtt[2]), num(rtt[3])]
  } else if (win !== null) {
    sent = num(win[1])
    received = num(win[2])
    loss = num(win[3])
    const rtt = /Minimum = (\d+)ms, Maximum = (\d+)ms, Average = (\d+)ms/.exec(output)
    if (rtt !== null) [min, max, avg] = [num(rtt[1]), num(rtt[2]), num(rtt[3])]
  } else return null
  if (times.length > 0) {
    min ??= Math.min(...times)
    max ??= Math.max(...times)
    avg ??= times.reduce((a, b) => a + b, 0) / times.length
  }
  const host = /PING (\S+)/.exec(output)?.[1] ?? /Pinging (\S+)/.exec(output)?.[1] ?? target(args)
  const tone: Tone = loss === 0 ? 'good' : loss < 20 ? 'warn' : 'bad'
  const ms = (v: number | undefined): string => (v === undefined ? '-' : `${Math.round(v * 100) / 100} ms`)
  const data: LensData = {
    title: `ping ${host}`,
    badges: [{ text: `${loss}% loss`, tone }],
    kv: [
      ['sent', String(sent)],
      ['received', String(received)],
      ['min', ms(min)],
      ['avg', ms(avg)],
      ['max', ms(max)],
    ],
  }
  if (times.length > 0) data.spark = { label: 'rtt', values: times }
  return data
}
