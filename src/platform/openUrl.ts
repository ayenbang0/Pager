import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

/** Opens `url` in the default browser. Only http and https URLs without whitespace or control characters are accepted. */
export function openUrl(url: string): boolean {
  if (/[\s\p{Cc}]/u.test(url)) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  // PAGER_OPEN_FILE is a test seam like PAGER_COPY_FILE: the URL is appended to that file instead of opening a browser.
  const file = process.env.PAGER_OPEN_FILE
  if (file !== undefined && file !== '') {
    try {
      appendFileSync(file, `${url}\n`)
    } catch {
      return false
    }
    return true
  }
  const [bin, args]: [string, string[]] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}
