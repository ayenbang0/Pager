export interface ParsedArgs {
  command: 'run' | 'update' | 'lock' | 'unlock' | 'help' | 'version'
  lan: boolean
  lanTarget?: string
  noAgents: boolean
}

const TARGET = /^[^\s:]+:\d{1,5}$/

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = { command: 'run', lan: false, noAgents: false }
  if (argv[0] === 'update' || argv[0] === 'lock' || argv[0] === 'unlock') {
    return argv.length === 1 ? { ...out, command: argv[0] } : { error: `pager ${argv[0]} takes no arguments` }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-h' || a === '--help') return { ...out, command: 'help' }
    if (a === '-v' || a === '--version') return { ...out, command: 'version' }
    else if (a === '--no-agents') out.noAgents = true
    else if (a === '--lan') {
      out.lan = true
      const next = argv[i + 1]
      if (next !== undefined && TARGET.test(next)) {
        out.lanTarget = next
        i++
      }
    } else return { error: `unknown argument: ${a}` }
  }
  return out
}
