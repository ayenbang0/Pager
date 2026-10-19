/** True for hosts a web tool must not touch: loopback, link-local, private ranges and `.local` names. */
export function isPrivateHost(raw: string): boolean {
  let host = raw.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  host = host.replace(/\.$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4 !== null) return privateV4(v4.slice(1).map(Number) as [number, number, number, number])
  if (host.includes(':')) return privateV6(host)
  return false
}

function privateV4([a, b]: [number, number, number, number]): boolean {
  return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

function privateV6(host: string): boolean {
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
  if (mapped !== null) return isPrivateHost(mapped[1] ?? '')
  if (host === '::1' || host === '::') return true
  const first = host.split(':')[0] ?? ''
  const head = Number.parseInt(first === '' ? '0' : first, 16)
  if (Number.isNaN(head)) return false
  // fc00::/7 (unique local) and fe80::/10 (link local)
  return (head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80
}
