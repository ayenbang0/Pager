// `pager serve [--port N] [--host H] [--read-only] [--tls-cert F --tls-key F] [--allow-host NAME]... | --stop | --status`

export const DEFAULT_PORT = 8377
export const DEFAULT_HOST = '127.0.0.1'

export interface ServeArgs {
  verb: 'serve'
  action: 'run' | 'stop' | 'status'
  port: number
  host: string
  readOnly: boolean
  tlsCert?: string
  tlsKey?: string
  allowHosts: string[]
}

const HOSTNAME = /^[A-Za-z0-9._:\-[\]]+$/

export function parseServeArgs(argv: string[]): ServeArgs | { error: string } {
  const out: ServeArgs = { verb: 'serve', action: 'run', port: DEFAULT_PORT, host: DEFAULT_HOST, readOnly: false, allowHosts: [] }
  const given = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const value = (): string | undefined => argv[++i]
    given.add(a)
    switch (a) {
      case '--stop':
        out.action = 'stop'
        break
      case '--status':
        out.action = 'status'
        break
      case '--read-only':
        out.readOnly = true
        break
      case '--port': {
        const v = value()
        const n = v === undefined || !/^\d{1,5}$/.test(v) ? NaN : Number(v)
        if (!(n >= 0 && n <= 65535)) return { error: '--port needs a number from 0 to 65535' }
        out.port = n
        break
      }
      case '--host': {
        const v = value()
        if (v === undefined || !HOSTNAME.test(v)) return { error: '--host needs an address such as 127.0.0.1 or 0.0.0.0' }
        out.host = v
        break
      }
      case '--allow-host': {
        const v = value()
        if (v === undefined || !HOSTNAME.test(v)) return { error: '--allow-host needs a host name' }
        out.allowHosts.push(v)
        break
      }
      case '--tls-cert': {
        const v = value()
        if (v === undefined) return { error: '--tls-cert needs a PEM file' }
        out.tlsCert = v
        break
      }
      case '--tls-key': {
        const v = value()
        if (v === undefined) return { error: '--tls-key needs a PEM file' }
        out.tlsKey = v
        break
      }
      default:
        return { error: `pager serve does not take ${a}` }
    }
  }
  if (given.has('--stop') && given.has('--status')) return { error: 'pager serve takes --stop or --status, not both' }
  if (out.action !== 'run' && given.size > 1) return { error: `pager serve --${out.action} takes no other arguments` }
  if ((out.tlsCert === undefined) !== (out.tlsKey === undefined)) return { error: '--tls-cert and --tls-key go together' }
  return out
}
