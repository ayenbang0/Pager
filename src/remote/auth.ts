import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import os from 'node:os'

export const COOKIE = 'pager_session'
export const SESSION_TTL_S = 12 * 60 * 60

const sha = (s: string): Buffer => createHash('sha256').update(s).digest()

/** Compares two secrets in constant time (their digests, so the lengths never show). */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(sha(a), sha(b))
}

export const newToken = (): string => randomBytes(32).toString('base64url')

export function cookieValue(header: string | undefined, name = COOKIE): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

export function sessionCookie(id: string, secure: boolean): string {
  return `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_S}${secure ? '; Secure' : ''}`
}

export const clearedCookie = (secure: boolean): string => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`

/** The browser sessions this run has handed out: a random id in a cookie, kept only as its digest. */
export class Sessions {
  private readonly byDigest = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly max = 64,
  ) {}

  create(): string {
    const id = randomBytes(32).toString('base64url')
    this.sweep()
    while (this.byDigest.size >= this.max) this.byDigest.delete(this.byDigest.keys().next().value as string)
    this.byDigest.set(sha(id).toString('hex'), this.now() + SESSION_TTL_S * 1000)
    return id
  }

  valid(id: string | undefined): boolean {
    if (id === undefined || id.length === 0 || id.length > 128) return false
    const key = sha(id).toString('hex')
    const until = this.byDigest.get(key)
    if (until === undefined) return false
    if (until <= this.now()) {
      this.byDigest.delete(key)
      return false
    }
    return true
  }

  revoke(id: string | undefined): void {
    if (id !== undefined) this.byDigest.delete(sha(id).toString('hex'))
  }

  get size(): number {
    return this.byDigest.size
  }

  private sweep(): void {
    const t = this.now()
    for (const [k, until] of this.byDigest) if (until <= t) this.byDigest.delete(k)
  }
}

interface Bucket {
  fails: number
  since: number
  lockedUntil: number
}

/**
 * Failed-authentication limiter: `max` failures inside `windowMs` lock the key out for `lockMs`. One instance counts per remote
 * address, another counts everyone together, so spreading guesses over many addresses does not help either.
 */
export class FailLimiter {
  private readonly rec = new Map<string, Bucket>()

  constructor(
    private readonly max = 5,
    private readonly windowMs = 60_000,
    private readonly lockMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds to wait, or 0 when the key may try. */
  retryAfter(key: string): number {
    const r = this.rec.get(key)
    if (r === undefined) return 0
    const t = this.now()
    if (r.lockedUntil > t) return Math.ceil((r.lockedUntil - t) / 1000)
    if (t - r.since > this.windowMs) this.rec.delete(key)
    return 0
  }

  fail(key: string): void {
    const t = this.now()
    let r = this.rec.get(key)
    if (r === undefined || (r.lockedUntil <= t && t - r.since > this.windowMs)) {
      if (this.rec.size >= 4096) this.rec.delete(this.rec.keys().next().value as string)
      r = { fails: 0, since: t, lockedUntil: 0 }
      this.rec.set(key, r)
    }
    r.fails++
    if (r.fails >= this.max) {
      r.lockedUntil = t + this.lockMs
      r.fails = 0
      r.since = t
    }
  }
}

const bracket = (h: string): string => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h)

export const isWildcard = (host: string): boolean => host === '0.0.0.0' || host === '::' || host === '[::]'
export const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'

/** Addresses of this machine's interfaces (what a LAN client would type), IPv4 first. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal && !a.address.startsWith('fe80:')) out.push(a.address)
  }
  return out.sort((x, y) => Number(x.includes(':')) - Number(y.includes(':')))
}

/**
 * The `Host` header values this server answers to. Anything else (a DNS name an attacker points at 127.0.0.1) is refused: that is
 * the defence against DNS rebinding. `extra` names (a reverse proxy's, a tailnet name) match whatever port they carry.
 */
export class HostPolicy {
  private readonly exact = new Set<string>()
  private readonly names = new Set<string>()

  constructor(bindHost: string, port: number, extra: readonly string[] = [], machine: { hostname: string; addresses: readonly string[] } = { hostname: os.hostname(), addresses: lanAddresses() }) {
    const add = (h: string): void => void this.exact.add(`${bracket(h).toLowerCase()}:${port}`)
    for (const h of ['localhost', '127.0.0.1', '::1']) add(h)
    if (isWildcard(bindHost)) {
      for (const a of machine.addresses) add(a)
      add(machine.hostname)
      add(`${machine.hostname}.local`)
    } else if (!isLoopback(bindHost)) add(bindHost)
    for (const e of extra) this.names.add(bracket(e).toLowerCase())
  }

  allows(host: string | undefined): boolean {
    if (host === undefined) return false
    const h = host.toLowerCase()
    if (this.exact.has(h)) return true
    const colon = h.lastIndexOf(':')
    const name = colon > 0 && !h.endsWith(']') ? h.slice(0, colon) : h
    return this.names.has(name)
  }
}

/** A browser's `Origin` is acceptable only when it is this very site: the scheme is http(s) and its host:port is the `Host` the request used. */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || host === undefined) return false
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.toLowerCase() === host.toLowerCase() && u.pathname === '/' && u.username === '' && u.password === ''
}
