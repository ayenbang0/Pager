import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const MAX_OSC52_BYTES = 100_000

function pipeTo(bin: string, args: string[], data: Buffer): void {
  try {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.on('error', () => undefined)
    child.stdin.on('error', () => undefined)
    child.stdin.end(data)
  } catch {
    // No clipboard tool: the OSC 52 sequence is the only route.
  }
}

/**
 * Copy to the system clipboard: OSC 52 (works over SSH and in most modern terminals) plus the platform tool when there is one.
 * PAGER_COPY_FILE (a test seam, like PAGER_ACP_LOG) appends the text to that file instead and touches neither.
 */
export function copyText(text: string): void {
  const file = process.env.PAGER_COPY_FILE
  if (file !== undefined && file !== '') {
    try {
      appendFileSync(file, text)
    } catch {
      // A bad seam path must not take the UI down.
    }
    return
  }
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= MAX_OSC52_BYTES) process.stdout.write(`\x1b]52;c;${bytes.toString('base64')}\x07`)
  if (process.platform === 'win32') pipeTo('clip', [], Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
  else if (process.platform === 'darwin') pipeTo('pbcopy', [], bytes)
  else if (process.env.WAYLAND_DISPLAY !== undefined) pipeTo('wl-copy', [], bytes)
  else pipeTo('xclip', ['-selection', 'clipboard'], bytes)
}

/** Read the system clipboard; '' when unavailable. Used when a terminal delivers Ctrl+V as a key instead of pasting. */
export function readClipboard(): Promise<string> {
  const [bin, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw']]
      : process.platform === 'darwin'
        ? ['pbpaste', []]
        : process.env.WAYLAND_DISPLAY !== undefined
          ? ['wl-paste', ['--no-newline']]
          : ['xclip', ['-selection', 'clipboard', '-o']]
  const { promise, resolve } = Promise.withResolvers<string>()
  try {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')))
  } catch {
    resolve('')
  }
  return promise
}
