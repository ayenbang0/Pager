import { htmlToText, scrub } from './html.js'
import { isPrivateHost } from './host.js'

export const MAX_BODY_BYTES = 1024 * 1024
const READ_TIMEOUT_MS = 10_000

export interface WebOptions {
  fetch?: typeof fetch
}

/** Reads at most `max` bytes of a response body, stopping the download once the cap is reached. */
export async function readCapped(res: Response, max = MAX_BODY_BYTES): Promise<string> {
  if (res.body === null) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (total + value.length > max) {
        chunks.push(value.subarray(0, max - total))
        total = max
        break
      }
      chunks.push(value)
      total += value.length
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks))
}

/** The title and readable text of a web page. Refuses private-network addresses and anything that is not text. */
export async function readPage(url: string, opts: WebOptions = {}): Promise<{ title: string; text: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Not a valid address')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http and https pages can be read')
  if (isPrivateHost(parsed.hostname)) throw new Error('Refusing to read a private-network address')
  const res = await (opts.fetch ?? fetch)(parsed, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), headers: { accept: 'text/html,text/plain;q=0.9', 'accept-language': 'en' } })
  // A redirect may lead somewhere private; the final address is checked too.
  if (res.url !== '' && isPrivateHost(new URL(res.url).hostname)) throw new Error('Refusing to read a private-network address')
  if (!res.ok) throw new Error(`The page answered ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  if (!/^text\/(html|plain)/i.test(type)) throw new Error(`Not a text page (${type === '' ? 'unknown type' : type.split(';')[0]})`)
  const body = await readCapped(res)
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]
  return { title: scrub(htmlToText(title ?? '')).trim(), text: /^text\/plain/i.test(type) ? htmlToText(body.replace(/</g, '&lt;')) : htmlToText(body) }
}
