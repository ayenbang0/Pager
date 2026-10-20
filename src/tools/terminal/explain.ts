const TAIL = 6000

/** The message the AI tab receives for "explain this block": the command, how it ended, and the tail of its output. */
export function explainPrompt(b: { command: string; exit: number | null; cwd: string }, output: string): string {
  const tail = output.length > TAIL ? `…\n${output.slice(output.length - TAIL)}` : output
  return `Explain what this command did and, if it failed, the most likely cause and a fix. Be brief.\n\ncwd: ${b.cwd}\n$ ${b.command}\n(exit ${b.exit ?? 'running'})\n\n${tail}`
}
