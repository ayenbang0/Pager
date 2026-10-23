import { VERSION } from '../../app/version.js'
import { htmlToText, scrub } from './html.js'
import { readCapped, type WebOptions } from './read.js'

export interface WebResult {
  title: string
  url: string
  snippet: string
}

const SEARCH_TIMEOUT_MS = 8000
const MAX_RESULTS = 10

/** Result links are `//duckduckgo.com/l/?uddg=<encoded target>` redirects: the target, when it is an http(s) URL. */
export function unwrapLink(href: string): string | undefined {
  const decoded = href.replace(/&amp;/g, '&')
  let url: URL
  try {
    url = new URL(decoded, 'https://duckduckgo.com')
  } catch {
    return undefined
  }
  const target = url.hostname.endsWith('duckduckgo.com') && url.pathname.startsWith('/l/') ? url.searchParams.get('uddg') : url.href
  if (target === null) return undefined
  try {
    const t = new URL(target)
    return t.protocol === 'http:' || t.protocol === 'https:' ? t.href : undefined
  } catch {
    return undefined
  }
}

const LINK = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi

/** Pulls the results out of DuckDuckGo's HTML page: each `result__a` link is a title, the `result__snippet` after it its summary. */
export function parseResults(html: string): WebResult[] {
  const results: WebResult[] = []
  let current: WebResult | undefined
  for (const m of html.matchAll(LINK)) {
    const attrs = m[1] ?? ''
    const cls = /\bclass="([^"]*)"/.exec(attrs)?.[1] ?? ''
    if (/\bresult__a\b/.test(cls)) {
      const href = /\bhref="([^"]*)"/.exec(attrs)?.[1]
      const url = href === undefined ? undefined : unwrapLink(href)
      current = undefined
      if (url === undefined) continue
      current = { title: scrub(htmlToText(m[2] ?? '')).trim(), url, snippet: '' }
      results.push(current)
    } else if (/\bresult__snippet\b/.test(cls) && current !== undefined && current.snippet === '') {
      current.snippet = scrub(htmlToText(m[2] ?? '')).replace(/\s+/g, ' ').trim()
    }
  }
  return results.filter((r) => r.title !== '').slice(0, MAX_RESULTS)
}

/** A page DuckDuckGo shows when it suspects a robot (HTTP 202 or an "anomaly" notice). */
export const blocked = (status: number, body: string): boolean => status === 202 || /anomaly/i.test(body)

export async function searchWeb(query: string, opts: WebOptions = {}): Promise<WebResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await (opts.fetch ?? fetch)(url, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'user-agent': `Mozilla/5.0 (compatible; pager-cli/${VERSION})`, 'accept-language': 'en' },
  })
  const body = await readCapped(res)
  if (blocked(res.status, body)) throw new Error('DuckDuckGo blocked this request; try again later')
  if (!res.ok) throw new Error(`search answered ${res.status}`)
  return parseResults(body)
}

/** Numbered result blocks: `1. Title`, the address, then the snippet. */
export function formatResults(results: readonly WebResult[]): string[] {
  return results.flatMap((r, i) => [`${i + 1}. ${r.title}`, `   ${r.url}`, ...(r.snippet === '' ? [] : [`   ${r.snippet}`])])
}
