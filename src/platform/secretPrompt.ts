/** Pure edit step for a hidden prompt: feeds one stdin chunk into the text typed so far. */
export function applySecretInput(text: string, chunk: string): { text: string; done: boolean; cancelled: boolean } {
  let out = text
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') return { text: out, done: true, cancelled: false }
    if (ch === '\u0003' || ch === '\u0004') return { text: out, done: false, cancelled: true }
    if (ch === '\u007f' || ch === '\b') out = [...out].slice(0, -1).join('')
    else if (ch >= ' ' && ch !== '\u007f') out += ch
  }
  return { text: out, done: false, cancelled: false }
}

/** Reads a line from the terminal without echo. Ctrl+C exits with 130. */
export function promptSecret(question: string): Promise<string> {
  const stdin = process.stdin
  process.stdout.write(question)
  return new Promise((resolve) => {
    let text = ''
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const finish = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
      process.stdout.write('\n')
    }
    const onData = (chunk: string): void => {
      const r = applySecretInput(text, chunk)
      text = r.text
      if (r.cancelled) {
        finish()
        process.exit(130)
      }
      if (r.done) {
        finish()
        resolve(text)
      }
    }
    stdin.on('data', onData)
  })
}
