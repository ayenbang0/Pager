import fs from 'node:fs'

const MAX_BYTES = 64 * 1024
const KEEP_BYTES = 32 * 1024
const FLUSH_MS = 250

/**
 * Append-only diagnostic log for link events. It runs beside the DHT handshake, so lines are buffered and written
 * asynchronously (a synchronous write there delayed connections). It must never break the app: every fs error is swallowed.
 */
export class NetLog {
  readonly file: string
  private pending = ''
  private timer: NodeJS.Timeout | undefined
  private writing = false

  constructor(file: string) {
    this.file = file
  }

  line = (event: string, pk: string, detail = ''): void => {
    this.pending += `${new Date().toISOString()} ${event} ${pk.slice(0, 8)} ${detail}`.trimEnd() + '\n'
    if (this.timer === undefined && !this.writing) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_MS)
      this.timer.unref()
    }
  }

  private async flush(): Promise<void> {
    this.timer = undefined
    this.writing = true
    const text = this.pending
    this.pending = ''
    try {
      await fs.promises.appendFile(this.file, text)
      if ((await fs.promises.stat(this.file)).size > MAX_BYTES) {
        const buf = await fs.promises.readFile(this.file)
        const tail = buf.subarray(buf.length - KEEP_BYTES)
        await fs.promises.writeFile(this.file, tail.subarray(tail.indexOf(10) + 1))
      }
    } catch {
      // diagnostics only
    }
    this.writing = false
    if (this.pending !== '') this.timer = setTimeout(() => void this.flush(), FLUSH_MS)
    this.timer?.unref()
  }
}
