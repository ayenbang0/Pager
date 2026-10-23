import { appendFileSync } from 'node:fs'
import net from 'node:net'

/** A URL the browser pane may show: http or https, no whitespace or control characters. */
export function pageUrl(url: string): string | undefined {
  if (/[\s\p{Cc}]/u.test(url)) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** The line the desktop window reads from its pipe. */
const request = (token: string, url: string): string => `${JSON.stringify({ token, type: 'open', url })}\n`

/**
 * Shows `url` in the browser pane of the Pager desktop window; no other browser is ever started. Resolves false when
 * pager does not run inside that window (the caller says where the page is) or the URL is not http(s).
 */
export async function openInApp(url: string): Promise<boolean> {
  if (pageUrl(url) === undefined) return false
  // PAGER_OPEN_FILE is a test seam like PAGER_COPY_FILE: the URL is appended to that file instead of going to the window.
  const file = process.env.PAGER_OPEN_FILE
  if (file !== undefined && file !== '') {
    try {
      appendFileSync(file, `${url}\n`)
    } catch {
      return false
    }
    return true
  }
  const pipe = process.env.PAGER_DESKTOP_PIPE
  const token = process.env.PAGER_DESKTOP_TOKEN
  if (pipe === undefined || pipe === '' || token === undefined || token === '') return false
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const sock = net.connect(pipe)
  let answer = ''
  const done = (ok: boolean): void => {
    sock.destroy()
    resolve(ok)
  }
  sock.setTimeout(3000, () => done(false))
  sock.on('error', () => done(false))
  sock.on('connect', () => sock.write(request(token, url)))
  sock.on('data', (d) => {
    answer += d.toString()
    if (answer.includes('\n')) done(answer.startsWith('ok'))
  })
  sock.on('close', () => done(answer.startsWith('ok')))
  return promise
}
