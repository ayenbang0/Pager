/** Legacy terminals send Ctrl+H as the backspace byte 0x08, which Ink reports as plain Backspace; this tells the two apart. */
export const ctrlH = { pending: false }

/** Calls `onHome` for a chunk that is exactly one 0x08 byte, and marks it so Backspace handlers can ignore the same keypress. */
export function watchCtrlH(onHome: () => void): () => void {
  const onData = (chunk: Buffer | string): void => {
    if (String(chunk) !== '\x08') return
    ctrlH.pending = true
    setImmediate(() => {
      ctrlH.pending = false
    })
    onHome()
  }
  process.stdin.on('data', onData)
  return () => void process.stdin.off('data', onData)
}
